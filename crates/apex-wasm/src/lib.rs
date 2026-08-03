//! WASM façade over apex-core + apex-geometry.

use std::cell::RefCell;
use std::str::FromStr;

use apex_core::{
    Document, Element, ElementId, SceneBuffers, WallParams,
};
use apex_geometry::generate_wall_mesh;
use serde::Serialize;
use wasm_bindgen::prelude::*;

thread_local! {
    static APP: RefCell<Option<ApexApp>> = const { RefCell::new(None) };
}

struct ApexApp {
    document: Document,
    wall_counter: u32,
    selected: Option<ElementId>,
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
struct SceneDto {
    positions: Vec<f32>,
    normals: Vec<f32>,
    indices: Vec<u32>,
    /// Pick id per triangle.
    pick_ids: Vec<f64>,
    elements: Vec<ElementListDto>,
    version: u64,
    selected_id: Option<String>,
}

#[derive(Serialize)]
struct ElementListDto {
    id: String,
    name: String,
    category: String,
    pick_id: f64,
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

fn scene_dto(doc: &Document, selected: Option<ElementId>) -> SceneDto {
    let buffers: SceneBuffers = doc.build_scene_buffers();
    SceneDto {
        positions: buffers.positions,
        normals: buffers.normals,
        indices: buffers.indices,
        pick_ids: buffers.pick_ids.iter().map(|id| *id as f64).collect(),
        elements: buffers
            .elements
            .iter()
            .map(|e| ElementListDto {
                id: e.id.to_string(),
                name: e.name.clone(),
                category: e.category.clone(),
                pick_id: e.pick_id as f64,
            })
            .collect(),
        version: buffers.version,
        selected_id: selected.map(|id| id.to_string()),
    }
}

/// Initialize panic hook and empty document with Level 0.
#[wasm_bindgen(js_name = initApp)]
pub fn init_app() -> Result<(), JsValue> {
    console_error_panic_hook::set_once();
    APP.with(|cell| {
        *cell.borrow_mut() = Some(ApexApp {
            document: Document::new(),
            wall_counter: 0,
            selected: None,
        });
    });
    Ok(())
}

/// Create a wall from two points. Returns updated scene JSON.
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
            .default_level_id()
            .ok_or_else(|| JsValue::from_str("No default level"))?;

        let wall = WallParams {
            start: [x0, y0, z0],
            end: [x1, y1, z1],
            height,
            thickness,
        };

        let mesh = generate_wall_mesh(&wall).map_err(|e| JsValue::from_str(&e.to_string()))?;

        app.wall_counter += 1;
        let name = format!("Wall {}", app.wall_counter);
        let element = Element::wall(name, level_id, wall);
        let id = element.id;
        app.document.upsert_element(element, mesh);
        app.selected = Some(id);

        to_js(&scene_dto(&app.document, app.selected))
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

        let wall = WallParams {
            start: [x0, y0, z0],
            end: [x1, y1, z1],
            height,
            thickness,
        };
        let mesh = generate_wall_mesh(&wall).map_err(|e| JsValue::from_str(&e.to_string()))?;
        element.wall = Some(wall);
        app.document.update_element(element, mesh);
        app.selected = Some(element_id);
        to_js(&scene_dto(&app.document, app.selected))
    })
}

/// Set selection by element id (or clear with empty string).
#[wasm_bindgen(js_name = selectElement)]
pub fn select_element(id: &str) -> Result<JsValue, JsValue> {
    with_app(|app| {
        if id.is_empty() {
            app.selected = None;
        } else {
            let element_id =
                ElementId::from_str(id).map_err(|e| JsValue::from_str(&e.to_string()))?;
            if app.document.get_element(element_id).is_none() {
                return Err(JsValue::from_str("Element not found"));
            }
            app.selected = Some(element_id);
        }
        to_js(&scene_dto(&app.document, app.selected))
    })
}

/// Pick by GPU pick id (1-based sequential). Returns scene with selection.
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

        app.selected = found;
        to_js(&scene_dto(&app.document, app.selected))
    })
}

/// Full scene buffers for the viewport.
#[wasm_bindgen(js_name = getScene)]
pub fn get_scene() -> Result<JsValue, JsValue> {
    with_app(|app| to_js(&scene_dto(&app.document, app.selected)))
}

/// Selected element details (or null).
#[wasm_bindgen(js_name = getSelected)]
pub fn get_selected() -> Result<JsValue, JsValue> {
    with_app(|app| {
        let Some(id) = app.selected else {
            return Ok(JsValue::NULL);
        };
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

/// Delete selected element.
#[wasm_bindgen(js_name = deleteSelected)]
pub fn delete_selected() -> Result<JsValue, JsValue> {
    with_app(|app| {
        if let Some(id) = app.selected.take() {
            app.document.remove_element(id);
        }
        to_js(&scene_dto(&app.document, app.selected))
    })
}
