//! Universal genus core: nested resolution, `extends` provenance, host /
//! neighbour / self cuts, cycle detection, old-project load, determinism and
//! seamless opening frames.

use apex_core::{GenusFrame, ParamMap, Project};
use apex_geometry::{is_closed, mesh_volume};
use glam::Vec3;
use serde_json::{json, Value};

fn exec(p: &mut Project, v: Value) -> Value {
    p.execute_json(&v.to_string())
        .unwrap_or_else(|e| panic!("{v}: {e}"))
}

fn q(p: &Project, v: Value) -> Value {
    p.query_json(&v.to_string())
        .unwrap_or_else(|e| panic!("{v}: {e}"))
}

fn id(v: &Value) -> String {
    v["id"]
        .as_str()
        .unwrap_or_else(|| panic!("no id in {v}"))
        .to_string()
}

fn volume(p: &Project, id: &str) -> f64 {
    q(p, json!({"op": "element_geometry", "id": id}))["volume"]
        .as_f64()
        .unwrap()
}

fn define_leg_and_table(p: &mut Project) {
    exec(
        p,
        json!({"op": "define_genus", "id": "user.leg", "name": "Leg", "category": "furniture",
            "params": [{"id": "size", "default": 0.05}, {"id": "height", "default": 0.7}],
            "body": [{"id": "post", "item": "solid", "shape": "box",
                "min": [0, 0, 0], "max": ["size", "height", "size"]}]}),
    );
    exec(
        p,
        json!({"op": "define_genus", "id": "user.table", "name": "Table", "category": "furniture",
        "params": [{"id": "width", "default": 1.2}, {"id": "depth", "default": 0.8},
                   {"id": "height", "default": 0.75}, {"id": "top", "default": 0.04}],
        "refs": [{"id": "far", "ref": "point", "at": ["width - 0.05", 0, "depth - 0.05"]}],
        "body": [
            {"id": "top", "item": "solid", "shape": "box",
             "min": [0, "height - top", 0], "max": ["width", "height", "depth"]},
            {"id": "leg_a", "item": "nested", "genus": "user.leg",
             "params": {"height": "height - top", "size": 0.05}},
            {"id": "leg_b", "item": "nested", "genus": "user.leg", "at": "far",
             "params": {"height": "height - top"}}
        ]}),
    );
}

#[test]
fn nested_children_are_bound_by_formulas() {
    let mut p = Project::new();
    define_leg_and_table(&mut p);
    let t = id(&exec(
        &mut p,
        json!({"op": "create_element", "component": "user.table", "points": [[0, 0, 0]],
               "params": {"height": 1.0}}),
    ));
    let v = volume(&p, &t);
    let expect = 1.2 * 0.8 * 0.04 + 2.0 * 0.05 * 0.05 * (1.0 - 0.04);
    assert!((v - expect).abs() < 1e-4, "volume {v} vs {expect}");
    let g = q(&p, json!({"op": "element_geometry", "id": t}));
    let max_y = g["bbox"]["max"][1].as_f64().unwrap();
    assert!((max_y - 1.0).abs() < 1e-4, "{g}");
    // Editing the child genus rebuilds the parent's instances.
    exec(
        &mut p,
        json!({"op": "set_genus_item", "genus": "user.leg", "item": {"id": "post", "item": "solid",
            "shape": "box", "min": [0, 0, 0], "max": ["size * 2", "height", "size * 2"]}}),
    );
    let v2 = volume(&p, &t);
    assert!(v2 > v + 1e-3, "leg change propagates: {v} -> {v2}");
}

#[test]
fn extends_overrides_adds_removes_with_provenance() {
    let mut p = Project::new();
    define_leg_and_table(&mut p);
    exec(
        &mut p,
        json!({"op": "define_genus", "id": "user.bench", "name": "Bench", "extends": "user.table",
            "params": [{"id": "depth", "default": 0.4}, {"id": "rail", "default": 0.03}],
            "remove": ["leg_b"],
            "body": [{"id": "rail_bar", "item": "solid", "shape": "box",
                "min": [0, 0.2, 0], "max": ["width", "0.2 + rail", "rail"]}]}),
    );
    let g = q(&p, json!({"op": "get_genus", "id": "user.bench"}));
    assert_eq!(g["trial_build"]["ok"], true, "{g}");
    let solids: Vec<&str> = g["trial_build"]["solids"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s.as_str().unwrap())
        .collect();
    assert!(
        solids.contains(&"top") && solids.contains(&"rail_bar"),
        "{solids:?}"
    );
    assert!(solids.iter().any(|s| s.starts_with("leg_a")), "{solids:?}");
    assert!(
        !solids.iter().any(|s| s.starts_with("leg_b")),
        "removed: {solids:?}"
    );
    let params = g["params"].as_array().unwrap();
    let find = |k: &str| params.iter().find(|x| x["id"] == k).unwrap().clone();
    assert_eq!(find("depth")["source"], "genus");
    assert_eq!(find("rail")["source"], "genus");
    assert_eq!(find("width")["source"], "inherited");
    assert_eq!(find("width")["from"], "user.table");

    let b = id(&exec(
        &mut p,
        json!({"op": "create_element", "component": "user.bench", "points": [[0, 0, 0]],
               "params": {"width": 2.0}}),
    ));
    let prov = q(&p, json!({"op": "param_provenance", "id": b}));
    let arr = prov.as_array().unwrap();
    let get = |k: &str| arr.iter().find(|x| x["id"] == k).unwrap().clone();
    assert_eq!(get("width")["source"], "instance");
    assert_eq!(get("height")["source"], "inherited");
    assert_eq!(get("depth")["source"], "genus");
    // Undo restores the bench-less, unchanged library.
    exec(&mut p, json!({"op": "undo"}));
    exec(&mut p, json!({"op": "undo"}));
    assert!(p
        .query_json(r#"{"op":"get_genus","id":"user.bench"}"#)
        .is_err());
}

#[test]
fn host_cut_punches_the_wall() {
    let mut p = Project::new();
    let wall = id(&exec(
        &mut p,
        json!({"op": "create_element", "component": "apex.wall", "points": [[0, 0, 0], [6, 0, 0]]}),
    ));
    let v0 = volume(&p, &wall);
    exec(
        &mut p,
        json!({"op": "define_genus", "id": "user.niche", "name": "Niche",
            "placement": {"kind": "host", "categories": ["wall"]},
            "params": [{"id": "width", "default": 1.0}, {"id": "height", "default": 1.0}],
            "body": [{"id": "hole", "item": "cut", "shape": "box",
                "min": [0, 0.5, "-host_depth"], "max": ["width", "0.5 + height", "host_depth"],
                "targets": {"host": true}}]}),
    );
    exec(
        &mut p,
        json!({"op": "create_element", "component": "user.niche", "points": [[2, 0, 0]], "parent": wall}),
    );
    let v1 = volume(&p, &wall);
    let g = q(&p, json!({"op": "element_geometry", "id": wall}));
    assert!(
        v0 - v1 > 0.15,
        "host cut removes ~1 m2 x thickness: {v0} -> {v1}"
    );
    assert_eq!(g["watertight"], true, "{g}");
}

#[test]
fn neighbour_cut_respects_category_filter() {
    let mut p = Project::new();
    let col = id(&exec(
        &mut p,
        json!({"op": "create_element", "component": "apex.column", "points": [[0, 0, 0]]}),
    ));
    let wall = id(&exec(
        &mut p,
        json!({"op": "create_element", "component": "apex.wall", "points": [[-3, 0, 3], [3, 0, 3]]}),
    ));
    let (vc, vw) = (volume(&p, &col), volume(&p, &wall));
    exec(
        &mut p,
        json!({"op": "define_genus", "id": "user.chase", "name": "Chase", "category": "mep",
        "body": [
            {"id": "pipe", "item": "solid", "shape": "box", "min": [-0.05, 0, -0.05], "max": [0.05, 0.1, 0.05]},
            {"id": "sleeve", "item": "cut", "shape": "box", "min": [-1, 0.5, -1], "max": [1, 1.0, 5],
             "targets": {"neighbours": ["column"]}}
        ]}),
    );
    exec(
        &mut p,
        json!({"op": "create_element", "component": "user.chase", "points": [[0, 0, 0]]}),
    );
    let (vc2, vw2) = (volume(&p, &col), volume(&p, &wall));
    assert!(vc2 < vc - 1e-3, "column is cut: {vc} -> {vc2}");
    assert!(
        (vw2 - vw).abs() < 1e-6,
        "wall is filtered out: {vw} -> {vw2}"
    );
}

#[test]
fn self_cut_removes_own_volume() {
    let mut p = Project::new();
    exec(
        &mut p,
        json!({"op": "define_genus", "id": "user.block", "name": "Block",
        "body": [
            {"id": "b", "item": "solid", "shape": "box", "min": [0, 0, 0], "max": [1, 1, 1]},
            {"id": "n", "item": "cut", "shape": "box", "min": [0.5, 0.5, -1], "max": [2, 2, 2],
             "targets": {"self": true}}
        ]}),
    );
    let b = id(&exec(
        &mut p,
        json!({"op": "create_element", "component": "user.block", "points": [[0, 0, 0]]}),
    ));
    let v = volume(&p, &b);
    assert!((v - 0.75).abs() < 1e-4, "self cut: {v}");
    let g = q(&p, json!({"op": "element_geometry", "id": b}));
    assert_eq!(g["watertight"], true, "{g}");
}

#[test]
fn nesting_and_extends_cycles_are_refused() {
    let mut p = Project::new();
    define_leg_and_table(&mut p);
    let err = p
        .execute_json(
            &json!({"op": "set_genus_item", "genus": "user.leg",
                "item": {"id": "loop", "item": "nested", "genus": "user.table"}})
            .to_string(),
        )
        .unwrap_err();
    assert!(err.0.to_lowercase().contains("cycle"), "{err}");
    exec(
        &mut p,
        json!({"op": "define_genus", "id": "user.a", "name": "A", "extends": "user.leg"}),
    );
    let err = p
        .execute_json(
            &json!({"op": "define_genus", "id": "user.leg", "name": "Leg", "extends": "user.a"})
                .to_string(),
        )
        .unwrap_err();
    assert!(err.0.to_lowercase().contains("cycle"), "{err}");
    let err = p
        .execute_json(
            &json!({"op": "define_genus", "id": "user.self", "name": "S",
                "body": [{"id": "me", "item": "nested", "genus": "user.self"}]})
            .to_string(),
        )
        .unwrap_err();
    assert!(!err.0.is_empty());
    // The library is unchanged after the refusals.
    let g = q(&p, json!({"op": "get_genus", "id": "user.leg"}));
    assert_eq!(g["trial_build"]["ok"], true, "{g}");
}

#[test]
fn old_project_without_genus_loads_and_window_builds_its_frame() {
    // A pre-genus snapshot: no `genus` field anywhere.
    let mut p = Project::new();
    let wall = id(&exec(
        &mut p,
        json!({"op": "create_element", "component": "apex.wall", "points": [[0, 0, 0], [6, 0, 0]]}),
    ));
    exec(
        &mut p,
        json!({"op": "create_element", "component": "apex.window", "points": [[2, 0, 0]], "parent": wall}),
    );
    let mut snap = serde_json::to_value(p.export_snapshot()).unwrap();
    // Built-ins are not saved; strip any genus body from saved definitions.
    if let Some(defs) = snap["components"].as_array_mut() {
        defs.iter_mut().for_each(strip_genus);
    }
    let text = snap.to_string();
    let mut loaded = Project::new();
    loaded
        .import_snapshot(serde_json::from_str(&text).unwrap())
        .unwrap();
    let v = q(&loaded, json!({"op": "validate"}));
    assert_eq!(v["ok"], true, "{v}");
    let g = q(&loaded, json!({"op": "get_genus", "id": "apex.window"}));
    let solids = g["trial_build"]["solids"].to_string();
    assert!(solids.contains("frame"), "{g}");
    let (bare, bare_wall) = new_wall_only();
    assert!(
        volume(&loaded, &wall) < volume(&bare, &bare_wall) - 0.1,
        "window still cuts"
    );
}

fn new_wall_only() -> (Project, String) {
    let mut p = Project::new();
    let w = exec(
        &mut p,
        json!({"op": "create_element", "component": "apex.wall", "points": [[0, 0, 0], [6, 0, 0]]}),
    );
    let w = id(&w);
    (p, w)
}

fn strip_genus(v: &mut Value) {
    if let Value::Object(m) = v {
        m.remove("genus");
    }
}

#[test]
fn user_genus_round_trips_through_a_snapshot() {
    let mut p = Project::new();
    define_leg_and_table(&mut p);
    exec(
        &mut p,
        json!({"op": "define_genus", "id": "user.bench", "name": "Bench", "extends": "user.table",
               "remove": ["leg_b"]}),
    );
    let t = id(&exec(
        &mut p,
        json!({"op": "create_element", "component": "user.bench", "points": [[0, 0, 0]]}),
    ));
    let v = volume(&p, &t);
    let text = serde_json::to_string(&p.export_snapshot()).unwrap();
    let mut loaded = Project::new();
    loaded
        .import_snapshot(serde_json::from_str(&text).unwrap())
        .unwrap();
    assert!((volume(&loaded, &t) - v).abs() < 1e-9);
    let g = q(&loaded, json!({"op": "get_genus", "id": "user.bench"}));
    assert_eq!(g["authored"]["extends"], "user.table", "{g}");
}

#[test]
fn genus_builds_are_deterministic() {
    let build = || {
        let mut p = Project::new();
        define_leg_and_table(&mut p);
        let wall = id(&exec(
            &mut p,
            json!({"op": "create_element", "component": "apex.wall", "points": [[0, 0, 0], [6, 0, 0]]}),
        ));
        exec(
            &mut p,
            json!({"op": "create_element", "component": "apex.window", "points": [[2, 0, 0]], "parent": wall}),
        );
        exec(
            &mut p,
            json!({"op": "create_element", "component": "user.table", "points": [[1, 0, 2]]}),
        );
        let doc = p.document();
        let mut out: Vec<(Vec<u32>, Vec<u32>)> = doc
            .elements()
            .filter_map(|e| doc.get_mesh(e.id))
            .map(|m| {
                (
                    m.positions.iter().map(|f| f.to_bits()).collect(),
                    m.indices.clone(),
                )
            })
            .collect();
        out.sort();
        out
    };
    let a = build();
    assert!(a.len() >= 3, "{}", a.len());
    assert_eq!(a, build(), "same commands give byte-identical meshes");
}

#[test]
fn window_frame_is_one_seamless_closed_solid() {
    let p = Project::new();
    let b = p
        .registry()
        .build_genus(
            "apex.window",
            &ParamMap::new(),
            GenusFrame::from_yaw(Vec3::ZERO, 0.0),
            0.3,
            1.0,
        )
        .unwrap();
    let frames: Vec<_> = b
        .solids
        .iter()
        .filter(|s| s.path.contains("frame"))
        .collect();
    assert_eq!(
        frames.len(),
        1,
        "one frame solid: {:?}",
        b.solids.iter().map(|s| &s.path).collect::<Vec<_>>()
    );
    let m = &frames[0].mesh;
    assert!(is_closed(m), "frame is closed (no seams between members)");
    assert!(mesh_volume(m) > 0.0);
    assert!(
        b.cuts.iter().any(|c| c.targets.host),
        "window cuts its host"
    );
}
