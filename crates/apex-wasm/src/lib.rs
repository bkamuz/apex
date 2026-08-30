//! WASM façade over apex-core.
//!
//! Deliberately thin: it parses JSON, calls a `Project` method, and serializes
//! the scene back. There is no per-component function here, so adding a
//! component never touches this file.

use std::cell::RefCell;
use std::str::FromStr;

use apex_core::{
    ComponentDefinition, Element, ElementId, LevelId, ParamMap, PlacementKind, Project,
    SceneBuffers,
};
use glam::Vec3;
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

thread_local! {
    static PROJECT: RefCell<Option<Project>> = const { RefCell::new(None) };
}

fn with_project<R>(f: impl FnOnce(&mut Project) -> Result<R, JsValue>) -> Result<R, JsValue> {
    PROJECT.with(|cell| {
        let mut borrow = cell.borrow_mut();
        let project = borrow
            .as_mut()
            .ok_or_else(|| JsValue::from_str("Apex not initialized. Call initApp() first."))?;
        f(project)
    })
}

/// Serialize for JS.
///
/// Maps must become plain objects, not `Map`s: `ParamMap` is a map, and any
/// struct using `#[serde(flatten)]` (such as `ParamSpec`) is serialized as one
/// too. With the default setting those arrive in JS as `Map` instances and
/// every field reads back `undefined`.
fn to_js<T: Serialize>(value: &T) -> Result<JsValue, JsValue> {
    let serializer = serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true);
    value.serialize(&serializer).map_err(|e| err(e.to_string()))
}

fn err(message: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&message.to_string())
}

fn parse_json<T: for<'de> Deserialize<'de>>(label: &str, json: &str) -> Result<T, JsValue> {
    serde_json::from_str(json).map_err(|e| err(format!("invalid {label} JSON: {e}")))
}

/// Parameters are optional everywhere; an empty string means "no overrides".
fn parse_params(json: &str) -> Result<ParamMap, JsValue> {
    if json.trim().is_empty() {
        return Ok(ParamMap::new());
    }
    parse_json("params", json)
}

fn element_id(id: &str) -> Result<ElementId, JsValue> {
    ElementId::from_str(id).map_err(|e| err(format!("bad element id: {e}")))
}

fn level_id(id: &str) -> Result<LevelId, JsValue> {
    LevelId::from_str(id).map_err(|e| err(format!("bad level id: {e}")))
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

/// Selection lives in the façade: it is view state, not part of the document.
#[derive(Default)]
struct Selection(Vec<ElementId>);

impl Selection {
    fn set(&mut self, id: Option<ElementId>) {
        self.0.clear();
        if let Some(id) = id {
            self.0.push(id);
        }
    }

    fn toggle(&mut self, id: ElementId) {
        match self.0.iter().position(|x| *x == id) {
            Some(i) => {
                self.0.remove(i);
            }
            None => self.0.push(id),
        }
    }

    fn retain_existing(&mut self, project: &Project) {
        self.0
            .retain(|id| project.document().get_element(*id).is_some());
    }
}

thread_local! {
    static SELECTION: RefCell<Selection> = RefCell::new(Selection::default());
}

fn with_selection<R>(f: impl FnOnce(&mut Selection) -> R) -> R {
    SELECTION.with(|cell| f(&mut cell.borrow_mut()))
}

#[derive(Serialize)]
struct ElementDto {
    id: String,
    name: String,
    component_id: String,
    category: String,
    level_id: String,
    /// The picks that defined this element, so the UI can draw handles.
    anchors: Vec<[f32; 3]>,
    /// Length along the placement, when it has one.
    length: Option<f32>,
    /// Resolved parameter values, keyed by parameter id.
    params: ParamMap,
}

#[derive(Serialize)]
struct ElementListDto {
    id: String,
    name: String,
    component_id: String,
    category: String,
    pick_id: f64,
    level_id: String,
}

#[derive(Serialize)]
struct LevelDto {
    id: String,
    name: String,
    elevation: f32,
}

#[derive(Serialize)]
struct MeshDto {
    positions: Vec<f32>,
    normals: Vec<f32>,
    indices: Vec<u32>,
    edge_positions: Vec<f32>,
}

#[derive(Serialize)]
struct SceneDto {
    positions: Vec<f32>,
    normals: Vec<f32>,
    indices: Vec<u32>,
    /// Pick id per triangle.
    pick_ids: Vec<f64>,
    edge_positions: Vec<f32>,
    elements: Vec<ElementListDto>,
    levels: Vec<LevelDto>,
    active_level_id: Option<String>,
    version: u64,
    selected_ids: Vec<String>,
    selected_id: Option<String>,
}

fn element_dto(project: &Project, element: &Element) -> ElementDto {
    let category = project
        .registry()
        .get(&element.component_id)
        .map(|c| c.category.clone())
        .unwrap_or_default();
    // Show resolved values so the inspector never renders a blank field.
    let params = project
        .registry()
        .get(&element.component_id)
        .and_then(|c| c.resolve_params(&element.params).ok())
        .unwrap_or_else(|| element.params.clone());

    ElementDto {
        id: element.id.to_string(),
        name: element.name.clone(),
        component_id: element.component_id.clone(),
        category,
        level_id: element.level_id.to_string(),
        anchors: element
            .placement
            .anchors()
            .iter()
            .map(|p| p.to_array())
            .collect(),
        length: element.placement.length(),
        params,
    }
}

fn sorted_levels(project: &Project) -> Vec<LevelDto> {
    let mut levels: Vec<_> = project
        .document()
        .levels()
        .map(|l| LevelDto {
            id: l.id.to_string(),
            name: l.name.clone(),
            elevation: l.elevation,
        })
        .collect();
    levels.sort_by(|a, b| {
        a.elevation
            .partial_cmp(&b.elevation)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.name.cmp(&b.name))
    });
    levels
}

fn scene_dto(project: &Project) -> SceneDto {
    let buffers: SceneBuffers = project.document().build_scene_buffers();
    let selected_ids = with_selection(|s| s.0.iter().map(|id| id.to_string()).collect::<Vec<_>>());

    SceneDto {
        positions: buffers.positions,
        normals: buffers.normals,
        indices: buffers.indices,
        pick_ids: buffers.pick_ids.iter().map(|id| *id as f64).collect(),
        edge_positions: buffers.edge_positions,
        elements: buffers
            .elements
            .iter()
            .map(|e| ElementListDto {
                id: e.id.to_string(),
                name: e.name.clone(),
                component_id: e.component_id.clone(),
                category: project
                    .registry()
                    .get(&e.component_id)
                    .map(|c| c.category.clone())
                    .unwrap_or_default(),
                pick_id: e.pick_id as f64,
                level_id: e.level_id.to_string(),
            })
            .collect(),
        levels: sorted_levels(project),
        active_level_id: project
            .document()
            .active_level_id()
            .map(|id| id.to_string()),
        version: buffers.version,
        selected_id: selected_ids.first().cloned(),
        selected_ids,
    }
}

fn scene(project: &Project) -> Result<JsValue, JsValue> {
    to_js(&scene_dto(project))
}

fn points_from_json(json: &str) -> Result<Vec<Vec3>, JsValue> {
    let raw: Vec<[f32; 3]> = parse_json("points", json)?;
    Ok(raw.into_iter().map(Vec3::from_array).collect())
}

fn parse_placement_kind(name: &str) -> Result<Option<PlacementKind>, JsValue> {
    let name = name.trim();
    if name.is_empty() {
        return Ok(None);
    }
    PlacementKind::from_name(name)
        .map(Some)
        .ok_or_else(|| err(format!("unknown placement kind '{name}'")))
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/// Initialize the panic hook and an empty project with Level 0.
#[wasm_bindgen(js_name = initApp)]
pub fn init_app() -> Result<(), JsValue> {
    console_error_panic_hook::set_once();
    PROJECT.with(|cell| *cell.borrow_mut() = Some(Project::new()));
    with_selection(|s| s.set(None));
    Ok(())
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/// Every installed component. The UI builds its toolbar and inspector from this.
#[wasm_bindgen(js_name = listComponents)]
pub fn list_components() -> Result<JsValue, JsValue> {
    with_project(|project| {
        let list: Vec<_> = project.registry().components().cloned().collect();
        to_js(&list)
    })
}

/// Install a component at runtime, from a module or the visual editor.
#[wasm_bindgen(js_name = registerComponent)]
pub fn register_component(definition_json: &str) -> Result<JsValue, JsValue> {
    with_project(|project| {
        let definition: ComponentDefinition = parse_json("component", definition_json)?;
        project.register_component(definition).map_err(err)?;
        scene(project)
    })
}

// ---------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------

/// Place a component from the raw picks the user made.
///
/// The component's own `PlacementKind` decides how the points are interpreted
/// unless `placement_kind` names a more specific gesture. A path component
/// (wall) uses that override so line, arc and polyline share one type.
#[wasm_bindgen(js_name = createElement)]
pub fn create_element(
    component_id: &str,
    points_json: &str,
    rotation: f32,
    params_json: &str,
    placement_kind: &str,
) -> Result<JsValue, JsValue> {
    with_project(|project| {
        let points = points_from_json(points_json)?;
        let params = parse_params(params_json)?;
        let kind = parse_placement_kind(placement_kind)?;
        let placement = project
            .placement_from_gesture(component_id, kind, &points, rotation)
            .map_err(err)?;
        let id = project
            .create_element(component_id, placement, params)
            .map_err(err)?;
        with_selection(|s| s.set(Some(id)));
        scene(project)
    })
}

/// Patch an element's parameters. Omitted parameters keep their current value.
#[wasm_bindgen(js_name = updateElement)]
pub fn update_element(id: &str, params_json: &str) -> Result<JsValue, JsValue> {
    with_project(|project| {
        let element = element_id(id)?;
        let params = parse_params(params_json)?;
        project
            .update_element(element, Some(params), None)
            .map_err(err)?;
        scene(project)
    })
}

/// Re-place an existing element from a fresh set of picks.
///
/// The existing curve type is kept, so dragging an arc wall's handles does
/// not turn it into a polyline.
#[wasm_bindgen(js_name = setElementPlacement)]
pub fn set_element_placement(
    id: &str,
    points_json: &str,
    rotation: f32,
) -> Result<JsValue, JsValue> {
    with_project(|project| {
        let element = element_id(id)?;
        let (component_id, kind) = {
            let existing = project
                .document()
                .get_element(element)
                .ok_or_else(|| err("Element not found"))?;
            (
                existing.component_id.clone(),
                existing.placement.source_kind(),
            )
        };

        let points = points_from_json(points_json)?;
        let placement = project
            .placement_from_gesture(&component_id, Some(kind), &points, rotation)
            .map_err(err)?;
        project
            .update_element(element, None, Some(placement))
            .map_err(err)?;
        scene(project)
    })
}

/// Geometry for a placement that has not been committed yet.
///
/// The preview and the real element come from the same recipe, so a ghost can
/// never drift from what actually gets placed. `placement_kind` is the same
/// optional override `createElement` takes.
#[wasm_bindgen(js_name = previewElement)]
pub fn preview_element(
    component_id: &str,
    points_json: &str,
    rotation: f32,
    params_json: &str,
    placement_kind: &str,
) -> Result<JsValue, JsValue> {
    with_project(|project| {
        let points = points_from_json(points_json)?;
        let params = parse_params(params_json)?;
        let kind = parse_placement_kind(placement_kind)?;
        let placement = project
            .placement_from_gesture(component_id, kind, &points, rotation)
            .map_err(err)?;
        // Previews follow the active work plane, like a real placement would.
        let elevation = project.active_work_plane().origin.y;
        let placement = placement.with_elevation(elevation);

        let mesh = project
            .preview(component_id, &placement, &params)
            .map_err(err)?;
        to_js(&MeshDto {
            positions: mesh.positions,
            normals: mesh.normals,
            indices: mesh.indices,
            edge_positions: mesh.edges,
        })
    })
}

/// Delete every selected element.
#[wasm_bindgen(js_name = deleteSelected)]
pub fn delete_selected() -> Result<JsValue, JsValue> {
    with_project(|project| {
        let ids = with_selection(|s| std::mem::take(&mut s.0));
        for id in ids {
            project.delete_element(id);
        }
        scene(project)
    })
}

/// Details of the single selected element, or null.
#[wasm_bindgen(js_name = getSelected)]
pub fn get_selected() -> Result<JsValue, JsValue> {
    with_project(|project| {
        let selected = with_selection(|s| s.0.clone());
        if selected.len() != 1 {
            return Ok(JsValue::NULL);
        }
        match project.document().get_element(selected[0]) {
            Some(element) => to_js(&element_dto(project, element)),
            None => Ok(JsValue::NULL),
        }
    })
}

/// Every element in the document.
#[wasm_bindgen(js_name = listElements)]
pub fn list_elements() -> Result<JsValue, JsValue> {
    with_project(|project| {
        let mut list: Vec<_> = project
            .document()
            .elements()
            .map(|e| element_dto(project, e))
            .collect();
        list.sort_by(|a, b| a.name.cmp(&b.name));
        to_js(&list)
    })
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

#[wasm_bindgen(js_name = selectElement)]
pub fn select_element(id: &str) -> Result<JsValue, JsValue> {
    with_project(|project| {
        if id.is_empty() {
            with_selection(|s| s.set(None));
        } else {
            let element = element_id(id)?;
            if project.document().get_element(element).is_none() {
                return Err(err("Element not found"));
            }
            with_selection(|s| s.set(Some(element)));
        }
        scene(project)
    })
}

#[wasm_bindgen(js_name = toggleSelectElement)]
pub fn toggle_select_element(id: &str) -> Result<JsValue, JsValue> {
    with_project(|project| {
        let element = element_id(id)?;
        if project.document().get_element(element).is_none() {
            return Err(err("Element not found"));
        }
        with_selection(|s| s.toggle(element));
        scene(project)
    })
}

/// Resolve a GPU pick id to an element and replace the selection.
#[wasm_bindgen(js_name = pickById)]
pub fn pick_by_id(pick_id: f64) -> Result<JsValue, JsValue> {
    with_project(|project| {
        let found = find_by_pick_id(project, pick_id);
        with_selection(|s| s.set(found));
        scene(project)
    })
}

#[wasm_bindgen(js_name = togglePickById)]
pub fn toggle_pick_by_id(pick_id: f64) -> Result<JsValue, JsValue> {
    with_project(|project| {
        if let Some(id) = find_by_pick_id(project, pick_id) {
            with_selection(|s| s.toggle(id));
        }
        scene(project)
    })
}

fn find_by_pick_id(project: &Project, pick_id: f64) -> Option<ElementId> {
    let target = pick_id as u64;
    project
        .document()
        .build_scene_buffers()
        .elements
        .iter()
        .find(|e| e.pick_id == target)
        .map(|e| e.id)
}

// ---------------------------------------------------------------------------
// Scene and levels
// ---------------------------------------------------------------------------

#[wasm_bindgen(js_name = getScene)]
pub fn get_scene() -> Result<JsValue, JsValue> {
    with_project(|project| {
        with_selection(|s| s.retain_existing(project));
        scene(project)
    })
}

#[wasm_bindgen(js_name = createLevel)]
pub fn create_level(name: &str, elevation: f32) -> Result<JsValue, JsValue> {
    with_project(|project| {
        project.add_level(name, elevation);
        scene(project)
    })
}

#[wasm_bindgen(js_name = setActiveLevel)]
pub fn set_active_level(id: &str) -> Result<JsValue, JsValue> {
    with_project(|project| {
        let level = level_id(id)?;
        project
            .document_mut()
            .set_active_level(level)
            .map_err(err)?;
        scene(project)
    })
}

#[wasm_bindgen(js_name = setLevelElevation)]
pub fn set_level_elevation(id: &str, elevation: f32) -> Result<JsValue, JsValue> {
    with_project(|project| {
        let level = level_id(id)?;
        project.set_level_elevation(level, elevation).map_err(err)?;
        scene(project)
    })
}
