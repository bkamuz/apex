//! Nested genera: bindings, mirrored children (left ↔ right) with outward
//! faces, and host cuts carried out of a mirrored child.

use apex_core::Project;
use serde_json::{json, Value};

fn q(p: &Project, v: Value) -> Value {
    p.query_json(&v.to_string())
        .unwrap_or_else(|e| panic!("{v}: {e}"))
}

fn positions(m: &Value) -> Vec<[f64; 3]> {
    let pos: Vec<f64> = m["positions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_f64().unwrap())
        .collect();
    pos.chunks(3).map(|c| [c[0], c[1], c[2]]).collect()
}

/// Signed volume (positive = faces point outward).
fn volume(m: &Value) -> f64 {
    let p = positions(m);
    let idx: Vec<usize> = m["indices"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_u64().unwrap() as usize)
        .collect();
    idx.chunks(3)
        .map(|t| {
            let (a, b, c) = (p[t[0]], p[t[1]], p[t[2]]);
            (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0])
                + a[2] * (b[0] * c[1] - b[1] * c[0]))
                / 6.0
        })
        .sum()
}

fn x_range(m: &Value) -> (f64, f64) {
    positions(m)
        .iter()
        .fold((f64::MAX, f64::MIN), |(lo, hi), p| {
            (lo.min(p[0]), hi.max(p[0]))
        })
}

fn solid<'a>(r: &'a Value, path: &str) -> &'a Value {
    r["solids"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["path"] == path)
        .unwrap_or_else(|| panic!("no {path} in {r}"))
}

#[test]
fn mirrored_child_flips_left_to_right_and_stays_outward() {
    let mut p = Project::new();
    let leaf = json!({"op": "define_genus", "id": "user.leaf", "name": "Leaf", "placement": {"kind": "point"},
    "params": [{"id": "leaf_w", "default": 0.4}],
    "body": [
        {"id": "board", "item": "solid", "shape": "box", "min": [0, 0, 0], "max": ["leaf_w", 2, 0.05]},
        {"id": "knob", "item": "solid", "shape": "box", "min": ["leaf_w - 0.1", 1, 0.05], "max": ["leaf_w - 0.05", 1.05, 0.1]},
        {"id": "slot", "item": "cut", "shape": "box", "min": [0.05, 0.5, -0.3], "max": [0.15, 0.6, 0.3], "targets": {"host": true}}
    ]});
    p.execute_json(&leaf.to_string()).unwrap();
    let parent = json!({"op": "preview_genus", "id": "user.double", "name": "Double", "placement": {"kind": "point"},
    "params": [{"id": "width", "default": 1.0}],
    "body": [
        {"id": "a", "item": "nested", "genus": "user.leaf", "offset": ["-width / 2", 0, 0], "params": {"leaf_w": "width / 2"}},
        {"id": "b", "item": "nested", "genus": "user.leaf", "offset": ["width / 2", 0, 0], "params": {"leaf_w": "width / 2"}, "mirror": true}
    ]});
    let r = q(&p, parent);
    assert_eq!(r["ok"], true, "{r}");
    let (a0, a1) = x_range(&solid(&r, "a/board")["mesh"]);
    let (b0, b1) = x_range(&solid(&r, "b/board")["mesh"]);
    assert!((a0 + 0.5).abs() < 1e-5 && a1.abs() < 1e-5, "{a0} {a1}");
    assert!(b0.abs() < 1e-5 && (b1 - 0.5).abs() < 1e-5, "{b0} {b1}");
    // Each knob sits at its leaf's free edge: mirror images meeting mid-span.
    let (ka0, _) = x_range(&solid(&r, "a/knob")["mesh"]);
    let (_, kb1) = x_range(&solid(&r, "b/knob")["mesh"]);
    assert!(
        (ka0 + 0.1).abs() < 1e-5 && (kb1 - 0.1).abs() < 1e-5,
        "{ka0} {kb1}"
    );
    for path in ["a/board", "b/board", "b/knob"] {
        let v = volume(&solid(&r, path)["mesh"]);
        assert!(v > 0.0, "{path} inside out: {v}");
    }
    let cuts = r["cuts"].as_array().unwrap();
    let slot = cuts
        .iter()
        .find(|c| c["path"] == "b/slot")
        .expect("mirrored cut");
    let (s0, s1) = x_range(&slot["mesh"]);
    assert!(
        (s0 - 0.35).abs() < 1e-5 && (s1 - 0.45).abs() < 1e-5,
        "{s0} {s1}"
    );
    assert!(volume(&slot["mesh"]) > 0.0);

    // Saved and read back.
    let mut def = json!({"op": "define_genus", "id": "user.double", "name": "Double", "placement": {"kind": "point"},
        "params": [{"id": "width", "default": 1.0}],
        "body": [{"id": "b", "item": "nested", "genus": "user.leaf", "mirror": true}]});
    p.execute_json(&def.to_string()).unwrap();
    let g = q(&p, json!({"op": "get_genus", "id": "user.double"}));
    assert_eq!(g["authored"]["body"][0]["mirror"], true, "{g}");
    def["body"][0]["mirror"] = json!(false);
    p.execute_json(&def.to_string()).unwrap();
    let g = q(&p, json!({"op": "get_genus", "id": "user.double"}));
    assert!(g["authored"]["body"][0].get("mirror").is_none(), "{g}");
}
