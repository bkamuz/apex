//! Genus shapes from sketches: extrude with holes, revolve about a line ref,
//! sweep along a polyline ref, boxes bound to refs, `ref.<id>` formulas that
//! flex with params, and closed-profile errors.

use apex_core::Project;
use serde_json::{json, Value};

fn q(p: &Project, v: Value) -> Value {
    p.query_json(&v.to_string())
        .unwrap_or_else(|e| panic!("{v}: {e}"))
}

fn genus(body: Value) -> Value {
    json!({"op": "preview_genus", "id": "user.part", "name": "Part", "placement": {"kind": "point"},
        "params": [{"id": "width", "default": 1.0}, {"id": "height", "default": 0.6}, {"id": "turn", "default": 180}],
        "refs": [
            {"id": "left", "ref": "plane", "origin": ["-width / 2", 0, 0], "normal": "x"},
            {"id": "right", "ref": "plane", "origin": ["width / 2", 0, 0], "normal": "x"},
            {"id": "top", "ref": "plane", "origin": [0, "height", 0], "normal": "y"},
            {"id": "front", "ref": "plane", "origin": [0, 0, 0.1], "normal": "z"},
            {"id": "axis", "ref": "line", "from": [0, 0, 0], "to": [0, 1, 0]},
            {"id": "path", "ref": "polyline", "points": [[0, 0, 0], [1, 0, 0], [1, 0, 1]]}
        ],
        "body": body})
}

/// [min, max] over every solid's mesh positions.
fn bounds(r: &Value) -> ([f64; 3], [f64; 3]) {
    let mut lo = [f64::MAX; 3];
    let mut hi = [f64::MIN; 3];
    for s in r["solids"].as_array().unwrap() {
        let pos = s["mesh"]["positions"].as_array().unwrap();
        for (i, v) in pos.iter().enumerate() {
            let v = v.as_f64().unwrap();
            lo[i % 3] = lo[i % 3].min(v);
            hi[i % 3] = hi[i % 3].max(v);
        }
    }
    (lo, hi)
}

fn near(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-4
}

fn extrude() -> Value {
    json!([{"id": "panel", "item": "solid", "shape": "prism", "normal": "z",
        "sketch": [
            {"kind": "line", "a": ["ref.left", 0], "b": ["ref.right", 0]},
            {"kind": "line", "a": ["ref.right", 0], "b": ["ref.right", "ref.top"]},
            {"kind": "arc", "a": ["ref.right", "ref.top"], "b": ["ref.left", "ref.top"], "bulge": 0.2},
            {"kind": "line", "a": ["ref.left", "ref.top"], "b": ["ref.left", 0]},
            {"kind": "circle", "c": [0, 0.3], "r": 0.1}
        ],
        "depth": [0, "ref.front"], "material": "Дуб"}])
}

#[test]
fn extrude_sketch_flexes_with_refs() {
    let p = Project::new();
    let r = q(&p, genus(extrude()));
    assert_eq!(r["ok"], true, "{r}");
    let (lo, hi) = bounds(&r);
    assert!(near(lo[0], -0.5) && near(hi[0], 0.5), "{lo:?} {hi:?}");
    assert!(near(lo[2], 0.0) && near(hi[2], 0.1), "{lo:?} {hi:?}");
    // The arc bulges above the top plane.
    assert!(hi[1] > 0.6 + 0.05, "{hi:?}");
    assert_eq!(r["solids"][0]["material"], "Дуб");

    let mut wide = genus(extrude());
    wide["species_values"] = json!({"width": 1.6});
    let r = q(&p, wide);
    let (lo, hi) = bounds(&r);
    assert!(near(lo[0], -0.8) && near(hi[0], 0.8), "{lo:?} {hi:?}");
}

#[test]
fn open_and_branching_profiles_are_refused() {
    let p = Project::new();
    let open = json!([{"id": "s", "item": "solid", "shape": "prism", "normal": "z",
        "sketch": [{"kind": "line", "a": [0, 0], "b": [1, 0]}, {"kind": "line", "a": [1, 0], "b": [1, 1]}],
        "depth": [0, 0.1]}]);
    let r = q(&p, genus(open));
    assert_eq!(r["ok"], false, "{r}");
    assert!(r["error"].as_str().unwrap().contains("open profile"), "{r}");

    let outside = json!([{"id": "s", "item": "solid", "shape": "prism", "normal": "z",
        "sketch": [{"kind": "rect", "a": [0, 0], "b": [1, 1]}, {"kind": "circle", "c": [3, 3], "r": 0.1}],
        "depth": [0, 0.1]}]);
    let r = q(&p, genus(outside));
    assert!(r["error"].as_str().unwrap().contains("outside"), "{r}");

    let unknown = json!([{"id": "s", "item": "solid", "shape": "box", "min": ["ref.nowhere", 0, 0], "max": [1, 1, 1]}]);
    let r = q(&p, genus(unknown));
    assert_eq!(r["ok"], false, "{r}");
    assert!(r["error"].as_str().unwrap().contains("nowhere"), "{r}");
}

#[test]
fn revolve_about_a_line_ref_with_an_angle_param() {
    let p = Project::new();
    let body = json!([{"id": "knob", "item": "solid", "shape": "revolve", "normal": "z", "axis": "axis", "angle": "turn",
        "sketch": [{"kind": "rect", "a": [0.1, 0], "b": [0.3, 0.5]}]}]);
    let r = q(&p, genus(body.clone()));
    assert_eq!(r["ok"], true, "{r}");
    let (lo, hi) = bounds(&r);
    // Half a turn about +y from +x: x spans -0.3..0.3, z only on one side.
    assert!(near(lo[0], -0.3) && near(hi[0], 0.3), "{lo:?} {hi:?}");
    assert!(near(lo[1], 0.0) && near(hi[1], 0.5), "{lo:?} {hi:?}");
    assert!(
        lo[2] > -1e-4 || hi[2] < 1e-4,
        "half turn stays on one side: {lo:?} {hi:?}"
    );

    let mut full = genus(body);
    full["species_values"] = json!({"turn": 360});
    let (lo, hi) = bounds(&q(&p, full));
    assert!(near(lo[2], -0.3) && near(hi[2], 0.3), "{lo:?} {hi:?}");

    let crossing = json!([{"id": "k", "item": "solid", "shape": "revolve", "normal": "z", "axis": "axis",
        "sketch": [{"kind": "rect", "a": [-0.1, 0], "b": [0.3, 0.5]}]}]);
    let r = q(&p, genus(crossing));
    assert!(
        r["error"].as_str().unwrap().contains("crosses the axis"),
        "{r}"
    );
}

#[test]
fn sweep_sketch_along_a_polyline_ref() {
    let p = Project::new();
    // Profile drawn in the side view (normal x) around the path start.
    let body = json!([{"id": "rail", "item": "solid", "shape": "sweep", "normal": "x", "along": "path",
        "sketch": [{"kind": "rect", "a": [-0.05, -0.05], "b": [0.05, 0.05]}]}]);
    let r = q(&p, genus(body));
    assert_eq!(r["ok"], true, "{r}");
    let (lo, hi) = bounds(&r);
    assert!(near(lo[1], -0.05) && near(hi[1], 0.05), "{lo:?} {hi:?}");
    assert!(hi[0] > 1.0 && hi[2] > 1.0 - 1e-3, "{lo:?} {hi:?}");
}

#[test]
fn box_bound_to_refs_and_void_cuts_self() {
    let p = Project::new();
    let body = json!([
        {"id": "slab", "item": "solid", "shape": "box", "min": ["ref.left", 0, 0], "max": ["ref.right", "ref.top", "ref.front"]},
        {"id": "hole", "item": "cut", "shape": "box", "min": [-0.1, 0.2, -1], "max": [0.1, 0.4, 1], "targets": {"self": true}, "visible": "width > 0.8"}
    ]);
    let r = q(&p, genus(body));
    assert_eq!(r["ok"], true, "{r}");
    let (lo, hi) = bounds(&r);
    assert!(
        near(lo[0], -0.5) && near(hi[1], 0.6) && near(hi[2], 0.1),
        "{lo:?} {hi:?}"
    );
}

#[test]
fn sketches_round_trip_through_define_genus() {
    let mut p = Project::new();
    let mut def = genus(extrude());
    def["op"] = json!("define_genus");
    p.execute_json(&def.to_string()).unwrap();
    let g = q(&p, json!({"op": "get_genus", "id": "user.part"}));
    let shape = &g["authored"]["body"][0];
    assert_eq!(shape["sketch"].as_array().unwrap().len(), 5, "{g}");
    assert_eq!(shape["sketch"][2]["kind"], "arc");
    assert_eq!(shape["depth"][1], "ref.front");
    assert!(
        shape.get("loops").is_none(),
        "empty loops stay terse: {shape}"
    );
}
