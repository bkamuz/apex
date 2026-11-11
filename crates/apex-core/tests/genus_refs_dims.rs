//! Genus editor refs and dims: locked dims round-trip, dims may measure
//! inherited refs, and unknown refs are refused.

use apex_core::Project;
use serde_json::{json, Value};

fn ex(p: &mut Project, v: Value) -> Result<Value, String> {
    p.execute_json(&v.to_string()).map_err(|e| e.to_string())
}

fn q(p: &Project, v: Value) -> Value {
    p.query_json(&v.to_string())
        .unwrap_or_else(|e| panic!("{v}: {e}"))
}

fn window() -> Value {
    json!({"op": "define_genus", "id": "user.window", "name": "Window", "extends": "apex.window",
    "refs": [
        {"id": "left", "ref": "plane", "origin": ["-width / 2", 0, 0], "normal": "x"},
        {"id": "right", "ref": "plane", "origin": ["width / 2", 0, 0], "normal": "x"},
        {"id": "head", "ref": "plane", "origin": [0, "sill + height", 0], "normal": "y"},
        {"id": "mark", "ref": "point", "at": [0.1, 0.2, 0]}
    ],
    "dims": [
        {"id": "w", "from": "left", "to": "right", "param": "width"},
        {"id": "h", "from": "sill", "to": "head", "param": "height", "locked": true}
    ],
    "body": []})
}

#[test]
fn locked_dims_round_trip_and_measure_inherited_refs() {
    let mut p = Project::new();
    ex(&mut p, window()).unwrap();
    let g = q(&p, json!({"op": "get_genus", "id": "user.window"}));
    let dims = g["authored"]["dims"].as_array().unwrap();
    assert_eq!(dims[1]["locked"], true, "{g}");
    assert!(dims[0].get("locked").is_none(), "unlocked dims stay terse");

    let mut draft = window();
    draft["op"] = json!("preview_genus");
    draft["species_values"] = json!({"width": 1.5, "height": 1.2, "sill": 0.9});
    let r = q(&p, draft);
    assert_eq!(r["ok"], true, "{r}");
    let w = r["dims"]
        .as_array()
        .unwrap()
        .iter()
        .find(|d| d["id"] == "w")
        .unwrap();
    assert!((w["value"].as_f64().unwrap() - 1.5).abs() < 1e-9, "{w}");
    let h = r["dims"]
        .as_array()
        .unwrap()
        .iter()
        .find(|d| d["id"] == "h")
        .unwrap();
    assert!((h["value"].as_f64().unwrap() - 1.2).abs() < 1e-9, "{h}");
    assert_eq!(h["locked"], true);
}

#[test]
fn dims_on_unknown_refs_are_refused() {
    let mut p = Project::new();
    let mut bad = window();
    bad["dims"] = json!([{"id": "x", "from": "left", "to": "nowhere"}]);
    let err = ex(&mut p, bad).unwrap_err();
    assert!(err.contains("nowhere"), "{err}");
}
