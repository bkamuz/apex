//! WASM façade over apex-core.
//!
//! Deliberately thin: it parses JSON, calls a `Project` method, and serializes
//! the scene back. There is no per-component function here, so adding a
//! component never touches this file.

use std::cell::RefCell;
use std::str::FromStr;

use apex_core::{
    construction_line_param_specs, grid_axis_param_specs, section_cut_param_specs,
    space_param_specs, ComponentDefinition, ComponentRegistry, ConstructionLine,
    ConstructionLineId, Element, ElementId, GridAxis, GridAxisId, LevelId, PaperOrientation,
    PaperSize, ParamKind, ParamMap, ParamSpec, PlacementKind, ProfileSpec, ProfileType, Project,
    ProjectSnapshot, RefId, Reference, ReferenceKind, SceneBuffers, SectionCut, SectionCutId,
    Sheet, SheetId, Space, SpaceId, View, ViewAnnotation, ViewAnnotationId, ViewAnnotationKind,
    ViewId, ViewKind, ViewSettings,
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
    static SELECTED_REF: RefCell<Option<RefId>> = const { RefCell::new(None) };
    static SELECTED_GRID_AXIS: RefCell<Option<GridAxisId>> = const { RefCell::new(None) };
    static SELECTED_CONSTRUCTION_LINE: RefCell<Option<ConstructionLineId>> =
        const { RefCell::new(None) };
    static SELECTED_SECTION_CUT: RefCell<Option<SectionCutId>> = const { RefCell::new(None) };
    static SELECTED_SPACE: RefCell<Option<SpaceId>> = const { RefCell::new(None) };
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
    /// The element's own level.
    level_id: String,
    /// The level it actually sits on, following parent inheritance. Differs from
    /// `level_id` when the element has a parent on another level.
    effective_level_id: String,
    /// The element this one is attached to, if any.
    parent_id: Option<String>,
    /// Direct children, so the UI can draw the tree without a second call.
    child_ids: Vec<String>,
    /// The picks that defined this element, so the UI can draw handles.
    anchors: Vec<[f32; 3]>,
    /// Length along the placement, when it has one.
    length: Option<f32>,
    /// Resolved instance values (component + profile instance), keyed by id.
    params: ParamMap,
    /// Selected profile type, when this component has a profile parameter.
    profile_id: Option<String>,
    /// Resolved type-level values of that profile. Inspector must not write these
    /// through `updateElement`.
    type_values: ParamMap,
    /// Path-join sweep extensions (metres). Zero when not joined.
    join_start: f32,
    join_end: f32,
}

#[derive(Serialize)]
struct ElementListDto {
    id: String,
    name: String,
    component_id: String,
    category: String,
    pick_id: f64,
    level_id: String,
    effective_level_id: String,
    parent_id: Option<String>,
    profile_id: Option<String>,
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
struct ReferenceDto {
    id: String,
    name: String,
    kind: String,
    level_id: String,
    anchors: Vec<[f32; 3]>,
    gizmo_segments: Vec<[f32; 3]>,
    origin: [f32; 3],
    normal: [f32; 3],
    offset: f32,
}

#[derive(Debug, Clone, Copy, Serialize)]
struct RoomDetectReportDto {
    created: usize,
    loops_found: usize,
}

thread_local! {
    static ROOM_DETECT_REPORT: std::cell::RefCell<Option<RoomDetectReportDto>> =
        const { std::cell::RefCell::new(None) };
}

#[derive(Serialize)]
struct GridAxisLabelDto {
    position: [f32; 3],
    text: String,
}

#[derive(Serialize)]
struct GridAxisDto {
    id: String,
    name: String,
    level_id: String,
    anchors: Vec<[f32; 3]>,
    line_segments: Vec<[f32; 3]>,
    bubble_segments: Vec<[f32; 3]>,
    labels: Vec<GridAxisLabelDto>,
    params: ParamMap,
    param_specs: Vec<ParamSpec>,
}

#[derive(Serialize)]
struct AnnotationLabelDto {
    position: [f32; 3],
    text: String,
}

#[derive(Serialize)]
struct ConstructionLineDto {
    id: String,
    name: String,
    level_id: String,
    anchors: Vec<[f32; 3]>,
    line_segments: Vec<[f32; 3]>,
    labels: Vec<AnnotationLabelDto>,
    params: ParamMap,
    param_specs: Vec<ParamSpec>,
}

#[derive(Serialize)]
struct SectionCutDto {
    id: String,
    name: String,
    level_id: String,
    anchors: Vec<[f32; 3]>,
    line_segments: Vec<[f32; 3]>,
    fill_segments: Vec<[f32; 3]>,
    labels: Vec<AnnotationLabelDto>,
    params: ParamMap,
    param_specs: Vec<ParamSpec>,
}

#[derive(Serialize)]
struct SpaceDto {
    id: String,
    name: String,
    level_id: String,
    anchors: Vec<[f32; 3]>,
    line_segments: Vec<[f32; 3]>,
    labels: Vec<AnnotationLabelDto>,
    params: ParamMap,
    param_specs: Vec<ParamSpec>,
}

#[derive(Serialize)]
struct ViewDto {
    id: String,
    name: String,
    kind: ViewKind,
    settings: ViewSettings,
    type_label: String,
}

#[derive(Serialize)]
struct SheetViewportDto {
    id: String,
    view_id: String,
    center_x_mm: f32,
    center_y_mm: f32,
    width_mm: f32,
    height_mm: f32,
    anchor_x_m: f32,
    anchor_z_m: f32,
    camera: Option<apex_core::StoredCamera>,
    lock_navigation: bool,
    crop_polygon: Vec<[f32; 2]>,
}

#[derive(Serialize)]
struct ViewAnnotationDto {
    id: String,
    view_id: String,
    category: String,
    kind: ViewAnnotationKind,
    line_segments: Vec<[f32; 3]>,
    labels: Vec<AnnotationLabelDto>,
}

#[derive(Serialize)]
struct SheetDto {
    id: String,
    number: String,
    name: String,
    paper: PaperSize,
    orientation: PaperOrientation,
    custom_width_mm: f32,
    custom_height_mm: f32,
    width_mm: f32,
    height_mm: f32,
    viewports: Vec<SheetViewportDto>,
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
    references: Vec<ReferenceDto>,
    grid_axes: Vec<GridAxisDto>,
    construction_lines: Vec<ConstructionLineDto>,
    section_cuts: Vec<SectionCutDto>,
    spaces: Vec<SpaceDto>,
    views: Vec<ViewDto>,
    sheets: Vec<SheetDto>,
    view_annotations: Vec<ViewAnnotationDto>,
    /// Door swing / window glazing segment pairs for the active level's plan.
    plan_symbols: Vec<[f32; 3]>,
    levels: Vec<LevelDto>,
    active_level_id: Option<String>,
    fit_bounds_min: Option<[f32; 3]>,
    fit_bounds_max: Option<[f32; 3]>,
    room_detect_report: Option<RoomDetectReportDto>,
    version: u64,
    selected_ids: Vec<String>,
    selected_id: Option<String>,
    selected_ref_id: Option<String>,
    selected_grid_axis_id: Option<String>,
    selected_construction_line_id: Option<String>,
    selected_section_cut_id: Option<String>,
    selected_space_id: Option<String>,
    can_undo: bool,
    can_redo: bool,
}

fn element_dto(project: &Project, element: &Element) -> ElementDto {
    let category = project
        .registry()
        .get(&element.component_id)
        .map(|c| c.category.clone())
        .unwrap_or_default();
    // Instance values only, with defaults filled so the inspector is never blank.
    let params = project
        .registry()
        .persistable_params(&element.component_id, &element.params)
        .unwrap_or_else(|_| element.params.clone());
    let profile_id = project.registry().element_profile_id(element);
    let type_values = profile_id
        .as_ref()
        .and_then(|id| project.registry().profile(id))
        .and_then(|profile| profile.resolve_type_values().ok())
        .unwrap_or_default();

    let effective_level_id = project
        .effective_level_id(element.id)
        .unwrap_or(element.level_id);

    ElementDto {
        id: element.id.to_string(),
        name: element.name.clone(),
        component_id: element.component_id.clone(),
        category,
        level_id: element.level_id.to_string(),
        effective_level_id: effective_level_id.to_string(),
        parent_id: element.parent_id.map(|id| id.to_string()),
        child_ids: project
            .children_of(element.id)
            .into_iter()
            .map(|id| id.to_string())
            .collect(),
        anchors: element
            .placement
            .anchors()
            .iter()
            .map(|p| p.to_array())
            .collect(),
        length: element.placement.length(),
        params,
        profile_id,
        type_values,
        join_start: element.join_start,
        join_end: element.join_end,
    }
}

fn grid_axis_dto(project: &Project, axis: &GridAxis) -> GridAxisDto {
    let work_plane = project.work_plane(axis.level_id);
    let overlay = axis.overlay_geometry(&work_plane).unwrap_or_default();
    let params = axis.resolved_params();
    GridAxisDto {
        id: axis.id.to_string(),
        name: axis.name.clone(),
        level_id: axis.level_id.to_string(),
        anchors: axis
            .placement
            .anchors()
            .into_iter()
            .map(|p| p.to_array())
            .collect(),
        line_segments: overlay
            .line_segments
            .into_iter()
            .map(|p| p.to_array())
            .collect(),
        bubble_segments: overlay
            .bubble_segments
            .into_iter()
            .map(|p| p.to_array())
            .collect(),
        labels: overlay
            .labels
            .into_iter()
            .map(|label| GridAxisLabelDto {
                position: label.position.to_array(),
                text: label.text,
            })
            .collect(),
        params,
        param_specs: grid_axis_param_specs(),
    }
}

fn construction_line_dto(project: &Project, line: &ConstructionLine) -> ConstructionLineDto {
    let work_plane = project.work_plane(line.level_id);
    let overlay = line.overlay_geometry(&work_plane).unwrap_or_default();
    let params = line.resolved_params();
    ConstructionLineDto {
        id: line.id.to_string(),
        name: line.name.clone(),
        level_id: line.level_id.to_string(),
        anchors: line
            .placement
            .anchors()
            .into_iter()
            .map(|p| p.to_array())
            .collect(),
        line_segments: overlay
            .line_segments
            .into_iter()
            .map(|p| p.to_array())
            .collect(),
        labels: overlay
            .labels
            .into_iter()
            .map(|label| AnnotationLabelDto {
                position: label.position.to_array(),
                text: label.text,
            })
            .collect(),
        params,
        param_specs: construction_line_param_specs(),
    }
}

fn section_cut_dto(project: &Project, cut: &SectionCut) -> SectionCutDto {
    let work_plane = project.work_plane(cut.level_id);
    let overlay = cut.overlay_geometry(&work_plane).unwrap_or_default();
    let params = cut.resolved_params();
    SectionCutDto {
        id: cut.id.to_string(),
        name: cut.name.clone(),
        level_id: cut.level_id.to_string(),
        anchors: cut
            .placement
            .anchors()
            .into_iter()
            .map(|p| p.to_array())
            .collect(),
        line_segments: overlay
            .line_segments
            .into_iter()
            .map(|p| p.to_array())
            .collect(),
        fill_segments: overlay
            .fill_segments
            .into_iter()
            .map(|p| p.to_array())
            .collect(),
        labels: overlay
            .labels
            .into_iter()
            .map(|label| AnnotationLabelDto {
                position: label.position.to_array(),
                text: label.text,
            })
            .collect(),
        params,
        param_specs: section_cut_param_specs(),
    }
}

fn space_dto(project: &Project, space: &Space) -> SpaceDto {
    let overlay = project.space_overlay(space);
    let params = space.resolved_params();
    SpaceDto {
        id: space.id.to_string(),
        name: space.name.clone(),
        level_id: space.level_id.to_string(),
        anchors: space
            .placement
            .anchors()
            .into_iter()
            .map(|p| p.to_array())
            .collect(),
        line_segments: overlay
            .line_segments
            .into_iter()
            .map(|p| p.to_array())
            .collect(),
        labels: overlay
            .labels
            .into_iter()
            .map(|label| AnnotationLabelDto {
                position: label.position.to_array(),
                text: label.text,
            })
            .collect(),
        params,
        param_specs: space_param_specs(),
    }
}

fn reference_dto(project: &Project, reference: &Reference) -> ReferenceDto {
    let work_plane = project.work_plane(reference.level_id);
    let gizmo_segments = reference
        .gizmo_segments(&work_plane)
        .unwrap_or_default()
        .into_iter()
        .map(|p| p.to_array())
        .collect();
    let frame = reference.frame(&work_plane).unwrap_or(work_plane);
    let origin = frame.origin.to_array();
    let normal = frame.z.to_array();
    let offset = frame.origin.dot(frame.z);
    ReferenceDto {
        id: reference.id.to_string(),
        name: reference.name.clone(),
        kind: reference.kind.as_str().to_string(),
        level_id: reference.level_id.to_string(),
        anchors: reference
            .placement
            .anchors()
            .into_iter()
            .map(|p| p.to_array())
            .collect(),
        gizmo_segments,
        origin,
        normal,
        offset,
    }
}

/// Fill empty option lists from the document (profiles by category, refs by filter).
fn with_dynamic_options(
    project: &Project,
    mut definition: ComponentDefinition,
) -> ComponentDefinition {
    let category = definition.category.clone();
    for spec in &mut definition.params {
        match &mut spec.kind {
            ParamKind::Profile { options } if options.is_empty() => {
                *options = project
                    .registry()
                    .profiles_in_category(&category)
                    .map(|profile| profile.id.clone())
                    .collect();
            }
            ParamKind::Reference { filter, options } if options.is_empty() => {
                let mut ids = ComponentRegistry::references_for_filter(
                    project.document().references(),
                    *filter,
                );
                ids.insert(0, String::new());
                *options = ids;
            }
            _ => {}
        }
    }
    definition
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
    let selected_ref_id = SELECTED_REF.with(|cell| cell.borrow().map(|id| id.to_string()));
    let selected_grid_axis_id =
        SELECTED_GRID_AXIS.with(|cell| cell.borrow().map(|id| id.to_string()));
    let selected_construction_line_id =
        SELECTED_CONSTRUCTION_LINE.with(|cell| cell.borrow().map(|id| id.to_string()));
    let selected_section_cut_id =
        SELECTED_SECTION_CUT.with(|cell| cell.borrow().map(|id| id.to_string()));
    let selected_space_id = SELECTED_SPACE.with(|cell| cell.borrow().map(|id| id.to_string()));
    let mut references: Vec<_> = project
        .document()
        .references()
        .map(|reference| reference_dto(project, reference))
        .collect();
    references.sort_by(|a, b| a.name.cmp(&b.name));

    let mut grid_axes: Vec<_> = project
        .document()
        .grid_axes()
        .map(|axis| grid_axis_dto(project, axis))
        .collect();
    grid_axes.sort_by(|a, b| a.name.cmp(&b.name));

    let mut construction_lines: Vec<_> = project
        .document()
        .construction_lines()
        .map(|line| construction_line_dto(project, line))
        .collect();
    construction_lines.sort_by(|a, b| a.name.cmp(&b.name));

    let mut section_cuts: Vec<_> = project
        .document()
        .section_cuts()
        .map(|cut| section_cut_dto(project, cut))
        .collect();
    section_cuts.sort_by(|a, b| a.name.cmp(&b.name));

    let mut spaces: Vec<_> = project
        .document()
        .spaces()
        .map(|space| space_dto(project, space))
        .collect();
    spaces.sort_by(|a, b| (a.name.len(), &a.name).cmp(&(b.name.len(), &b.name)));

    let (fit_bounds_min, fit_bounds_max) = project
        .document()
        .model_fit_bounds()
        .map(|(min, max)| (Some(min.to_array()), Some(max.to_array())))
        .unwrap_or((None, None));
    let room_detect_report = ROOM_DETECT_REPORT.with(|cell| cell.borrow_mut().take());

    let mut views: Vec<_> = project.views().map(view_dto).collect();
    views.sort_by(|a, b| a.name.cmp(&b.name));

    let mut sheets: Vec<_> = project.sheets().map(sheet_dto).collect();
    sheets.sort_by(|a, b| a.number.cmp(&b.number).then_with(|| a.name.cmp(&b.name)));

    let mut view_annotations: Vec<_> = project
        .view_annotations()
        .map(|a| view_annotation_dto(project, a))
        .collect();
    view_annotations.sort_by(|a, b| a.view_id.cmp(&b.view_id).then_with(|| a.id.cmp(&b.id)));

    SceneDto {
        positions: buffers.positions,
        normals: buffers.normals,
        indices: buffers.indices,
        pick_ids: buffers.pick_ids.iter().map(|id| *id as f64).collect(),
        edge_positions: project.hide_buried_edges(&buffers.edge_positions),
        elements: buffers
            .elements
            .iter()
            .map(|e| {
                let profile_id = project
                    .document()
                    .get_element(e.id)
                    .and_then(|element| project.registry().element_profile_id(element));
                ElementListDto {
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
                    effective_level_id: project
                        .effective_level_id(e.id)
                        .unwrap_or(e.level_id)
                        .to_string(),
                    parent_id: project
                        .document()
                        .get_element(e.id)
                        .and_then(|element| element.parent_id)
                        .map(|id| id.to_string()),
                    profile_id,
                }
            })
            .collect(),
        references,
        grid_axes,
        construction_lines,
        section_cuts,
        spaces,
        views,
        sheets,
        view_annotations,
        plan_symbols: apex_core::opening_plan_symbols(
            project,
            project.document().active_level_id(),
        )
        .iter()
        .map(|p| p.to_array())
        .collect(),
        levels: sorted_levels(project),
        active_level_id: project
            .document()
            .active_level_id()
            .map(|id| id.to_string()),
        fit_bounds_min,
        fit_bounds_max,
        room_detect_report,
        version: buffers.version,
        selected_id: selected_ids.first().cloned(),
        selected_ids,
        selected_ref_id,
        selected_grid_axis_id,
        selected_construction_line_id,
        selected_section_cut_id,
        selected_space_id,
        can_undo: project.can_undo(),
        can_redo: project.can_redo(),
    }
}

fn ref_id(id: &str) -> Result<RefId, JsValue> {
    RefId::from_str(id).map_err(|e| err(format!("bad reference id: {e}")))
}

fn parse_reference_kind(name: &str) -> Result<ReferenceKind, JsValue> {
    match name.trim() {
        "point" => Ok(ReferenceKind::Point),
        "plane" => Ok(ReferenceKind::Plane),
        other => Err(err(format!("unknown reference kind '{other}'"))),
    }
}

fn clear_element_selection() {
    with_selection(|s| s.set(None));
}

fn clear_ref_selection() {
    SELECTED_REF.with(|cell| *cell.borrow_mut() = None);
}

fn clear_grid_axis_selection() {
    SELECTED_GRID_AXIS.with(|cell| *cell.borrow_mut() = None);
}

fn clear_construction_line_selection() {
    SELECTED_CONSTRUCTION_LINE.with(|cell| *cell.borrow_mut() = None);
}

fn clear_section_cut_selection() {
    SELECTED_SECTION_CUT.with(|cell| *cell.borrow_mut() = None);
}

fn clear_space_selection() {
    SELECTED_SPACE.with(|cell| *cell.borrow_mut() = None);
}

/// Clear every non-element selection (refs + plan annotations).
fn clear_datum_selections() {
    clear_ref_selection();
    clear_grid_axis_selection();
    clear_construction_line_selection();
    clear_section_cut_selection();
    clear_space_selection();
}

fn grid_axis_id(id: &str) -> Result<GridAxisId, JsValue> {
    GridAxisId::from_str(id).map_err(|e| err(format!("bad grid axis id: {e}")))
}

fn construction_line_id(id: &str) -> Result<ConstructionLineId, JsValue> {
    ConstructionLineId::from_str(id).map_err(|e| err(format!("bad construction line id: {e}")))
}

fn section_cut_id(id: &str) -> Result<SectionCutId, JsValue> {
    SectionCutId::from_str(id).map_err(|e| err(format!("bad section cut id: {e}")))
}

fn space_id(id: &str) -> Result<SpaceId, JsValue> {
    SpaceId::from_str(id).map_err(|e| err(format!("bad space id: {e}")))
}

fn parse_view_id(id: &str) -> Result<ViewId, JsValue> {
    ViewId::from_str(id).map_err(|e| err(format!("bad view id: {e}")))
}

fn parse_sheet_id(id: &str) -> Result<SheetId, JsValue> {
    SheetId::from_str(id).map_err(|e| err(format!("bad sheet id: {e}")))
}

fn view_dto(view: &View) -> ViewDto {
    ViewDto {
        id: view.id.to_string(),
        name: view.name.clone(),
        type_label: view.kind.type_label().to_string(),
        kind: view.kind.clone(),
        settings: view.settings.clone(),
    }
}

fn sheet_dto(sheet: &Sheet) -> SheetDto {
    let (width_mm, height_mm) = sheet.paper_size_mm();
    SheetDto {
        id: sheet.id.to_string(),
        number: sheet.number.clone(),
        name: sheet.name.clone(),
        paper: sheet.paper,
        orientation: sheet.orientation,
        custom_width_mm: sheet.custom_width_mm,
        custom_height_mm: sheet.custom_height_mm,
        width_mm,
        height_mm,
        viewports: sheet
            .viewports
            .iter()
            .map(|vp| SheetViewportDto {
                id: vp.id.to_string(),
                view_id: vp.view_id.to_string(),
                center_x_mm: vp.center_x_mm,
                center_y_mm: vp.center_y_mm,
                width_mm: vp.width_mm,
                height_mm: vp.height_mm,
                anchor_x_m: vp.anchor_x_m,
                anchor_z_m: vp.anchor_z_m,
                camera: vp.camera.clone(),
                lock_navigation: vp.lock_navigation,
                crop_polygon: vp.crop_polygon.clone(),
            })
            .collect(),
    }
}

fn view_annotation_dto(project: &Project, annotation: &ViewAnnotation) -> ViewAnnotationDto {
    let overlay = project.annotation_overlay(annotation);
    ViewAnnotationDto {
        id: annotation.id.to_string(),
        view_id: annotation.view_id.to_string(),
        category: annotation.kind.category().to_string(),
        kind: annotation.kind.clone(),
        line_segments: overlay
            .line_segments
            .into_iter()
            .map(|p| p.to_array())
            .collect(),
        labels: overlay
            .labels
            .into_iter()
            .map(|label| AnnotationLabelDto {
                position: label.position.to_array(),
                text: label.text,
            })
            .collect(),
    }
}

fn parse_view_kind(json: &str) -> Result<ViewKind, JsValue> {
    parse_json("view kind", json)
}

fn parse_view_annotation_kind(json: &str) -> Result<ViewAnnotationKind, JsValue> {
    parse_json("annotation kind", json)
}

fn view_annotation_id(id: &str) -> Result<ViewAnnotationId, JsValue> {
    ViewAnnotationId::from_str(id).map_err(|e| err(format!("bad annotation id: {e}")))
}

fn parse_view_settings(json: &str) -> Result<ViewSettings, JsValue> {
    if json.trim().is_empty() {
        return Ok(ViewSettings::default());
    }
    parse_json("view settings", json)
}

fn parse_paper_size(name: &str) -> Result<PaperSize, JsValue> {
    match name.trim().to_ascii_uppercase().as_str() {
        "A4" => Ok(PaperSize::A4),
        "A3" => Ok(PaperSize::A3),
        "A2" => Ok(PaperSize::A2),
        "A1" => Ok(PaperSize::A1),
        "A0" => Ok(PaperSize::A0),
        "CUSTOM" => Ok(PaperSize::Custom),
        other => Err(err(format!("unknown paper size '{other}'"))),
    }
}

fn parse_paper_orientation(name: &str) -> Result<PaperOrientation, JsValue> {
    match name.trim().to_ascii_lowercase().as_str() {
        "portrait" => Ok(PaperOrientation::Portrait),
        "landscape" => Ok(PaperOrientation::Landscape),
        other => Err(err(format!("unknown paper orientation '{other}'"))),
    }
}

fn scene(project: &Project) -> Result<JsValue, JsValue> {
    to_js(&scene_dto(project))
}

fn points_from_json(json: &str) -> Result<Vec<Vec3>, JsValue> {
    let raw: Vec<[f32; 3]> = parse_json("points", json)?;
    Ok(raw.into_iter().map(Vec3::from_array).collect())
}

fn delta_from_json(json: &str) -> Result<Vec3, JsValue> {
    let raw: [f32; 3] = parse_json("delta", json)?;
    Ok(Vec3::from_array(raw))
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
        let list: Vec<_> = project
            .registry()
            .components()
            .cloned()
            .map(|definition| with_dynamic_options(project, definition))
            .collect();
        to_js(&list)
    })
}

/// Installed profile types. Empty `category` returns the whole library.
#[wasm_bindgen(js_name = listProfiles)]
pub fn list_profiles(category: &str) -> Result<JsValue, JsValue> {
    with_project(|project| {
        let mut list: Vec<ProfileType> = if category.trim().is_empty() {
            project.registry().profiles().values().cloned().collect()
        } else {
            project
                .registry()
                .profiles_in_category(category)
                .cloned()
                .collect()
        };
        list.sort_by(|a, b| a.id.cmp(&b.id));
        to_js(&list)
    })
}

/// Install or replace a profile type. Dependent elements are rebuilt.
#[wasm_bindgen(js_name = registerProfile)]
pub fn register_profile(definition_json: &str) -> Result<JsValue, JsValue> {
    with_project(|project| {
        let profile: ProfileType = parse_json("profile", definition_json)?;
        project.register_profile(profile).map_err(err)?;
        scene(project)
    })
}

/// Patch type-level values on a profile and rebuild every element that uses it.
#[wasm_bindgen(js_name = updateProfileType)]
pub fn update_profile_type(id: &str, params_json: &str) -> Result<JsValue, JsValue> {
    with_project(|project| {
        let params = parse_params(params_json)?;
        project.update_profile_type(id, params).map_err(err)?;
        scene(project)
    })
}

#[derive(Serialize)]
struct ProfilePreviewDto {
    outer: Vec<[f32; 2]>,
    holes: Vec<Vec<[f32; 2]>>,
}

/// Evaluate a profile spec (or a full `ProfileType`) to a 2D outline for the editor.
#[wasm_bindgen(js_name = previewProfile)]
pub fn preview_profile(profile_json: &str, params_json: &str) -> Result<JsValue, JsValue> {
    with_project(|project| {
        let overrides = parse_params(params_json)?;
        let geom = if let Ok(mut profile) = serde_json::from_str::<ProfileType>(profile_json) {
            profile.compile_sketch().map_err(err)?;
            let params = profile.merge_eval_params(&overrides).map_err(err)?;
            profile
                .spec
                .evaluate(&params, project.registry().profiles())
                .map_err(err)?
        } else {
            let spec: ProfileSpec = parse_json("profile spec", profile_json)?;
            project
                .registry()
                .preview_profile(&spec, &overrides)
                .map_err(err)?
        };
        to_js(&ProfilePreviewDto {
            outer: geom.outer().to_vec(),
            holes: geom.holes().to_vec(),
        })
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

/// Mesh preview for a component definition before it is registered (visual editor).
#[wasm_bindgen(js_name = previewComponentDefinition)]
pub fn preview_component_definition(
    definition_json: &str,
    points_json: &str,
    rotation: f32,
    params_json: &str,
    placement_kind: &str,
) -> Result<JsValue, JsValue> {
    with_project(|project| {
        let definition: ComponentDefinition = parse_json("component", definition_json)?;
        let points = points_from_json(points_json)?;
        let params = parse_params(params_json)?;
        let kind = parse_placement_kind(placement_kind)?;
        let mesh = project
            .preview_definition(&definition, kind, &points, rotation, &params)
            .map_err(err)?;
        to_js(&MeshDto {
            positions: mesh.positions,
            normals: mesh.normals,
            indices: mesh.indices,
            edge_positions: mesh.edges,
        })
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

/// Place a component and attach it to a parent in one undo step (openings).
#[wasm_bindgen(js_name = createElementWithParent)]
pub fn create_element_with_parent(
    component_id: &str,
    points_json: &str,
    rotation: f32,
    params_json: &str,
    placement_kind: &str,
    parent_id: &str,
) -> Result<JsValue, JsValue> {
    with_project(|project| {
        let points = points_from_json(points_json)?;
        let params = parse_params(params_json)?;
        let kind = parse_placement_kind(placement_kind)?;
        let placement = project
            .placement_from_gesture(component_id, kind, &points, rotation)
            .map_err(err)?;
        let parent = if parent_id.trim().is_empty() {
            None
        } else {
            Some(element_id(parent_id)?)
        };
        let id = project
            .create_element_with_parent(component_id, placement, params, parent)
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
            .update_element(element, Some(params), None, true)
            .map_err(err)?;
        scene(project)
    })
}

/// A slab's editable shape (`{shape, handles, creases, thickness}`), or
/// `null` when the element has none.
#[wasm_bindgen(js_name = slabShapeInfo)]
pub fn slab_shape_info(id: &str) -> Result<JsValue, JsValue> {
    with_project(|project| {
        let element = element_id(id)?;
        to_js(&project.slab_shape_info(element))
    })
}

/// Replace a slab's shape (`{z, points, creases}`); one undo step.
#[wasm_bindgen(js_name = setSlabShape)]
pub fn set_slab_shape(id: &str, shape_json: &str) -> Result<JsValue, JsValue> {
    with_project(|project| {
        let element = element_id(id)?;
        let shape: apex_core::SlabShape = serde_json::from_str(shape_json).map_err(err)?;
        project.set_slab_shape(element, &shape).map_err(err)?;
        scene(project)
    })
}

/// Attach an element to a parent, or detach it by passing `null`.
///
/// The child takes the parent's level and follows it when moved. One undo step.
/// Returns the ids whose level changed, so the UI can refresh them.
#[wasm_bindgen(js_name = setElementParent)]
pub fn set_element_parent(id: &str, parent_id: Option<String>) -> Result<JsValue, JsValue> {
    with_project(|project| {
        let element = element_id(id)?;
        let parent = match parent_id.as_deref() {
            Some(raw) => Some(element_id(raw)?),
            None => None,
        };
        let changed = project.set_element_parent(element, parent).map_err(err)?;
        to_js(&changed.iter().map(|id| id.to_string()).collect::<Vec<_>>())
    })
}

/// Direct children of an element.
#[wasm_bindgen(js_name = childrenOf)]
pub fn children_of(id: &str) -> Result<JsValue, JsValue> {
    with_project(|project| {
        let element = element_id(id)?;
        let ids: Vec<String> = project
            .children_of(element)
            .into_iter()
            .map(|id| id.to_string())
            .collect();
        to_js(&ids)
    })
}

/// Every descendant of an element, breadth first.
#[wasm_bindgen(js_name = descendantsOf)]
pub fn descendants_of(id: &str) -> Result<JsValue, JsValue> {
    with_project(|project| {
        let element = element_id(id)?;
        let ids: Vec<String> = project
            .descendants_of(element)
            .into_iter()
            .map(|id| id.to_string())
            .collect();
        to_js(&ids)
    })
}

/// The level an element actually sits on, following parent inheritance.
#[wasm_bindgen(js_name = effectiveLevelOf)]
pub fn effective_level_of(id: &str) -> Result<Option<String>, JsValue> {
    with_project(|project| {
        let element = element_id(id)?;
        Ok(project.effective_level_id(element).map(|l| l.to_string()))
    })
}

/// Re-place an existing element from a fresh set of picks.
///
/// The existing curve type is kept, so dragging an arc wall's handles does
/// not turn it into a polyline. Pass `record_history: false` for live drag
/// previews; the final commit should use the default `true`.
#[wasm_bindgen(js_name = setElementPlacement)]
pub fn set_element_placement(
    id: &str,
    points_json: &str,
    rotation: f32,
    record_history: bool,
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
            .update_element(element, None, Some(placement), record_history)
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

/// Every currently selected element, with full placement detail.
#[wasm_bindgen(js_name = getSelectedElements)]
pub fn get_selected_elements() -> Result<JsValue, JsValue> {
    with_project(|project| {
        let ids = with_selection(|s| s.0.clone());
        let list: Vec<ElementDto> = ids
            .iter()
            .filter_map(|id| {
                project
                    .document()
                    .get_element(*id)
                    .map(|element| element_dto(project, element))
            })
            .collect();
        to_js(&list)
    })
}

/// Move the current selection by a world-space offset.
#[wasm_bindgen(js_name = translateSelection)]
pub fn translate_selection(delta_json: &str, record_history: bool) -> Result<JsValue, JsValue> {
    with_project(|project| {
        let delta = delta_from_json(delta_json)?;
        if let Some(ref_id) = SELECTED_REF.with(|cell| *cell.borrow()) {
            project
                .translate_reference(ref_id, delta, record_history)
                .map_err(err)?;
        } else if let Some(axis_id) = SELECTED_GRID_AXIS.with(|cell| *cell.borrow()) {
            project
                .translate_grid_axis(axis_id, delta, record_history)
                .map_err(err)?;
        } else if let Some(line_id) = SELECTED_CONSTRUCTION_LINE.with(|cell| *cell.borrow()) {
            project
                .translate_construction_line(line_id, delta, record_history)
                .map_err(err)?;
        } else if let Some(cut_id) = SELECTED_SECTION_CUT.with(|cell| *cell.borrow()) {
            project
                .translate_section_cut(cut_id, delta, record_history)
                .map_err(err)?;
        } else if let Some(space_sel) = SELECTED_SPACE.with(|cell| *cell.borrow()) {
            project
                .translate_space(space_sel, delta, record_history)
                .map_err(err)?;
        } else {
            let ids = with_selection(|s| s.0.clone());
            if ids.is_empty() {
                return Err(err("Nothing selected to move"));
            }
            project
                .translate_elements(&ids, delta, record_history)
                .map_err(err)?;
        }
        scene(project)
    })
}

/// Duplicate the current selection, offsetting copies by a world-space vector.
#[wasm_bindgen(js_name = copySelection)]
pub fn copy_selection(delta_json: &str) -> Result<JsValue, JsValue> {
    with_project(|project| {
        let delta = delta_from_json(delta_json)?;
        if let Some(ref_id) = SELECTED_REF.with(|cell| *cell.borrow()) {
            let new_id = project.copy_reference(ref_id, delta).map_err(err)?;
            clear_element_selection();
            clear_datum_selections();
            SELECTED_REF.with(|cell| *cell.borrow_mut() = Some(new_id));
        } else if let Some(axis_id) = SELECTED_GRID_AXIS.with(|cell| *cell.borrow()) {
            let new_id = project.copy_grid_axis(axis_id, delta).map_err(err)?;
            clear_element_selection();
            clear_datum_selections();
            SELECTED_GRID_AXIS.with(|cell| *cell.borrow_mut() = Some(new_id));
        } else if let Some(line_id) = SELECTED_CONSTRUCTION_LINE.with(|cell| *cell.borrow()) {
            let new_id = project
                .copy_construction_line(line_id, delta)
                .map_err(err)?;
            clear_element_selection();
            clear_datum_selections();
            SELECTED_CONSTRUCTION_LINE.with(|cell| *cell.borrow_mut() = Some(new_id));
        } else if let Some(cut_id) = SELECTED_SECTION_CUT.with(|cell| *cell.borrow()) {
            let new_id = project.copy_section_cut(cut_id, delta).map_err(err)?;
            clear_element_selection();
            clear_datum_selections();
            SELECTED_SECTION_CUT.with(|cell| *cell.borrow_mut() = Some(new_id));
        } else if let Some(space_sel) = SELECTED_SPACE.with(|cell| *cell.borrow()) {
            let new_id = project.copy_space(space_sel, delta).map_err(err)?;
            clear_element_selection();
            clear_datum_selections();
            SELECTED_SPACE.with(|cell| *cell.borrow_mut() = Some(new_id));
        } else {
            let ids = with_selection(|s| s.0.clone());
            if ids.is_empty() {
                return Err(err("Nothing selected to copy"));
            }
            let new_ids = project.copy_elements(&ids, delta).map_err(err)?;
            clear_datum_selections();
            with_selection(|s| {
                s.0.clear();
                s.0.extend(new_ids);
            });
        }
        scene(project)
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
            clear_datum_selections();
            with_selection(|s| s.set(Some(element)));
        }
        scene(project)
    })
}

#[wasm_bindgen(js_name = selectReference)]
pub fn select_reference(id: &str) -> Result<JsValue, JsValue> {
    with_project(|project| {
        if id.is_empty() {
            clear_ref_selection();
        } else {
            let reference = ref_id(id)?;
            if project.document().get_reference(reference).is_none() {
                return Err(err("Reference not found"));
            }
            clear_element_selection();
            clear_datum_selections();
            SELECTED_REF.with(|cell| *cell.borrow_mut() = Some(reference));
        }
        scene(project)
    })
}

#[wasm_bindgen(js_name = selectGridAxis)]
pub fn select_grid_axis(id: &str) -> Result<JsValue, JsValue> {
    with_project(|project| {
        if id.is_empty() {
            clear_grid_axis_selection();
        } else {
            let axis = grid_axis_id(id)?;
            if project.document().get_grid_axis(axis).is_none() {
                return Err(err("Grid axis not found"));
            }
            clear_element_selection();
            clear_datum_selections();
            SELECTED_GRID_AXIS.with(|cell| *cell.borrow_mut() = Some(axis));
        }
        scene(project)
    })
}

#[wasm_bindgen(js_name = selectConstructionLine)]
pub fn select_construction_line(id: &str) -> Result<JsValue, JsValue> {
    with_project(|project| {
        if id.is_empty() {
            clear_construction_line_selection();
        } else {
            let line = construction_line_id(id)?;
            if project.document().get_construction_line(line).is_none() {
                return Err(err("Construction line not found"));
            }
            clear_element_selection();
            clear_datum_selections();
            SELECTED_CONSTRUCTION_LINE.with(|cell| *cell.borrow_mut() = Some(line));
        }
        scene(project)
    })
}

#[wasm_bindgen(js_name = selectSectionCut)]
pub fn select_section_cut(id: &str) -> Result<JsValue, JsValue> {
    with_project(|project| {
        if id.is_empty() {
            clear_section_cut_selection();
        } else {
            let cut = section_cut_id(id)?;
            if project.document().get_section_cut(cut).is_none() {
                return Err(err("Section cut not found"));
            }
            clear_element_selection();
            clear_datum_selections();
            SELECTED_SECTION_CUT.with(|cell| *cell.borrow_mut() = Some(cut));
        }
        scene(project)
    })
}

#[wasm_bindgen(js_name = selectSpace)]
pub fn select_space(id: &str) -> Result<JsValue, JsValue> {
    with_project(|project| {
        if id.is_empty() {
            clear_space_selection();
        } else {
            let space = space_id(id)?;
            if project.document().get_space(space).is_none() {
                return Err(err("Space not found"));
            }
            clear_element_selection();
            clear_datum_selections();
            SELECTED_SPACE.with(|cell| *cell.borrow_mut() = Some(space));
        }
        scene(project)
    })
}

#[wasm_bindgen(js_name = getSelectedReference)]
pub fn get_selected_reference() -> Result<JsValue, JsValue> {
    with_project(|project| {
        let selected = SELECTED_REF.with(|cell| *cell.borrow());
        let Some(id) = selected else {
            return Ok(JsValue::NULL);
        };
        match project.document().get_reference(id) {
            Some(reference) => to_js(&reference_dto(project, reference)),
            None => Ok(JsValue::NULL),
        }
    })
}

#[wasm_bindgen(js_name = getSelectedGridAxis)]
pub fn get_selected_grid_axis() -> Result<JsValue, JsValue> {
    with_project(|project| {
        let selected = SELECTED_GRID_AXIS.with(|cell| *cell.borrow());
        let Some(id) = selected else {
            return Ok(JsValue::NULL);
        };
        match project.document().get_grid_axis(id) {
            Some(axis) => to_js(&grid_axis_dto(project, axis)),
            None => Ok(JsValue::NULL),
        }
    })
}

#[wasm_bindgen(js_name = getSelectedConstructionLine)]
pub fn get_selected_construction_line() -> Result<JsValue, JsValue> {
    with_project(|project| {
        let selected = SELECTED_CONSTRUCTION_LINE.with(|cell| *cell.borrow());
        let Some(id) = selected else {
            return Ok(JsValue::NULL);
        };
        match project.document().get_construction_line(id) {
            Some(line) => to_js(&construction_line_dto(project, line)),
            None => Ok(JsValue::NULL),
        }
    })
}

#[wasm_bindgen(js_name = getSelectedSectionCut)]
pub fn get_selected_section_cut() -> Result<JsValue, JsValue> {
    with_project(|project| {
        let selected = SELECTED_SECTION_CUT.with(|cell| *cell.borrow());
        let Some(id) = selected else {
            return Ok(JsValue::NULL);
        };
        match project.document().get_section_cut(id) {
            Some(cut) => to_js(&section_cut_dto(project, cut)),
            None => Ok(JsValue::NULL),
        }
    })
}

#[wasm_bindgen(js_name = getSelectedSpace)]
pub fn get_selected_space() -> Result<JsValue, JsValue> {
    with_project(|project| {
        let selected = SELECTED_SPACE.with(|cell| *cell.borrow());
        let Some(id) = selected else {
            return Ok(JsValue::NULL);
        };
        match project.document().get_space(id) {
            Some(space) => to_js(&space_dto(project, space)),
            None => Ok(JsValue::NULL),
        }
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
        if found.is_some() {
            clear_datum_selections();
        }
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
// References
// ---------------------------------------------------------------------------

#[wasm_bindgen(js_name = createReference)]
pub fn create_reference(kind: &str, points_json: &str, rotation: f32) -> Result<JsValue, JsValue> {
    with_project(|project| {
        let kind = parse_reference_kind(kind)?;
        let points = points_from_json(points_json)?;
        let placement = project
            .placement_for_reference(kind, &points, rotation)
            .map_err(err)?;
        let id = project.create_reference(kind, placement).map_err(err)?;
        clear_element_selection();
        clear_datum_selections();
        SELECTED_REF.with(|cell| *cell.borrow_mut() = Some(id));
        scene(project)
    })
}

#[wasm_bindgen(js_name = createGridAxis)]
pub fn create_grid_axis(
    points_json: &str,
    params_json: &str,
    rotation: f32,
) -> Result<JsValue, JsValue> {
    with_project(|project| {
        let points = points_from_json(points_json)?;
        let params = parse_params(params_json)?;
        let placement = project
            .placement_for_grid_axis(&points, rotation)
            .map_err(err)?;
        let id = project.create_grid_axis(placement, params).map_err(err)?;
        clear_element_selection();
        clear_datum_selections();
        SELECTED_GRID_AXIS.with(|cell| *cell.borrow_mut() = Some(id));
        scene(project)
    })
}

#[wasm_bindgen(js_name = setGridAxisPlacement)]
pub fn set_grid_axis_placement(
    id: &str,
    points_json: &str,
    rotation: f32,
    record_history: bool,
) -> Result<JsValue, JsValue> {
    with_project(|project| {
        let axis = grid_axis_id(id)?;
        let existing = project
            .document()
            .get_grid_axis(axis)
            .ok_or_else(|| err("Grid axis not found"))?;
        let points = points_from_json(points_json)?;
        let placement = PlacementKind::TwoPoint
            .build(&points, rotation, &project.work_plane(existing.level_id))
            .map_err(|e| err(e.to_string()))?;
        project
            .update_grid_axis(axis, None, Some(placement), record_history)
            .map_err(err)?;
        scene(project)
    })
}

#[wasm_bindgen(js_name = updateGridAxis)]
pub fn update_grid_axis(id: &str, params_json: &str) -> Result<JsValue, JsValue> {
    with_project(|project| {
        let axis = grid_axis_id(id)?;
        let params = parse_params(params_json)?;
        project
            .update_grid_axis(axis, Some(params), None, true)
            .map_err(err)?;
        scene(project)
    })
}

#[wasm_bindgen(js_name = deleteSelectedGridAxis)]
pub fn delete_selected_grid_axis() -> Result<JsValue, JsValue> {
    with_project(|project| {
        let id = SELECTED_GRID_AXIS.with(|cell| cell.borrow_mut().take());
        if let Some(id) = id {
            project.delete_grid_axis(id);
        }
        scene(project)
    })
}

#[wasm_bindgen(js_name = createConstructionLine)]
pub fn create_construction_line(
    points_json: &str,
    params_json: &str,
    rotation: f32,
) -> Result<JsValue, JsValue> {
    with_project(|project| {
        let points = points_from_json(points_json)?;
        let params = parse_params(params_json)?;
        let placement = project
            .placement_for_construction_line(&points, rotation)
            .map_err(err)?;
        let id = project
            .create_construction_line(placement, params)
            .map_err(err)?;
        clear_element_selection();
        clear_datum_selections();
        SELECTED_CONSTRUCTION_LINE.with(|cell| *cell.borrow_mut() = Some(id));
        scene(project)
    })
}

#[wasm_bindgen(js_name = setConstructionLinePlacement)]
pub fn set_construction_line_placement(
    id: &str,
    points_json: &str,
    rotation: f32,
    record_history: bool,
) -> Result<JsValue, JsValue> {
    with_project(|project| {
        let line = construction_line_id(id)?;
        let existing = project
            .document()
            .get_construction_line(line)
            .ok_or_else(|| err("Construction line not found"))?;
        let points = points_from_json(points_json)?;
        let placement = PlacementKind::TwoPoint
            .build(&points, rotation, &project.work_plane(existing.level_id))
            .map_err(|e| err(e.to_string()))?;
        project
            .update_construction_line(line, None, Some(placement), record_history)
            .map_err(err)?;
        scene(project)
    })
}

#[wasm_bindgen(js_name = updateConstructionLine)]
pub fn update_construction_line(id: &str, params_json: &str) -> Result<JsValue, JsValue> {
    with_project(|project| {
        let line = construction_line_id(id)?;
        let params = parse_params(params_json)?;
        project
            .update_construction_line(line, Some(params), None, true)
            .map_err(err)?;
        scene(project)
    })
}

#[wasm_bindgen(js_name = deleteSelectedConstructionLine)]
pub fn delete_selected_construction_line() -> Result<JsValue, JsValue> {
    with_project(|project| {
        let id = SELECTED_CONSTRUCTION_LINE.with(|cell| cell.borrow_mut().take());
        if let Some(id) = id {
            project.delete_construction_line(id);
        }
        scene(project)
    })
}

#[wasm_bindgen(js_name = createSectionCut)]
pub fn create_section_cut(
    points_json: &str,
    params_json: &str,
    rotation: f32,
) -> Result<JsValue, JsValue> {
    with_project(|project| {
        let points = points_from_json(points_json)?;
        let params = parse_params(params_json)?;
        let placement = project
            .placement_for_section_cut(&points, rotation)
            .map_err(err)?;
        let id = project.create_section_cut(placement, params).map_err(err)?;
        clear_element_selection();
        clear_datum_selections();
        SELECTED_SECTION_CUT.with(|cell| *cell.borrow_mut() = Some(id));
        scene(project)
    })
}

#[wasm_bindgen(js_name = setSectionCutPlacement)]
pub fn set_section_cut_placement(
    id: &str,
    points_json: &str,
    rotation: f32,
    record_history: bool,
) -> Result<JsValue, JsValue> {
    with_project(|project| {
        let cut = section_cut_id(id)?;
        let existing = project
            .document()
            .get_section_cut(cut)
            .ok_or_else(|| err("Section cut not found"))?;
        let points = points_from_json(points_json)?;
        let placement = PlacementKind::TwoPoint
            .build(&points, rotation, &project.work_plane(existing.level_id))
            .map_err(|e| err(e.to_string()))?;
        project
            .update_section_cut(cut, None, Some(placement), record_history)
            .map_err(err)?;
        scene(project)
    })
}

#[wasm_bindgen(js_name = updateSectionCut)]
pub fn update_section_cut(id: &str, params_json: &str) -> Result<JsValue, JsValue> {
    with_project(|project| {
        let cut = section_cut_id(id)?;
        let params = parse_params(params_json)?;
        project
            .update_section_cut(cut, Some(params), None, true)
            .map_err(err)?;
        scene(project)
    })
}

#[wasm_bindgen(js_name = deleteSelectedSectionCut)]
pub fn delete_selected_section_cut() -> Result<JsValue, JsValue> {
    with_project(|project| {
        let id = SELECTED_SECTION_CUT.with(|cell| cell.borrow_mut().take());
        if let Some(id) = id {
            project.delete_section_cut(id);
        }
        scene(project)
    })
}

#[wasm_bindgen(js_name = createSpace)]
pub fn create_space(
    points_json: &str,
    params_json: &str,
    rotation: f32,
) -> Result<JsValue, JsValue> {
    with_project(|project| {
        let points = points_from_json(points_json)?;
        let params = parse_params(params_json)?;
        let placement = project
            .placement_for_space(&points, rotation)
            .map_err(err)?;
        let id = project.create_space(placement, params).map_err(err)?;
        clear_element_selection();
        clear_datum_selections();
        SELECTED_SPACE.with(|cell| *cell.borrow_mut() = Some(id));
        scene(project)
    })
}

#[wasm_bindgen(js_name = setSpacePlacement)]
pub fn set_space_placement(
    id: &str,
    points_json: &str,
    rotation: f32,
    record_history: bool,
) -> Result<JsValue, JsValue> {
    with_project(|project| {
        let space = space_id(id)?;
        let existing = project
            .document()
            .get_space(space)
            .ok_or_else(|| err("Space not found"))?;
        let points = points_from_json(points_json)?;
        let placement = PlacementKind::Polyline
            .build(&points, rotation, &project.work_plane(existing.level_id))
            .map_err(|e| err(e.to_string()))?;
        project
            .update_space(space, None, Some(placement), record_history)
            .map_err(err)?;
        scene(project)
    })
}

#[wasm_bindgen(js_name = updateSpace)]
pub fn update_space(id: &str, params_json: &str) -> Result<JsValue, JsValue> {
    with_project(|project| {
        let space = space_id(id)?;
        let params = parse_params(params_json)?;
        project
            .update_space(space, Some(params), None, true)
            .map_err(err)?;
        scene(project)
    })
}

#[wasm_bindgen(js_name = renameSpace)]
pub fn rename_space(id: &str, name: &str) -> Result<JsValue, JsValue> {
    with_project(|project| {
        let space = space_id(id)?;
        project.rename_space(space, name).map_err(err)?;
        scene(project)
    })
}

#[wasm_bindgen(js_name = deleteSelectedSpace)]
pub fn delete_selected_space() -> Result<JsValue, JsValue> {
    with_project(|project| {
        let id = SELECTED_SPACE.with(|cell| cell.borrow_mut().take());
        if let Some(id) = id {
            project.delete_space(id);
        }
        scene(project)
    })
}

/// Recompute path joins for a joinable element (corners / T-junctions).
///
/// Auto-join already runs on place for `joinable` components; plugins call this
/// after a placement edit. One undo step.
#[wasm_bindgen(js_name = joinPaths)]
pub fn join_paths(id: &str) -> Result<JsValue, JsValue> {
    with_project(|project| {
        let element = element_id(id)?;
        project.join_paths(element).map_err(err)?;
        scene(project)
    })
}

/// Detect enclosed rooms from walls on the active level; refresh auto spaces.
#[wasm_bindgen(js_name = detectRoomsFromWalls)]
pub fn detect_rooms_from_walls() -> Result<JsValue, JsValue> {
    with_project(|project| {
        let level_id = project
            .document()
            .active_level_id()
            .ok_or_else(|| err("no active level"))?;
        let mut segments = Vec::new();
        for id in project.document().elements_on_level(level_id) {
            let Some(element) = project.document().get_element(id) else {
                continue;
            };
            if element.component_id != "apex.wall" {
                continue;
            }
            segments.extend(apex_core::wall_centerline_segments(element));
        }
        let loops_found =
            apex_core::detect_room_polygons(&segments, apex_core::ENDPOINT_SNAP).len();

        let created = project.detect_rooms_from_walls().map_err(err)?;
        ROOM_DETECT_REPORT.with(|cell| {
            *cell.borrow_mut() = Some(RoomDetectReportDto {
                created,
                loops_found,
            });
        });
        // Prefer selecting a newly created auto space when present.
        if created > 0 {
            clear_element_selection();
            clear_datum_selections();
            let auto_id = project
                .document()
                .spaces()
                .filter(|space| space.resolved_params().bool("auto").unwrap_or(false))
                .map(|space| space.id)
                .max_by(|a, b| a.to_string().cmp(&b.to_string()));
            SELECTED_SPACE.with(|cell| *cell.borrow_mut() = auto_id);
        }
        scene(project)
    })
}

#[wasm_bindgen(js_name = setReferencePlacement)]
pub fn set_reference_placement(
    id: &str,
    points_json: &str,
    rotation: f32,
    record_history: bool,
) -> Result<JsValue, JsValue> {
    with_project(|project| {
        let reference = ref_id(id)?;
        let existing = project
            .document()
            .get_reference(reference)
            .ok_or_else(|| err("Reference not found"))?;
        let points = points_from_json(points_json)?;
        let placement = existing
            .kind
            .placement_kind()
            .build(&points, rotation, &project.work_plane(existing.level_id))
            .map_err(|e| err(e.to_string()))?;
        project
            .update_reference(reference, placement, record_history)
            .map_err(err)?;
        scene(project)
    })
}

#[wasm_bindgen(js_name = deleteSelectedReference)]
pub fn delete_selected_reference() -> Result<JsValue, JsValue> {
    with_project(|project| {
        let id = SELECTED_REF.with(|cell| cell.borrow_mut().take());
        if let Some(id) = id {
            project.delete_reference(id);
        }
        scene(project)
    })
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
        project.set_active_level(level).map_err(err)?;
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

/// JSON snapshot of the document, profiles, and extra components.
#[wasm_bindgen(js_name = exportProject)]
pub fn export_project() -> Result<String, JsValue> {
    with_project(|project| {
        serde_json::to_string(&project.export_snapshot()).map_err(|e| err(e.to_string()))
    })
}

/// IFC4 STEP export. `mapping_json` is an optional `{ componentId: IfcEntity }` object.
#[wasm_bindgen(js_name = exportIfc)]
pub fn export_ifc(mapping_json: &str) -> Result<String, JsValue> {
    with_project(|project| {
        let mapping: apex_ifc::IfcMapping = if mapping_json.trim().is_empty() {
            Default::default()
        } else {
            parse_json("ifc mapping", mapping_json)?
        };
        Ok(apex_ifc::export_ifc4(project, &mapping))
    })
}

/// Replace the current project from a JSON snapshot.
#[wasm_bindgen(js_name = importProject)]
pub fn import_project(json: &str) -> Result<JsValue, JsValue> {
    with_project(|project| {
        let snap: ProjectSnapshot = parse_json("project", json)?;
        project.import_snapshot(snap).map_err(err)?;
        with_selection(|s| s.set(None));
        clear_datum_selections();
        scene(project)
    })
}

/// Discard the current project and start a blank one with the built-in types.
#[wasm_bindgen(js_name = newProject)]
pub fn new_project() -> Result<JsValue, JsValue> {
    PROJECT.with(|cell| *cell.borrow_mut() = Some(Project::new()));
    with_selection(|s| s.set(None));
    clear_datum_selections();
    with_project(|project| scene(project))
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

#[wasm_bindgen(js_name = createPlanView)]
pub fn create_plan_view(level_id_str: &str) -> Result<JsValue, JsValue> {
    with_project(|project| {
        let level = level_id(level_id_str)?;
        project.create_plan_view(level).map_err(err)?;
        scene(project)
    })
}

#[wasm_bindgen(js_name = createThreeDView)]
pub fn create_three_d_view() -> Result<JsValue, JsValue> {
    with_project(|project| {
        project.create_three_d_view();
        scene(project)
    })
}

#[wasm_bindgen(js_name = duplicateView)]
pub fn duplicate_view(id: &str) -> Result<JsValue, JsValue> {
    with_project(|project| {
        let view = parse_view_id(id)?;
        project.duplicate_view(view).map_err(err)?;
        scene(project)
    })
}

#[wasm_bindgen(js_name = renameView)]
pub fn rename_view(id: &str, name: &str) -> Result<JsValue, JsValue> {
    with_project(|project| {
        let view = parse_view_id(id)?;
        project.rename_view(view, name.to_string()).map_err(err)?;
        scene(project)
    })
}

#[wasm_bindgen(js_name = deleteView)]
pub fn delete_view(id: &str) -> Result<JsValue, JsValue> {
    with_project(|project| {
        let view = parse_view_id(id)?;
        project.delete_view(view).map_err(err)?;
        scene(project)
    })
}

#[wasm_bindgen(js_name = updateViewSettings)]
pub fn update_view_settings(id: &str, settings_json: &str) -> Result<JsValue, JsValue> {
    with_project(|project| {
        let view = parse_view_id(id)?;
        let settings = parse_view_settings(settings_json)?;
        project.update_view_settings(view, settings).map_err(err)?;
        scene(project)
    })
}

/// Persist camera / plan parameters from the shell into a saved view.
#[wasm_bindgen(js_name = saveViewState)]
pub fn save_view_state(id: &str, kind_json: &str) -> Result<JsValue, JsValue> {
    with_project(|project| {
        let view = parse_view_id(id)?;
        let kind = parse_view_kind(kind_json)?;
        project.save_view_camera(view, kind).map_err(err)?;
        scene(project)
    })
}

#[wasm_bindgen(js_name = createViewAnnotation)]
pub fn create_view_annotation(view_id_str: &str, kind_json: &str) -> Result<JsValue, JsValue> {
    with_project(|project| {
        let view_id = parse_view_id(view_id_str)?;
        let kind = parse_view_annotation_kind(kind_json)?;
        project.create_view_annotation(view_id, kind).map_err(err)?;
        scene(project)
    })
}

#[wasm_bindgen(js_name = updateViewAnnotation)]
pub fn update_view_annotation(id: &str, kind_json: &str) -> Result<JsValue, JsValue> {
    with_project(|project| {
        let ann = view_annotation_id(id)?;
        let kind = parse_view_annotation_kind(kind_json)?;
        project.update_view_annotation(ann, kind).map_err(err)?;
        scene(project)
    })
}

#[wasm_bindgen(js_name = deleteViewAnnotation)]
pub fn delete_view_annotation(id: &str) -> Result<JsValue, JsValue> {
    with_project(|project| {
        let ann = view_annotation_id(id)?;
        project.delete_view_annotation(ann).map_err(err)?;
        scene(project)
    })
}

#[wasm_bindgen(js_name = exportViewVector)]
pub fn export_view_vector(view_id_str: &str) -> Result<String, JsValue> {
    with_project(|project| {
        let view_id = parse_view_id(view_id_str)?;
        let drawing = project
            .vector_export_view(view_id)
            .ok_or_else(|| err("vector export supports plan views only"))?;
        serde_json::to_string(&drawing).map_err(|e| err(e.to_string()))
    })
}

#[wasm_bindgen(js_name = exportViewDxf)]
pub fn export_view_dxf(view_id_str: &str) -> Result<String, JsValue> {
    with_project(|project| {
        let view_id = parse_view_id(view_id_str)?;
        project
            .export_view_dxf(view_id)
            .ok_or_else(|| err("DXF export supports plan views only"))
    })
}

#[wasm_bindgen(js_name = exportSheetVector)]
pub fn export_sheet_vector(sheet_id_str: &str) -> Result<String, JsValue> {
    with_project(|project| {
        let sheet_id = parse_sheet_id(sheet_id_str)?;
        let drawing = project
            .vector_export_sheet(sheet_id)
            .ok_or_else(|| err("sheet not found"))?;
        serde_json::to_string(&drawing).map_err(|e| err(e.to_string()))
    })
}

#[wasm_bindgen(js_name = exportSheetDxf)]
pub fn export_sheet_dxf(sheet_id_str: &str) -> Result<String, JsValue> {
    with_project(|project| {
        let sheet_id = parse_sheet_id(sheet_id_str)?;
        project
            .export_sheet_dxf(sheet_id)
            .ok_or_else(|| err("sheet not found"))
    })
}

#[wasm_bindgen(js_name = updateSheetViewportState)]
pub fn update_sheet_viewport_state(
    sheet_id_str: &str,
    viewport_id_str: &str,
    camera_json: &str,
    lock_navigation: bool,
) -> Result<JsValue, JsValue> {
    with_project(|project| {
        use apex_core::StoredCamera;
        let sheet_id = parse_sheet_id(sheet_id_str)?;
        let viewport_id = apex_core::SheetViewportId::from_str(viewport_id_str)
            .map_err(|e| err(format!("bad viewport id: {e}")))?;
        let camera: Option<StoredCamera> = if camera_json.trim().is_empty() {
            None
        } else {
            Some(parse_json("camera", camera_json)?)
        };
        project
            .update_sheet_viewport_state(sheet_id, viewport_id, camera, lock_navigation)
            .map_err(err)?;
        scene(project)
    })
}

// ---------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------

#[wasm_bindgen(js_name = createSheet)]
pub fn create_sheet(number: &str, name: &str) -> Result<JsValue, JsValue> {
    with_project(|project| {
        project.create_sheet(number.to_string(), name.to_string());
        scene(project)
    })
}

#[wasm_bindgen(js_name = createSheetWithLayout)]
pub fn create_sheet_with_layout(
    number: &str,
    name: &str,
    paper: &str,
    orientation: &str,
    custom_width_mm: f32,
    custom_height_mm: f32,
) -> Result<JsValue, JsValue> {
    with_project(|project| {
        let paper = parse_paper_size(paper)?;
        let orientation = parse_paper_orientation(orientation)?;
        let custom_w = if paper == PaperSize::Custom {
            Some(custom_width_mm)
        } else {
            None
        };
        let custom_h = if paper == PaperSize::Custom {
            Some(custom_height_mm)
        } else {
            None
        };
        project.create_sheet_with_layout(
            number.to_string(),
            name.to_string(),
            paper,
            orientation,
            custom_w,
            custom_h,
        );
        scene(project)
    })
}

#[wasm_bindgen(js_name = renameSheet)]
pub fn rename_sheet(id: &str, number: &str, name: &str) -> Result<JsValue, JsValue> {
    with_project(|project| {
        let sheet = parse_sheet_id(id)?;
        project
            .rename_sheet(sheet, number.to_string(), name.to_string())
            .map_err(err)?;
        scene(project)
    })
}

#[wasm_bindgen(js_name = updateSheetLayout)]
pub fn update_sheet_layout(
    id: &str,
    paper: &str,
    orientation: &str,
    custom_width_mm: f32,
    custom_height_mm: f32,
) -> Result<JsValue, JsValue> {
    with_project(|project| {
        let sheet = parse_sheet_id(id)?;
        let paper = parse_paper_size(paper)?;
        let orientation = parse_paper_orientation(orientation)?;
        let custom_w = if paper == PaperSize::Custom {
            Some(custom_width_mm)
        } else {
            None
        };
        let custom_h = if paper == PaperSize::Custom {
            Some(custom_height_mm)
        } else {
            None
        };
        project
            .update_sheet_layout(sheet, paper, orientation, custom_w, custom_h)
            .map_err(err)?;
        scene(project)
    })
}

#[wasm_bindgen(js_name = deleteSheet)]
pub fn delete_sheet(id: &str) -> Result<JsValue, JsValue> {
    with_project(|project| {
        let sheet = parse_sheet_id(id)?;
        project.delete_sheet(sheet).map_err(err)?;
        scene(project)
    })
}

#[wasm_bindgen(js_name = placeViewOnSheet)]
pub fn place_view_on_sheet(
    sheet_id: &str,
    view_id: &str,
    center_x_mm: f32,
    center_y_mm: f32,
    width_mm: f32,
    height_mm: f32,
) -> Result<JsValue, JsValue> {
    with_project(|project| {
        let sheet = parse_sheet_id(sheet_id)?;
        let view = parse_view_id(view_id)?;
        project
            .place_view_on_sheet(sheet, view, center_x_mm, center_y_mm, width_mm, height_mm)
            .map_err(err)?;
        scene(project)
    })
}

#[wasm_bindgen(js_name = setSheetViewportScale)]
pub fn set_sheet_viewport_scale(
    sheet_id: &str,
    viewport_id: &str,
    scale_denominator: f32,
) -> Result<JsValue, JsValue> {
    with_project(|project| {
        let sheet = parse_sheet_id(sheet_id)?;
        let viewport = apex_core::SheetViewportId::from_str(viewport_id)
            .map_err(|e| err(format!("bad viewport id: {e}")))?;
        project
            .set_sheet_viewport_scale(sheet, viewport, scale_denominator)
            .map_err(err)?;
        scene(project)
    })
}

#[wasm_bindgen(js_name = moveSheetViewport)]
pub fn move_sheet_viewport(
    sheet_id: &str,
    viewport_id: &str,
    center_x_mm: f32,
    center_y_mm: f32,
) -> Result<JsValue, JsValue> {
    with_project(|project| {
        let sheet = parse_sheet_id(sheet_id)?;
        let viewport = apex_core::SheetViewportId::from_str(viewport_id)
            .map_err(|e| err(format!("bad viewport id: {e}")))?;
        project
            .move_sheet_viewport(sheet, viewport, center_x_mm, center_y_mm)
            .map_err(err)?;
        scene(project)
    })
}

#[wasm_bindgen(js_name = setSheetViewportCrop)]
pub fn set_sheet_viewport_crop(
    sheet_id: &str,
    viewport_id: &str,
    crop_json: &str,
) -> Result<JsValue, JsValue> {
    with_project(|project| {
        let sheet = parse_sheet_id(sheet_id)?;
        let viewport = apex_core::SheetViewportId::from_str(viewport_id)
            .map_err(|e| err(format!("bad viewport id: {e}")))?;
        let crop: Vec<[f32; 2]> = parse_json("crop polygon", crop_json)?;
        project
            .set_sheet_viewport_crop(sheet, viewport, crop)
            .map_err(err)?;
        scene(project)
    })
}

#[wasm_bindgen(js_name = resetSheetViewportCrop)]
pub fn reset_sheet_viewport_crop(sheet_id: &str, viewport_id: &str) -> Result<JsValue, JsValue> {
    with_project(|project| {
        let sheet = parse_sheet_id(sheet_id)?;
        let viewport = apex_core::SheetViewportId::from_str(viewport_id)
            .map_err(|e| err(format!("bad viewport id: {e}")))?;
        project
            .reset_sheet_viewport_crop(sheet, viewport)
            .map_err(err)?;
        scene(project)
    })
}

#[wasm_bindgen(js_name = removeSheetViewport)]
pub fn remove_sheet_viewport(sheet_id: &str, viewport_id: &str) -> Result<JsValue, JsValue> {
    with_project(|project| {
        let sheet = parse_sheet_id(sheet_id)?;
        let viewport = apex_core::SheetViewportId::from_str(viewport_id)
            .map_err(|e| err(format!("bad viewport id: {e}")))?;
        project
            .remove_sheet_viewport(sheet, viewport)
            .map_err(err)?;
        scene(project)
    })
}

// ---------------------------------------------------------------------------
// Undo / redo
// ---------------------------------------------------------------------------

#[wasm_bindgen(js_name = undo)]
pub fn undo() -> Result<JsValue, JsValue> {
    with_project(|project| {
        project.undo().map_err(err)?;
        with_selection(|s| s.retain_existing(project));
        scene(project)
    })
}

#[wasm_bindgen(js_name = redo)]
pub fn redo() -> Result<JsValue, JsValue> {
    with_project(|project| {
        project.redo().map_err(err)?;
        with_selection(|s| s.retain_existing(project));
        scene(project)
    })
}

#[wasm_bindgen(js_name = canUndo)]
pub fn can_undo() -> Result<bool, JsValue> {
    with_project(|project| Ok(project.can_undo()))
}

#[wasm_bindgen(js_name = canRedo)]
pub fn can_redo() -> Result<bool, JsValue> {
    with_project(|project| Ok(project.can_redo()))
}

/// Open a coalesced undo group (e.g. at the start of an anchor drag).
#[wasm_bindgen(js_name = beginUndoGroup)]
pub fn begin_undo_group() -> Result<(), JsValue> {
    with_project(|project| {
        project.begin_undo_group();
        Ok(())
    })
}

/// Drop an open undo group without recording (cancelled gesture).
#[wasm_bindgen(js_name = abortUndoGroup)]
pub fn abort_undo_group() -> Result<(), JsValue> {
    with_project(|project| {
        project.abort_undo_group();
        Ok(())
    })
}

// ---------------------------------------------------------------------------
// Command layer (headless / MCP)
// ---------------------------------------------------------------------------

/// Run one serialized `Command` (`{"op": ...}`) as a single undo step.
/// Returns the JSON result; errors are readable strings.
#[wasm_bindgen(js_name = executeCommand)]
pub fn execute_command(command_json: &str) -> Result<String, JsValue> {
    with_project(|project| {
        let out = project.execute_json(command_json).map_err(err)?;
        with_selection(|s| s.set(None));
        clear_datum_selections();
        Ok(out.to_string())
    })
}

/// Run one serialized read-only `Query` (`{"op": ...}`).
/// `export_ifc` is handled here because core cannot depend on apex-ifc.
#[wasm_bindgen(js_name = runQuery)]
pub fn run_query(query_json: &str) -> Result<String, JsValue> {
    with_project(|project| {
        let value: serde_json::Value = parse_json("query", query_json)?;
        if value.get("op").and_then(|v| v.as_str()) == Some("export_ifc") {
            let mapping: apex_ifc::IfcMapping = match value.get("mapping") {
                Some(m) if !m.is_null() => {
                    serde_json::from_value(m.clone()).map_err(|e| err(e.to_string()))?
                }
                _ => Default::default(),
            };
            let ifc = apex_ifc::export_ifc4(project, &mapping);
            return Ok(serde_json::json!({ "format": "ifc", "content": ifc }).to_string());
        }
        Ok(project.query_json(query_json).map_err(err)?.to_string())
    })
}

/// Full machine-readable API: conventions, components, commands, queries,
/// annotation kinds — every entry with its descriptor.
#[wasm_bindgen(js_name = describeApi)]
pub fn describe_api() -> Result<String, JsValue> {
    with_project(|project| Ok(apex_core::api_catalog(project).to_string()))
}
