//! WASM façade over apex-core + apex-geometry.

use std::cell::RefCell;
use std::str::FromStr;

use apex_core::{Document, Element, ElementId, LevelId, SceneBuffers, WallParams};
use apex_geometry::generate_wall_mesh;
use serde::Serialize;
use wasm_bindgen::prelude::*;

thread_local! {
    static APP: RefCell<Option<ApexApp>> = const { RefCell::new(None) };
}

struct ApexApp {
    document: Document,
    wall_counter: u32,
    level_counter: u32,
    /// Selection order; empty = nothing selected.
    selected: Vec<ElementId>,
}

#[derive(Serialize)]
struct ElementDto {
    id: String,
    name: String,
    category: String,
    level_id: String,
    length: Option<f32>,
    height: Option<f32>,
    thickness: Option<f32>,
    start: Option<[f32; 3]>,
    end: Option<[f32; 3]>,
}

#[derive(Serialize)]
struct LevelDto {
    id: String,
    name: String,
    elevation: f32,
}

#[derive(Serialize)]
struct SceneDto {
    positions: Vec<f32>,
    normals: Vec<f32>,
    indices: Vec<u32>,
    /// Pick id per triangle.
    pick_ids: Vec<f64>,
    /// CAD edge segments: consecutive xyz pairs.
    edge_positions: Vec<f32>,
    elements: Vec<ElementListDto>,
    levels: Vec<LevelDto>,
    active_level_id: Option<String>,
    version: u64,
    /// All selected element ids (selection order).
    selected_ids: Vec<String>,
    /// First selected id (compat / primary); null when empty.
    selected_id: Option<String>,
}

#[derive(Serialize)]
struct ElementListDto {
    id: String,
    name: String,
    category: String,
    pick_id: f64,
    level_id: String,
}

fn with_app<R>(f: impl FnOnce(&mut ApexApp) -> Result<R, JsValue>) -> Result<R, JsValue> {
    APP.with(|cell| {
        let mut borrow = cell.borrow_mut();
        let app = borrow
            .as_mut()
            .ok_or_else(|| JsValue::from_str("Apex not initialized. Call init() first."))?;
        f(app)
    })
}

fn to_js<T: Serialize>(value: &T) -> Result<JsValue, JsValue> {
    serde_wasm_bindgen::to_value(value).map_err(|e| JsValue::from_str(&e.to_string()))
}

fn element_dto(el: &Element) -> ElementDto {
    let (length, height, thickness, start, end) = match &el.wall {
        Some(w) => (
            Some(w.length()),
            Some(w.height),
            Some(w.thickness),
            Some(w.start),
            Some(w.end),
        ),
        None => (None, None, None, None, None),
    };
    ElementDto {
        id: el.id.to_string(),
        name: el.name.clone(),
        category: el.category.as_str().to_string(),
        level_id: el.level_id.to_string(),
        length,
        height,
        thickness,
        start,
        end,
    }
}

fn sorted_levels(doc: &Document) -> Vec<LevelDto> {
    let mut levels: Vec<_> = doc
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

fn scene_dto(doc: &Document, selected: &[ElementId]) -> SceneDto {
    let buffers: SceneBuffers = doc.build_scene_buffers();
    let selected_ids: Vec<String> = selected.iter().map(|id| id.to_string()).collect();
    let selected_id = selected_ids.first().cloned();
    let level_by_id: std::collections::HashMap<_, _> = buffers
        .elements
        .iter()
        .filter_map(|e| {
            doc.get_element(e.id)
                .map(|el| (e.id, el.level_id.to_string()))
        })
        .collect();
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
                category: e.category.clone(),
                pick_id: e.pick_id as f64,
                level_id: level_by_id
                    .get(&e.id)
                    .cloned()
                    .unwrap_or_default(),
            })
            .collect(),
        levels: sorted_levels(doc),
        active_level_id: doc.active_level_id().map(|id| id.to_string()),
        version: buffers.version,
        selected_ids,
        selected_id,
    }
}

fn set_selection(app: &mut ApexApp, id: Option<ElementId>) {
    app.selected.clear();
    if let Some(id) = id {
        app.selected.push(id);
    }
}

fn toggle_selection(app: &mut ApexApp, id: ElementId) {
    if let Some(i) = app.selected.iter().position(|x| *x == id) {
        app.selected.remove(i);
    } else {
        app.selected.push(id);
    }
}

fn remesh_wall(app: &mut ApexApp, element_id: ElementId) -> Result<(), JsValue> {
    let mut element = app
        .document
        .get_element(element_id)
        .cloned()
        .ok_or_else(|| JsValue::from_str("Element not found"))?;
    let wall = element
        .wall
        .clone()
        .ok_or_else(|| JsValue::from_str("Element is not a wall"))?;
    let mesh = generate_wall_mesh(&wall).map_err(|e| JsValue::from_str(&e.to_string()))?;
    element.wall = Some(wall);
    app.document.update_element(element, mesh);
    Ok(())
}

/// Initialize panic hook and empty document with Level 0.
#[wasm_bindgen(js_name = initApp)]
pub fn init_app() -> Result<(), JsValue> {
    console_error_panic_hook::set_once();
    APP.with(|cell| {
        *cell.borrow_mut() = Some(ApexApp {
            document: Document::new(),
            wall_counter: 0,
            level_counter: 0,
            selected: Vec::new(),
        });
    });
    Ok(())
}

/// Create a wall from two points on the active level. Returns updated scene JSON.
#[wasm_bindgen(js_name = createWall)]
pub fn create_wall(
    x0: f32,
    y0: f32,
    z0: f32,
    x1: f32,
    y1: f32,
    z1: f32,
    height: f32,
    thickness: f32,
) -> Result<JsValue, JsValue> {
    with_app(|app| {
        let level_id = app
            .document
            .active_level_id()
            .ok_or_else(|| JsValue::from_str("No active level"))?;
        let elevation = app
            .document
            .get_level(level_id)
            .map(|l| l.elevation)
            .unwrap_or(0.0);
        let _ = (y0, y1);

        let wall = WallParams {
            start: [x0, elevation, z0],
            end: [x1, elevation, z1],
            height,
            thickness,
        };

        let mesh = generate_wall_mesh(&wall).map_err(|e| JsValue::from_str(&e.to_string()))?;

        app.wall_counter += 1;
        let name = format!("Wall {}", app.wall_counter);
        let element = Element::wall(name, level_id, wall);
        let id = element.id;
        app.document.upsert_element(element, mesh);
        set_selection(app, Some(id));

        to_js(&scene_dto(&app.document, &app.selected))
    })
}

/// Update wall parameters by element id. Returns updated scene.
#[wasm_bindgen(js_name = setWallParams)]
pub fn set_wall_params(
    id: &str,
    height: f32,
    thickness: f32,
    x0: f32,
    y0: f32,
    z0: f32,
    x1: f32,
    y1: f32,
    z1: f32,
) -> Result<JsValue, JsValue> {
    with_app(|app| {
        let element_id = ElementId::from_str(id).map_err(|e| JsValue::from_str(&e.to_string()))?;
        let mut element = app
            .document
            .get_element(element_id)
            .cloned()
            .ok_or_else(|| JsValue::from_str("Element not found"))?;

        let elevation = app
            .document
            .get_level(element.level_id)
            .map(|l| l.elevation)
            .unwrap_or(y0.min(y1));

        let wall = WallParams {
            start: [x0, elevation, z0],
            end: [x1, elevation, z1],
            height,
            thickness,
        };
        let mesh = generate_wall_mesh(&wall).map_err(|e| JsValue::from_str(&e.to_string()))?;
        element.wall = Some(wall);
        app.document.update_element(element, mesh);
        // Keep multi-selection if this wall was already selected; otherwise select only it.
        if !app.selected.iter().any(|x| *x == element_id) {
            set_selection(app, Some(element_id));
        }
        to_js(&scene_dto(&app.document, &app.selected))
    })
}

/// Create a new level. Empty name → auto "Level N". Returns updated scene.
#[wasm_bindgen(js_name = createLevel)]
pub fn create_level(name: &str, elevation: f32) -> Result<JsValue, JsValue> {
    with_app(|app| {
        app.level_counter += 1;
        let label = if name.trim().is_empty() {
            format!("Level {}", app.level_counter)
        } else {
            name.trim().to_string()
        };
        let (_id, _) = app.document.add_level(label, elevation);
        // Activation is explicit (double-click contour / setActiveLevel).
        to_js(&scene_dto(&app.document, &app.selected))
    })
}

/// Activate a level as the current work plane.
#[wasm_bindgen(js_name = setActiveLevel)]
pub fn set_active_level(id: &str) -> Result<JsValue, JsValue> {
    with_app(|app| {
        let level_id = LevelId::from_str(id).map_err(|e| JsValue::from_str(&e.to_string()))?;
        app.document
            .set_active_level(level_id)
            .map_err(|e| JsValue::from_str(&e))?;
        to_js(&scene_dto(&app.document, &app.selected))
    })
}

/// Change a level's elevation; walls on that level move with it.
#[wasm_bindgen(js_name = setLevelElevation)]
pub fn set_level_elevation(id: &str, elevation: f32) -> Result<JsValue, JsValue> {
    with_app(|app| {
        let level_id = LevelId::from_str(id).map_err(|e| JsValue::from_str(&e.to_string()))?;
        let (_change, moved) = app
            .document
            .set_level_elevation(level_id, elevation)
            .map_err(|e| JsValue::from_str(&e))?;
        for element_id in moved {
            remesh_wall(app, element_id)?;
        }
        to_js(&scene_dto(&app.document, &app.selected))
    })
}

/// Replace selection with one element (or clear with empty string).
#[wasm_bindgen(js_name = selectElement)]
pub fn select_element(id: &str) -> Result<JsValue, JsValue> {
    with_app(|app| {
        if id.is_empty() {
            app.selected.clear();
        } else {
            let element_id =
                ElementId::from_str(id).map_err(|e| JsValue::from_str(&e.to_string()))?;
            if app.document.get_element(element_id).is_none() {
                return Err(JsValue::from_str("Element not found"));
            }
            set_selection(app, Some(element_id));
        }
        to_js(&scene_dto(&app.document, &app.selected))
    })
}

/// Toggle one element in/out of the selection (Ctrl/Cmd multi-select).
#[wasm_bindgen(js_name = toggleSelectElement)]
pub fn toggle_select_element(id: &str) -> Result<JsValue, JsValue> {
    with_app(|app| {
        let element_id = ElementId::from_str(id).map_err(|e| JsValue::from_str(&e.to_string()))?;
        if app.document.get_element(element_id).is_none() {
            return Err(JsValue::from_str("Element not found"));
        }
        toggle_selection(app, element_id);
        to_js(&scene_dto(&app.document, &app.selected))
    })
}

/// Pick by GPU pick id (1-based sequential). Replaces selection.
#[wasm_bindgen(js_name = pickById)]
pub fn pick_by_id(pick_id: f64) -> Result<JsValue, JsValue> {
    with_app(|app| {
        let target = pick_id as u64;
        let buffers = app.document.build_scene_buffers();
        let found = buffers
            .elements
            .iter()
            .find(|e| e.pick_id == target)
            .map(|e| e.id);

        set_selection(app, found);
        to_js(&scene_dto(&app.document, &app.selected))
    })
}

/// Toggle selection by GPU pick id (Ctrl/Cmd+click).
#[wasm_bindgen(js_name = togglePickById)]
pub fn toggle_pick_by_id(pick_id: f64) -> Result<JsValue, JsValue> {
    with_app(|app| {
        let target = pick_id as u64;
        let buffers = app.document.build_scene_buffers();
        let found = buffers
            .elements
            .iter()
            .find(|e| e.pick_id == target)
            .map(|e| e.id);

        if let Some(id) = found {
            toggle_selection(app, id);
        }
        to_js(&scene_dto(&app.document, &app.selected))
    })
}

/// Full scene buffers for the viewport.
#[wasm_bindgen(js_name = getScene)]
pub fn get_scene() -> Result<JsValue, JsValue> {
    with_app(|app| to_js(&scene_dto(&app.document, &app.selected)))
}

/// Selected element details when exactly one is selected (otherwise null).
#[wasm_bindgen(js_name = getSelected)]
pub fn get_selected() -> Result<JsValue, JsValue> {
    with_app(|app| {
        if app.selected.len() != 1 {
            return Ok(JsValue::NULL);
        }
        let id = app.selected[0];
        let el = app
            .document
            .get_element(id)
            .ok_or_else(|| JsValue::from_str("Selected element missing"))?;
        to_js(&element_dto(el))
    })
}

/// List all elements.
#[wasm_bindgen(js_name = listElements)]
pub fn list_elements() -> Result<JsValue, JsValue> {
    with_app(|app| {
        let mut list: Vec<_> = app.document.elements().map(element_dto).collect();
        list.sort_by(|a, b| a.name.cmp(&b.name));
        to_js(&list)
    })
}

/// Delete all selected elements.
#[wasm_bindgen(js_name = deleteSelected)]
pub fn delete_selected() -> Result<JsValue, JsValue> {
    with_app(|app| {
        let ids: Vec<ElementId> = app.selected.drain(..).collect();
        for id in ids {
            app.document.remove_element(id);
        }
        to_js(&scene_dto(&app.document, &app.selected))
    })
}
