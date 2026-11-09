//! Mesh snapshots of the built-in window / door genera (every shipped
//! species), a user genus with self and neighbour cuts, and their plan
//! symbols, on both kernels. Recorded before the format v2 extensions
//! (show conditions, sweeps, materials, plan representation, dims): new,
//! optional fields must not change what existing genera build.
//!
//! On an intended geometry change, run with `APEX_PRINT_SNAPSHOTS=1` and
//! update the table.

use std::sync::Arc;

use apex_core::{opening_plan_symbols, Project, TriangleMesh};
use apex_smlib::SmlibKernel;
use serde_json::{json, Value};

fn ex(p: &mut Project, v: Value) -> Value {
    p.execute_json(&v.to_string())
        .unwrap_or_else(|e| panic!("{v}: {e}"))
}

fn id(v: &Value) -> String {
    v["id"].as_str().unwrap().to_string()
}

/// FNV-1a over quantised positions (0.1 mm), indices and edges.
fn digest(m: &TriangleMesh) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let mut eat = |v: i64| {
        for b in v.to_le_bytes() {
            h ^= b as u64;
            h = h.wrapping_mul(0x0100_0000_01b3);
        }
    };
    for p in &m.positions {
        eat((*p as f64 * 1e4).round() as i64);
    }
    for i in &m.indices {
        eat(*i as i64);
    }
    for e in &m.edges {
        eat((*e as f64 * 1e4).round() as i64);
    }
    h
}

fn scene() -> (Project, Vec<(String, String)>) {
    let mut p = Project::new();
    let wall = id(&ex(
        &mut p,
        json!({"op":"create_element","component":"apex.wall","points":[[0,0,0],[24,0,0]]}),
    ));
    let mut out = vec![("wall".to_string(), wall.clone())];
    let species = [
        ("apex.window", "apex.window.single-1200x1400"),
        ("apex.window", "apex.window.double-1500x1400"),
        ("apex.window", "apex.window.arched-900x1600"),
        ("apex.door", "apex.door.single-900x2100"),
        ("apex.door", "apex.door.double-1400x2100"),
        ("apex.door", "apex.door.transom-1000x2500"),
    ];
    for (k, (genus, sp)) in species.iter().enumerate() {
        let x = 2.0 + 3.5 * k as f64;
        let e = id(&ex(
            &mut p,
            json!({"op":"create_element","component":genus,"parent":wall,
                   "points":[[x,0,0]],"params":{"species":sp}}),
        ));
        out.push((sp.to_string(), e));
    }
    ex(
        &mut p,
        json!({"op": "define_genus", "id": "user.shelf", "name": "Shelf", "placement": {"kind": "point"},
            "params": [{"id": "width", "default": 1.2}, {"id": "depth", "default": 0.4}, {"id": "height", "default": 0.9}],
            "body": [{"id": "board", "item": "solid", "shape": "box", "min": [0, 0, 0], "max": ["width", "height", "depth"]},
                     {"id": "notch", "item": "cut", "shape": "box", "min": [0.2, 0.6, -0.1], "max": [0.5, 1.0, 0.5], "targets": {"self": true}},
                     {"id": "chase", "item": "cut", "shape": "box", "min": [0.8, 0, -0.2], "max": [1.0, "height", 0.6], "targets": {"neighbours": ["column"]}}]}),
    );
    let col = id(&ex(
        &mut p,
        json!({"op":"create_element","component":"apex.column","points":[[0.9,0,3.2]]}),
    ));
    let shelf = id(&ex(
        &mut p,
        json!({"op":"create_element","component":"user.shelf","points":[[0,0,3]]}),
    ));
    out.push(("column".into(), col));
    out.push(("user.shelf".into(), shelf));
    (p, out)
}

fn digests(p: &Project, ids: &[(String, String)]) -> Vec<(String, u64)> {
    let doc = p.document();
    let mut out: Vec<(String, u64)> = ids
        .iter()
        .map(|(name, eid)| {
            let e = doc
                .elements()
                .find(|e| e.id.to_string() == *eid)
                .expect("element");
            (name.clone(), digest(doc.get_mesh(e.id).expect("mesh")))
        })
        .collect();
    let mut sym = TriangleMesh::empty();
    for v in opening_plan_symbols(p, None) {
        sym.positions.extend_from_slice(&v.to_array());
    }
    out.push(("plan_symbols".into(), digest(&sym)));
    out
}

fn check(kernel: &str, got: &[(String, u64)], want: &[(&str, u64)]) {
    if std::env::var("APEX_PRINT_SNAPSHOTS").is_ok() {
        eprintln!("{kernel}:");
        for (n, d) in got {
            eprintln!("    (\"{n}\", 0x{d:016x}),");
        }
        return;
    }
    let mut bad = Vec::new();
    for ((n, d), (wn, wd)) in got.iter().zip(want) {
        assert_eq!(n, wn);
        if d != wd {
            bad.push(format!("{kernel}/{n}: 0x{d:016x} != 0x{wd:016x}"));
        }
    }
    assert_eq!(got.len(), want.len());
    assert!(bad.is_empty(), "genus meshes changed:\n{}", bad.join("\n"));
}

const MESH: &[(&str, u64)] = &[
    ("wall", 0x62b0bd3d8d4fd0b9),
    ("apex.window.single-1200x1400", 0x8e431d2f45101ed1),
    ("apex.window.double-1500x1400", 0xf136cb0e06b71b2d),
    // Empty on main before this change too (the arched species builds no
    // parts); kept so a fix shows up here.
    ("apex.window.arched-900x1600", 0xcbf29ce484222325),
    ("apex.door.single-900x2100", 0x3c3b5d6fa39cd4a0),
    ("apex.door.double-1400x2100", 0xa0b9d633bdf0f979),
    ("apex.door.transom-1000x2500", 0x8c63e5d98d4d99fd),
    ("column", 0x4a3e91cb34b83f82),
    ("user.shelf", 0x34a278a2957d6f78),
    ("plan_symbols", 0x59717f7857d6cd3c),
];
const SMLIB: &[(&str, u64)] = &[
    ("wall", 0x612db13bbcae3941),
    ("apex.window.single-1200x1400", 0x23ad7cec4ebff455),
    ("apex.window.double-1500x1400", 0xc8c59bd1a9714ad8),
    ("apex.window.arched-900x1600", 0xcbf29ce484222325),
    ("apex.door.single-900x2100", 0xfbaf5043ab440860),
    ("apex.door.double-1400x2100", 0x31842b45a60e39cd),
    ("apex.door.transom-1000x2500", 0x8426d03e61e6aa22),
    ("column", 0xd9ef6ec3e502a465),
    ("user.shelf", 0x60b9909c6c080ff5),
    ("plan_symbols", 0x59717f7857d6cd3c),
];

#[test]
fn builtin_and_user_genera_build_unchanged_on_the_mesh_kernel() {
    let (p, ids) = scene();
    check("mesh", &digests(&p, &ids), MESH);
}

#[test]
fn builtin_and_user_genera_build_unchanged_on_smlib() {
    let (mut p, ids) = scene();
    p.set_kernel(Arc::new(SmlibKernel::default()));
    check("smlib", &digests(&p, &ids), SMLIB);
}

#[test]
fn a_saved_project_reloads_to_the_same_meshes() {
    let (p, ids) = scene();
    let before = digests(&p, &ids);
    let snap = serde_json::to_string(&p.export_snapshot()).unwrap();
    let mut q = Project::new();
    q.import_snapshot(serde_json::from_str(&snap).unwrap())
        .unwrap();
    assert_eq!(digests(&q, &ids), before);
}
