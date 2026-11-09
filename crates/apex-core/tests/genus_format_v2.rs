//! Genus format v2: show conditions, comparison / if formulas, sweeps along
//! refs, solid materials, plan representation, param groups and ranges,
//! dims, and the `preview_genus` draft build.

use std::sync::Arc;

use apex_core::{opening_plan_symbols, Formula, ParamMap, ParamValue, Project};
use apex_smlib::SmlibKernel;
use serde_json::{json, Value};

fn ex(p: &mut Project, v: Value) -> Value {
    p.execute_json(&v.to_string())
        .unwrap_or_else(|e| panic!("{v}: {e}"))
}

fn q(p: &Project, v: Value) -> Value {
    p.query_json(&v.to_string())
        .unwrap_or_else(|e| panic!("{v}: {e}"))
}

fn id(v: &Value) -> String {
    v["id"].as_str().unwrap().to_string()
}

fn volume(p: &Project, id: &str) -> f64 {
    q(p, json!({"op": "element_geometry", "id": id}))["volume"]
        .as_f64()
        .unwrap()
}

/// Bench with an optional back rail (show condition), a swept handrail
/// along a polyline ref, a material from a text param and a plan symbol.
fn bench() -> Value {
    json!({"op": "define_genus", "id": "user.bench", "name": "Bench", "category": "furniture",
    "params": [
        {"id": "width", "default": 2.0, "min": 0.5, "max": 4.0, "group": "dimensions"},
        {"id": "seat", "default": 0.45, "group": "dimensions"},
        {"id": "back", "kind": "bool", "default": true, "species": true, "group": "visibility"},
        {"id": "finish", "kind": "text", "default": "oak", "group": "materials"}
    ],
    "refs": [
        {"id": "left", "ref": "plane", "origin": [0, 0, 0], "normal": "x"},
        {"id": "right", "ref": "plane", "origin": ["width", 0, 0], "normal": "x"},
        {"id": "rail", "ref": "polyline", "points": [[0, 0.8, 0.2], ["width", 0.8, 0.2]]}
    ],
    "dims": [{"id": "w", "from": "left", "to": "right", "param": "width"}],
    "body": [
        {"id": "board", "item": "solid", "shape": "box", "min": [0, "seat - 0.05", 0], "max": ["width", "seat", 0.4],
         "material": "finish",
         "plan": {"show": "symbol", "lines": [[0, 0, "width", 0.4], [0, 0.4, "width", 0]]}},
        {"id": "backrest", "item": "solid", "shape": "box", "min": [0, "seat", 0.35], "max": ["width", "seat + 0.4", 0.4],
         "visible": "back and width > 1", "plan": {"show": "hidden"}},
        {"id": "handrail", "item": "solid", "shape": "sweep", "along": "rail",
         "profile": [[[-0.02, -0.02], [0.02, -0.02], [0.02, 0.02], [-0.02, 0.02]]]}
    ]})
}

#[test]
fn formulas_with_comparisons_logic_and_if_round_trip() {
    let p = ParamMap::new()
        .with("width", ParamValue::Length(1.5))
        .with("vent", ParamValue::Bool(true));
    for (src, want) in [
        ("width > 1", 1.0),
        ("width <= 1", 0.0),
        ("width == 1.5", 1.0),
        ("width != 1.5", 0.0),
        ("vent and width > 2", 0.0),
        ("vent or width > 2", 1.0),
        ("not vent", 0.0),
        ("!vent", 0.0),
        ("if(width > 1, width / 2, 0.1)", 0.75),
        ("if(vent && width >= 1.5, 2, 3) + 1", 3.0),
        ("true + false", 1.0),
        ("-(width - 2) * 2", 1.0),
    ] {
        let f = Formula::parse(src).unwrap_or_else(|e| panic!("{src}: {e}"));
        let v = f.eval(&p).unwrap();
        assert!((v - want).abs() < 1e-9, "{src} = {v}, want {want}");
        let printed = f.to_string();
        let back = Formula::parse(&printed).unwrap_or_else(|e| panic!("{printed}: {e}"));
        assert_eq!(back, f, "{src} printed as {printed}");
    }
    // Old formulas print exactly as before.
    for src in [
        "width / 2 - (frame_width + 0.01) * 2",
        "max(-a, min(b, 3))",
        "sill + height + 0.02",
    ] {
        assert_eq!(Formula::parse(src).unwrap().to_string(), src);
    }
    assert!(Formula::parse("if(a, b)").is_err());
    assert!(Formula::parse("a >").is_err());
}

#[test]
fn show_condition_sweep_material_and_plan_symbols_build() {
    let mut p = Project::new();
    ex(&mut p, bench());
    let b = id(&ex(
        &mut p,
        json!({"op": "create_element", "component": "user.bench", "points": [[0, 0, 0]]}),
    ));
    let full = volume(&p, &b);
    // board 2×0.05×0.4 + backrest 2×0.4×0.05 + rail 2×0.04×0.04
    assert!(
        (full - (0.04 + 0.04 + 0.0032)).abs() < 1e-3,
        "volume {full}"
    );
    ex(
        &mut p,
        json!({"op": "update_element", "id": b, "params": {"back": false}}),
    );
    let no_back = volume(&p, &b);
    assert!(
        (full - no_back - 0.04).abs() < 1e-3,
        "backrest hidden: {no_back}"
    );
    // `width > 1` also gates it.
    ex(
        &mut p,
        json!({"op": "update_element", "id": b, "params": {"back": true, "width": 0.8}}),
    );
    assert!((volume(&p, &b) - (0.8 * 0.02 + 0.8 * 0.0016)).abs() < 1e-3);
    // Plan symbol lines: two diagonals across the board.
    let sym = opening_plan_symbols(&p, None);
    assert_eq!(sym.len(), 4, "{sym:?}");
    assert!((sym[1].x - 0.8).abs() < 1e-5 && (sym[1].z - 0.4).abs() < 1e-5);
    // Width range.
    assert!(p
        .execute_json(
            &json!({"op": "update_element", "id": b, "params": {"width": 9.0}}).to_string()
        )
        .is_err());
}

#[test]
fn preview_reports_params_refs_dims_materials_and_plan() {
    let mut p = Project::new();
    let mut draft = bench();
    draft["op"] = json!("preview_genus");
    let r = q(&p, draft.clone());
    assert_eq!(r["ok"], true, "{r}");
    let params = r["params"].as_array().unwrap();
    let width = params.iter().find(|v| v["id"] == "width").unwrap();
    assert_eq!(width["group"], "dimensions");
    assert_eq!(width["min"], 0.5);
    assert_eq!(width["value"], 2.0);
    assert_eq!(r["dims"][0]["value"], 2.0);
    assert_eq!(r["dims"][0]["param"], "width");
    let rail = r["refs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["id"] == "rail")
        .unwrap();
    assert_eq!(rail["kind"], "polyline");
    assert_eq!(rail["points"][1], json!([2.0, 0.8, 0.2]));
    let solids = r["solids"].as_array().unwrap();
    let paths: Vec<&str> = solids.iter().map(|s| s["path"].as_str().unwrap()).collect();
    assert_eq!(paths, ["board", "backrest", "handrail"]);
    assert_eq!(solids[0]["material"], "oak");
    assert_eq!(solids[0]["plan"], "hidden");
    assert_eq!(solids[1]["plan"], "hidden");
    assert_eq!(solids[2]["plan"], "auto");
    assert_eq!(r["plan_lines"].as_array().unwrap().len(), 2);
    assert!(!r["mesh"]["indices"].as_array().unwrap().is_empty());

    // Unsaved species values and instance values.
    let mut d2 = draft.clone();
    d2["species_values"] = json!({"back": false});
    d2["values"] = json!({"width": 3.0, "finish": "ash"});
    let r2 = q(&p, d2);
    let solids = r2["solids"].as_array().unwrap();
    assert_eq!(solids.len(), 2);
    assert_eq!(solids[0]["material"], "ash");
    assert_eq!(r2["dims"][0]["value"], 3.0);

    // Out of range: an error result, not a failed query.
    let mut d3 = draft.clone();
    d3["values"] = json!({"width": 9.0});
    let r3 = q(&p, d3);
    assert_eq!(r3["ok"], false);
    assert!(r3["error"].as_str().unwrap().contains("width"), "{r3}");

    // Nothing was registered.
    let comps = q(&p, json!({"op": "list_components"}));
    assert!(!comps.to_string().contains("user.bench"));

    // Same on the exact kernel.
    p.set_kernel(Arc::new(SmlibKernel::default()));
    let rk = q(&p, draft);
    assert_eq!(rk["ok"], true, "{rk}");
    assert!(!rk["mesh"]["indices"].as_array().unwrap().is_empty());
    let _ = &mut p;
}

#[test]
fn preview_a_window_draft_for_a_species() {
    let p = Project::new();
    let r = q(
        &p,
        json!({"op": "preview_genus", "id": "user.window.vent", "extends": "apex.window",
            "params": [{"id": "vent", "kind": "bool", "default": true, "species": true}],
            "body": [{"id": "vent_bar", "item": "solid", "shape": "box",
                      "min": [0, "sill + 0.1", -0.03], "max": [0.04, "sill + height - 0.1", 0.03],
                      "visible": "vent"}],
            "species": "apex.window.double-1500x1400"}),
    );
    assert_eq!(r["ok"], true, "{r}");
    let params = r["params"].as_array().unwrap();
    let w = params.iter().find(|v| v["id"] == "width").unwrap();
    assert_eq!(w["value"], 1.5);
    let solids = r["solids"].as_array().unwrap();
    assert!(solids.iter().any(|s| s["path"] == "vent_bar"));
    assert!(solids
        .iter()
        .any(|s| s["path"].as_str().unwrap().starts_with("frame/")));
    assert!(r["cuts"]
        .as_array()
        .unwrap()
        .iter()
        .any(|c| c["path"] == "opening"));
    // A built-in id cannot be a draft.
    assert!(p
        .query_json(&json!({"op": "preview_genus", "id": "apex.window"}).to_string())
        .is_err());
    // Unknown species.
    assert!(p
        .query_json(
            &json!({"op": "preview_genus", "extends": "apex.window", "species": "nope"})
                .to_string()
        )
        .is_err());
}

#[test]
fn invalid_ranges_and_refs_are_refused() {
    let mut p = Project::new();
    let bad_range = json!({"op": "define_genus", "id": "user.x", "name": "X",
        "params": [{"id": "w", "default": 1.0, "min": 2.0, "max": 1.0}],
        "body": [{"id": "b", "item": "solid", "shape": "box", "min": [0, 0, 0], "max": ["w", 1, 1]}]});
    assert!(p.execute_json(&bad_range.to_string()).is_err());
    let bad_dim = json!({"op": "define_genus", "id": "user.x", "name": "X",
        "dims": [{"id": "d", "from": "a", "to": "b"}],
        "body": [{"id": "b", "item": "solid", "shape": "box", "min": [0, 0, 0], "max": [1, 1, 1]}]});
    assert!(p.execute_json(&bad_dim.to_string()).is_err());
    let bad_sweep = json!({"op": "define_genus", "id": "user.x", "name": "X",
        "refs": [{"id": "pt", "ref": "point", "at": [0, 0, 0]}],
        "body": [{"id": "s", "item": "solid", "shape": "sweep", "along": "pt",
                  "profile": [[[0, 0], [0.1, 0], [0.1, 0.1]]]}]});
    assert!(p.execute_json(&bad_sweep.to_string()).is_err());
}

#[test]
fn sweeps_are_closed_on_both_kernels() {
    for exact in [false, true] {
        let mut p = Project::new();
        if exact {
            p.set_kernel(Arc::new(SmlibKernel::default()));
        }
        ex(
            &mut p,
            json!({"op": "define_genus", "id": "user.rail", "name": "Rail",
                "params": [{"id": "r", "default": 0.05}],
                "body": [{"id": "s", "item": "solid", "shape": "sweep",
                          "path": [[0, 1, 0], [2, 1, 0], [2, 1, 2]],
                          "profile": [[["-r", "-r"], ["r", "-r"], ["r", "r"], ["-r", "r"]]]}]}),
        );
        let e = id(&ex(
            &mut p,
            json!({"op": "create_element", "component": "user.rail", "points": [[0, 0, 0]]}),
        ));
        let g = q(&p, json!({"op": "element_geometry", "id": e}));
        assert_eq!(g["watertight"], true, "exact={exact} {g}");
        // 4 m centreline × 0.1² (mitred corner keeps the area).
        let v = g["volume"].as_f64().unwrap();
        assert!((v - 0.04).abs() < 2e-3, "exact={exact} volume {v}");
    }
}

#[test]
fn new_fields_stay_out_of_old_genera_json() {
    let mut p = Project::new();
    ex(
        &mut p,
        json!({"op": "define_genus", "id": "user.leg", "name": "Leg",
            "params": [{"id": "h", "default": 0.7}],
            "body": [{"id": "post", "item": "solid", "shape": "box", "min": [0, 0, 0], "max": [0.05, "h", 0.05]}]}),
    );
    let g = q(&p, json!({"op": "get_genus", "id": "user.leg"}));
    assert_eq!(
        g["authored"],
        json!({"body": [{"id": "post", "item": "solid", "shape": "box",
            "min": [0.0, 0.0, 0.0], "max": [0.05, "h", 0.05]}]})
    );
    let s = serde_json::to_string(&p.export_snapshot()).unwrap();
    for key in [
        "\"visible\":",
        "\"show\":",
        "\"material\":",
        "\"dims\":",
        "\"group\":",
    ] {
        assert!(!s.contains(key), "{key} leaked into a save");
    }
}

#[test]
fn define_genus_descriptor_examples_build_and_preview() {
    let d = apex_core::command_descriptors()
        .into_iter()
        .find(|d| d.id == "define_genus")
        .expect("define_genus descriptor");
    assert!(d.descriptor.examples.len() >= 3);
    for e in &d.descriptor.examples {
        let mut p = Project::new();
        ex(&mut p, e.input.clone());
        let gid = e.input["id"].as_str().unwrap();
        let mut draft = e.input.clone();
        draft["op"] = json!("preview_genus");
        draft["id"] = json!(format!("{gid}.draft"));
        let r = q(&p, draft);
        assert_eq!(r["ok"], json!(true), "{}: {r}", e.description);
        assert!(
            !r["solids"].as_array().unwrap().is_empty(),
            "{}",
            e.description
        );
    }
    // The rail example: sweep along a polyline, conditional posts, a dim.
    let rail = d
        .descriptor
        .examples
        .iter()
        .find(|e| e.input["id"] == "user.rail")
        .unwrap();
    let mut p = Project::new();
    ex(&mut p, rail.input.clone());
    let mut draft = rail.input.clone();
    draft["op"] = json!("preview_genus");
    draft["id"] = json!("user.rail2");
    let r = q(&p, draft.clone());
    let paths: Vec<&str> = r["solids"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["path"].as_str().unwrap())
        .collect();
    assert_eq!(paths, ["rail", "post"]);
    assert!((r["dims"][0]["value"].as_f64().unwrap() - 2.0).abs() < 1e-9);
    assert_eq!(r["solids"][0]["material"], json!("steel"));
    draft["values"] = json!({"run": 0.8});
    let r = q(&p, draft);
    let paths: Vec<&str> = r["solids"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["path"].as_str().unwrap())
        .collect();
    assert_eq!(paths, ["rail"]);
}
