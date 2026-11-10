//! Computed genus params (`formula`) and species on new user genera.

use apex_core::Project;
use serde_json::{json, Value};

fn ex(p: &mut Project, v: Value) -> Value {
    p.execute_json(&v.to_string())
        .unwrap_or_else(|e| panic!("{v}: {e}"))
}

fn q(p: &Project, v: Value) -> Value {
    p.query_json(&v.to_string())
        .unwrap_or_else(|e| panic!("{v}: {e}"))
}

fn param(r: &Value, id: &str) -> Value {
    r["params"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == id)
        .unwrap_or_else(|| panic!("no param {id} in {r}"))
        .clone()
}

fn shelf(params: Value) -> Value {
    json!({"op": "define_genus", "id": "user.shelf", "name": "Shelf", "placement": {"kind": "point"},
        "params": params,
        "body": [{"id": "board", "item": "solid", "shape": "box", "min": [0, 0, 0], "max": ["width", "board", "depth"]}]})
}

#[test]
fn computed_param_follows_other_params_and_species() {
    let mut p = Project::new();
    ex(
        &mut p,
        shelf(json!([
            {"id": "width", "default": 1.2, "species": true},
            {"id": "depth", "default": 0.4},
            {"id": "half", "default": 0, "formula": "width / 2"},
            {"id": "board", "default": 0, "formula": "max(0.02, half / 20)"}
        ])),
    );
    // Species without a base on a new user genus.
    ex(
        &mut p,
        json!({"op": "create_species", "genus": "user.shelf", "id": "user.shelf.long", "name": "Long", "params": {"width": 2.0}}),
    );
    let rows = q(
        &p,
        json!({"op": "list_genus_species", "genus": "user.shelf"}),
    );
    assert_eq!(rows.as_array().unwrap().len(), 1, "{rows}");

    let r = q(
        &p,
        json!({"op": "preview_genus", "id": "user.shelf2", "extends": "user.shelf", "species": "user.shelf.long"}),
    );
    assert_eq!(param(&r, "half")["value"], 1.0);
    assert_eq!(param(&r, "board")["value"], 0.05);
    assert_eq!(param(&r, "half")["formula"], "width / 2");
    // Raw values for a computed param are ignored.
    let r = q(
        &p,
        json!({"op": "preview_genus", "id": "user.shelf2", "extends": "user.shelf", "species_values": {"width": 0.8}, "values": {"half": 9}}),
    );
    assert_eq!(param(&r, "half")["value"], 0.4);
}

#[test]
fn bad_formulas_are_refused_with_the_param_named() {
    let p = Project::new();
    let err = |params: Value| {
        let mut v = shelf(params);
        v["op"] = json!("preview_genus");
        p.query_json(&v.to_string()).unwrap_err().to_string()
    };
    let e = err(
        json!([{"id": "width", "default": 1}, {"id": "depth", "default": 0.4}, {"id": "board", "default": 0, "formula": "width +"}]),
    );
    assert!(e.contains("'board'"), "{e}");
    let e = err(
        json!([{"id": "width", "default": 1}, {"id": "depth", "default": 0.4}, {"id": "board", "default": 0, "formula": "nope * 2"}]),
    );
    assert!(e.contains("unknown param 'nope'"), "{e}");
    let e = err(json!([
        {"id": "width", "default": 0, "formula": "board * 2"},
        {"id": "depth", "default": 0.4},
        {"id": "board", "default": 0, "formula": "width / 2"}
    ]));
    assert!(e.contains("circular"), "{e}");
    let e = err(
        json!([{"id": "width", "default": 1, "species": true, "formula": "2"}, {"id": "depth", "default": 0.4}, {"id": "board", "default": 0.02}]),
    );
    assert!(e.contains("per species"), "{e}");
}

#[test]
fn computed_params_in_a_saved_genus_drive_instances() {
    let mut p = Project::new();
    ex(
        &mut p,
        shelf(json!([
            {"id": "width", "default": 1.0},
            {"id": "depth", "default": 0.5, "formula": "width / 2"},
            {"id": "board", "default": 0.02}
        ])),
    );
    let el = ex(
        &mut p,
        json!({"op": "create_element", "component": "user.shelf", "points": [[0, 0, 0]], "params": {"width": 2.0}}),
    );
    let id = el["id"].as_str().unwrap().to_string();
    let g = q(&p, json!({"op": "element_geometry", "id": id}));
    let vol = g["volume"].as_f64().unwrap();
    assert!((vol - 2.0 * 0.02 * 1.0).abs() < 1e-6, "{g}");
}
