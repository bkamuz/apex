//! Phase 2 parity: every element type built through the exact SMLib kernel
//! against the mesh kernel (same volume, closed where the mesh is closed,
//! deterministic), plus the two-storey house (no invalid solids) and the
//! full-house rebuild time per kernel.

#[path = "support/scenes.rs"]
mod scenes;

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Instant;

use apex_core::{ElementId, Project};
use apex_geometry::{is_watertight, mesh_volume, TriangleMesh};
use apex_smlib::SmlibKernel;
use scenes::{ex, id, wall};
use serde_json::json;

fn meshes(p: &Project) -> BTreeMap<ElementId, (String, TriangleMesh)> {
    let doc = p.document();
    doc.elements()
        .filter_map(|e| Some((e.id, (e.component_id.clone(), doc.get_mesh(e.id)?.clone()))))
        .collect()
}

/// Opaque part of a mesh (glass and ghost normals are tagged, not unit).
fn opaque(m: &TriangleMesh) -> TriangleMesh {
    let mut out = TriangleMesh::empty();
    for t in m.indices.chunks(3) {
        let n = &m.normals[t[0] as usize * 3..t[0] as usize * 3 + 3];
        if ((n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt() - 1.0).abs() > 0.01 {
            continue;
        }
        let v = |i: u32| {
            let i = i as usize * 3;
            [m.positions[i], m.positions[i + 1], m.positions[i + 2]]
        };
        out.push_triangle(v(t[0]), v(t[1]), v(t[2]), [n[0], n[1], n[2]]);
    }
    out
}

/// Opaque volume with overlapping shells counted once (a mesh-kernel union),
/// so concatenated frame pieces compare with the exact union.
fn solid_volume(m: &TriangleMesh) -> f64 {
    let o = opaque(m);
    let shells = apex_geometry::split_shells(&o);
    let mut acc = TriangleMesh::empty();
    for s in shells {
        acc = apex_geometry::mesh_boolean(&acc, &s, apex_geometry::BooleanOp::Union)
            .unwrap_or_else(|_| {
                let mut a = acc.clone();
                a.append(&s);
                a
            });
    }
    mesh_volume(&acc) as f64
}

#[derive(Default, Debug)]
struct Report {
    elements: usize,
    compared: usize,
    closed_mesh: usize,
    closed_smlib: usize,
    mismatches: Vec<String>,
}

/// Build `scene` with the mesh kernel, switch to SMLib, compare per element.
fn parity(name: &str, scene: impl Fn() -> Project) -> Report {
    let mut p = scene();
    let before = meshes(&p);
    let v0 = p.query_json(&json!({"op":"validate"}).to_string()).unwrap();
    let mut shared = [TriangleMesh::empty(), TriangleMesh::empty()];
    p.set_kernel(Arc::new(SmlibKernel::default()));
    let after = meshes(&p);
    let mut r = Report::default();
    for (eid, (comp, old)) in &before {
        let Some((_, new)) = after.get(eid) else {
            continue;
        };
        r.elements += 1;
        if old.is_empty() {
            continue;
        }
        let oc = is_watertight(&opaque(old));
        let nc = is_watertight(&opaque(new));
        if !oc {
            // Joined walls render shares of one closed cluster union.
            shared[0].append(&opaque(old));
            shared[1].append(&opaque(new));
        }
        if oc {
            r.closed_mesh += 1;
            if nc {
                r.closed_smlib += 1;
            } else {
                r.mismatches
                    .push(format!("{name}/{comp}: smlib result not closed"));
            }
            let (vo, vn) = (solid_volume(old), solid_volume(new));
            r.compared += 1;
            if (vo - vn).abs() > 1e-3 * vo.abs().max(1.0) {
                r.mismatches
                    .push(format!("{name}/{comp}: volume mesh {vo:.6} smlib {vn:.6}"));
            }
        }
    }
    if !shared[0].is_empty() && apex_geometry::is_closed(&shared[0]) {
        r.compared += 1;
        let (vo, vn) = (
            mesh_volume(&shared[0]) as f64,
            mesh_volume(&shared[1]) as f64,
        );
        if !apex_geometry::is_closed(&shared[1]) {
            r.mismatches
                .push(format!("{name}: smlib join shares not closed"));
        }
        if (vo - vn).abs() > 1e-3 * vo.abs().max(1.0) {
            r.mismatches.push(format!(
                "{name}: joined walls volume mesh {vo:.6} smlib {vn:.6}"
            ));
        }
    }
    let v = p.query_json(&json!({"op":"validate"}).to_string()).unwrap();
    if v["errors"].as_u64() > v0["errors"].as_u64() {
        r.mismatches.push(format!("{name}: validate {v}"));
    }
    eprintln!(
        "{name}: {} elements, {} closed (mesh), {} closed (smlib), {} compared, {} mismatches",
        r.elements,
        r.closed_mesh,
        r.closed_smlib,
        r.compared,
        r.mismatches.len()
    );
    for m in &r.mismatches {
        eprintln!("  {m}");
    }
    r
}

fn frames() -> Project {
    let mut p = Project::new();
    let w = wall(&mut p, json!([[0, 0, 0], [8, 0, 0]]));
    for (c, x) in [
        ("apex.door", 1.5),
        ("apex.window", 4.0),
        ("apex.window", 6.5),
    ] {
        ex(
            &mut p,
            json!({"op":"create_element","component":c,"parent":w,"points":[[x,0,0]]}),
        );
    }
    p
}

fn genus_cuts() -> Project {
    let mut p = Project::new();
    let w = wall(&mut p, json!([[0, 0, 0], [6, 0, 0]]));
    ex(
        &mut p,
        json!({"op": "define_genus", "id": "user.niche", "name": "Niche",
            "placement": {"kind": "host", "categories": ["wall"]},
            "params": [{"id": "width", "default": 1.0}, {"id": "height", "default": 1.0}],
            "body": [{"id": "hole", "item": "cut", "shape": "box",
                "min": [0, 0.5, "-host_depth"], "max": ["width", "0.5 + height", "host_depth"],
                "targets": {"host": true}}]}),
    );
    ex(
        &mut p,
        json!({"op": "create_element", "component": "user.niche", "points": [[2, 0, 0]], "parent": w}),
    );
    ex(
        &mut p,
        json!({"op": "create_element", "component": "apex.column", "points": [[0, 0, 3]]}),
    );
    ex(
        &mut p,
        json!({"op": "define_genus", "id": "user.chase", "name": "Chase", "category": "mep",
        "body": [
            {"id": "pipe", "item": "solid", "shape": "box", "min": [-0.05, 0, -0.05], "max": [0.05, 0.1, 0.05]},
            {"id": "sleeve", "item": "cut", "shape": "box", "min": [-1, 0.5, -1], "max": [1, 1.0, 5],
             "targets": {"neighbours": ["column"]}}
        ]}),
    );
    ex(
        &mut p,
        json!({"op": "create_element", "component": "user.chase", "points": [[0, 0, 3]]}),
    );
    ex(
        &mut p,
        json!({"op": "define_genus", "id": "user.block", "name": "Block",
        "body": [
            {"id": "b", "item": "solid", "shape": "box", "min": [0, 0, 0], "max": [1, 1, 1]},
            {"id": "n", "item": "cut", "shape": "box", "min": [0.5, 0.5, -1], "max": [2, 2, 2],
             "targets": {"self": true}}
        ]}),
    );
    ex(
        &mut p,
        json!({"op": "create_element", "component": "user.block", "points": [[10, 0, 0]]}),
    );
    // Nested genera: a table of two legs.
    ex(
        &mut p,
        json!({"op": "define_genus", "id": "user.leg", "name": "Leg", "category": "furniture",
            "params": [{"id": "h", "default": 0.7}],
            "body": [{"id": "post", "item": "solid", "shape": "box", "min": [0, 0, 0], "max": [0.05, "h", 0.05]}]}),
    );
    ex(
        &mut p,
        json!({"op": "define_genus", "id": "user.table", "name": "Table", "category": "furniture",
        "params": [{"id": "len", "default": 1.2}],
        "body": [
            {"id": "top", "item": "solid", "shape": "box", "min": [0, 0.7, 0], "max": ["len", 0.75, 0.6]},
            {"id": "leg_a", "item": "nested", "genus": "user.leg"},
            {"id": "leg_b", "item": "nested", "genus": "user.leg", "offset": ["len - 0.05", 0, 0.55]}
        ]}),
    );
    ex(
        &mut p,
        json!({"op": "create_element", "component": "user.table", "points": [[12, 0, 0]]}),
    );
    p
}

fn slabs() -> Project {
    let mut p = Project::new();
    ex(
        &mut p,
        json!({"op":"create_element","component":"apex.slab","points":[[0,0,0],[6,0,0],[6,0,4],[0,0,4]]}),
    );
    let shaped = id(&ex(
        &mut p,
        json!({"op":"create_element","component":"apex.slab","points":[[8,0,0],[14,0,0],[14,0,4],[8,0,4]]}),
    ));
    ex(
        &mut p,
        json!({"op":"set_slab_shape","id":shaped,"shape":{"z":[0,0.6,0.3,0.1]}}),
    );
    ex(
        &mut p,
        json!({"op":"create_element","component":"apex.slab_opening","parent":shaped,"points":[[10,0,1],[11,0,1],[11,0,2],[10,0,2]]}),
    );
    let creased = id(&ex(
        &mut p,
        json!({"op":"create_element","component":"apex.slab","points":[[0,0,6],[6,0,6],[6,0,10],[0,0,10]]}),
    ));
    ex(
        &mut p,
        json!({"op":"set_slab_shape","id":creased,"shape":{"points":[[3,0.4,8]],"creases":[[0,4]]}}),
    );
    let holed = id(&ex(
        &mut p,
        json!({"op":"create_element","component":"apex.slab","points":[[8,0,6],[14,0,6],[14,0,10],[8,0,10]]}),
    ));
    ex(
        &mut p,
        json!({"op":"create_element","component":"apex.slab_opening","parent":holed,"points":[[9,0,7],[10,0,7],[10,0,8],[9,0,8]]}),
    );
    p
}

fn roofs() -> Project {
    let mut p = Project::new();
    ex(
        &mut p,
        json!({"op":"create_element","component":"apex.roof.pitched","points":[[0,0,4],[10,0,4]]}),
    );
    ex(
        &mut p,
        json!({"op":"create_element","component":"apex.roof.pitched","points":[[0,0,14],[10,0,14]],"params":{"roof_type":"hip","width":6,"overhang":0.5,"slope_by":"angle","pitch":0.5}}),
    );
    let r = id(&ex(
        &mut p,
        json!({"op":"create_element","component":"apex.roof.pitched","points":[[14,0,4],[24,0,4]],"params":{"overhang":0.6}}),
    ));
    ex(
        &mut p,
        json!({"op":"update_element","id":r,"params":{"eave_cut":"perpendicular"}}),
    );
    let h = id(&ex(
        &mut p,
        json!({"op":"create_element","component":"apex.roof.pitched","points":[[14,0,14],[24,0,14]],"params":{"overhang":0.4}}),
    ));
    ex(
        &mut p,
        json!({"op":"update_element","id":h,"params":{"eave_cut":"horizontal"}}),
    );
    p
}

fn attach() -> Project {
    let mut p = Project::new();
    let walls: Vec<String> = [
        json!([[0, 0, 0], [8, 0, 0], [8, 0, 6], [0, 0, 6], [0, 0, 0]]),
        json!([[4, 0, 0], [4, 0, 6]]),
    ]
    .into_iter()
    .map(|pts| wall(&mut p, pts))
    .collect();
    ex(
        &mut p,
        json!({"op":"create_element","component":"apex.roof.pitched","points":[[0,0,3],[8,0,3]],"params":{"width":6,"overhang":0.5}}),
    );
    ex(&mut p, json!({"op":"attach_top","ids":walls}));
    let ramp = id(&ex(
        &mut p,
        json!({"op":"create_element","component":"apex.slab","points":[[10,0,0],[16,0,0],[16,0,4],[10,0,4]]}),
    ));
    ex(
        &mut p,
        json!({"op":"set_slab_shape","id":ramp,"shape":{"z":[0,0.6,0.6,0]}}),
    );
    let w = wall(&mut p, json!([[11, 0, 2], [15, 0, 2]]));
    ex(
        &mut p,
        json!({"op":"attach_base","ids":[w],"targets":[ramp]}),
    );
    p
}

fn joins() -> Project {
    let mut p = Project::new();
    wall(&mut p, json!([[0, 0, 0], [6, 0, 0], [6, 0, 4]])); // L
    wall(&mut p, json!([[3, 0, 0], [3, 0, 3]])); // T
    wall(&mut p, json!([[10, 0, 0], [10, 0, 4]]));
    wall(&mut p, json!([[8, 0, 2], [12, 0, 2]])); // X
    p
}

type Scene = (&'static str, fn() -> Project);

const SCENES: &[Scene] = &[
    ("frames", frames),
    ("genus_cuts", genus_cuts),
    ("slabs", slabs),
    ("roofs", roofs),
    ("attach", attach),
    ("joins", joins),
    ("attached_joins", scenes::attached_joins),
    ("l_house", l_l_house),
    ("e2e_house", scenes::e2e_house),
];

fn l_l_house() -> Project {
    scenes::l_house(true)
}

#[test]
fn every_element_type_matches_the_mesh_kernel() {
    let mut bad = Vec::new();
    for (name, scene) in SCENES {
        let r = parity(name, scene);
        assert!(r.compared > 0, "{name}: nothing compared");
        bad.extend(r.mismatches);
    }
    assert!(bad.is_empty(), "{bad:#?}");
}

/// Bitwise fingerprint: component, positions, normals and indices. The
/// encoded kernel input is canonical (face grouping never depends on hash
/// order), so the exact path is held to bit-identical output.
type Print = (String, Vec<u32>, Vec<u32>, Vec<u32>);
fn fingerprint(p: &Project) -> Vec<Print> {
    let bits = |v: &[f32]| v.iter().map(|x| x.to_bits()).collect::<Vec<_>>();
    meshes(p)
        .into_values()
        .map(|(c, m)| (c, bits(&m.positions), bits(&m.normals), m.indices.clone()))
        .collect()
}

#[test]
fn smlib_builds_are_deterministic() {
    for (name, scene) in SCENES {
        let run = || {
            let mut p = scene();
            p.set_kernel(Arc::new(SmlibKernel::default()));
            let mut f = fingerprint(&p);
            f.sort();
            f
        };
        assert!(run() == run(), "{name}: smlib build differs between runs");
    }
}

#[test]
fn house_has_no_invalid_solids_and_rebuild_times() {
    let mut p = scenes::e2e_house();
    let n = p.document().elements().count();
    let all: Vec<ElementId> = p.document().elements().map(|e| e.id).collect();
    let t = Instant::now();
    p.reset_kernel();
    let mesh_ms = t.elapsed().as_secs_f64() * 1e3;
    let t = Instant::now();
    p.set_kernel(Arc::new(SmlibKernel::default()));
    let smlib_ms = t.elapsed().as_secs_f64() * 1e3;
    let v = p.query_json(&json!({"op":"validate"}).to_string()).unwrap();
    assert_eq!(v["errors"], 0, "{v}");
    let mut open = Vec::new();
    for id in &all {
        let e = p.document().get_element(*id).unwrap();
        let m = p.document().get_mesh(*id).unwrap();
        if !m.is_empty() && !is_watertight(&opaque(m)) {
            open.push(e.component_id.clone());
        }
    }
    eprintln!(
        "e2e house: {n} elements, full rebuild mesh {mesh_ms:.0} ms, smlib {smlib_ms:.0} ms; open (render-share) meshes: {open:?}"
    );
}

/// `APEX_DUMP=path cargo test --test kernel_scenes dump -- --ignored` writes
/// the two-storey house as a project file (for browser screenshots).
#[test]
#[ignore]
fn dump_house_snapshot() {
    let p = scenes::e2e_house();
    let path = std::env::var("APEX_DUMP").unwrap_or_else(|_| "e2e_house.json".into());
    std::fs::write(path, serde_json::to_string(&p.export_snapshot()).unwrap()).unwrap();
}

/// The browser path: an external kernel fed by a job pump must settle.
#[test]
fn external_kernel_settles_on_the_house() {
    for (name, scene) in SCENES {
        let mut p = scene();
        p.set_external_kernel();
        let mut rounds = 0;
        loop {
            let jobs = p.take_kernel_jobs();
            if jobs.is_empty() {
                break;
            }
            rounds += 1;
            if rounds > 40 {
                let ids: Vec<_> = p
                    .kernel_waiting_ids()
                    .into_iter()
                    .map(|id| p.document().get_element(id).map(|e| e.component_id.clone()))
                    .collect();
                panic!(
                    "{name}: still {} jobs after 40 rounds; waiting {:?}",
                    jobs.len(),
                    ids
                );
            }
            let results = jobs
                .iter()
                .map(|j| {
                    let r = apex_smlib::run(&j.solids, 1e-3).ok();
                    (j.key, r.map(|r| (r.points, r.tris)))
                })
                .collect();
            p.apply_kernel_results(results);
        }
        eprintln!("{name}: settled in {rounds} rounds");
    }
}

/// The browser path again, through the three benchmark edits: each must
/// return and the pump must settle afterwards.
#[test]
fn external_kernel_edits_settle() {
    fn pump(p: &mut Project) {
        for _ in 0..40 {
            let jobs = p.take_kernel_jobs();
            if jobs.is_empty() {
                return;
            }
            let results = jobs
                .iter()
                .map(|j| {
                    let r = apex_smlib::run(&j.solids, 1e-3).ok();
                    (j.key, r.map(|r| (r.points, r.tris)))
                })
                .collect();
            p.apply_kernel_results(results);
        }
        panic!("kernel did not settle");
    }
    let mut p = scenes::e2e_house();
    p.set_external_kernel();
    pump(&mut p);
    for e in house_edits(&p) {
        eprintln!("EDIT {e}");
        ex(&mut p, e);
        pump(&mut p);
    }
}

fn house_edits(p: &Project) -> Vec<serde_json::Value> {
    let find = |comp: &str, pick: &dyn Fn(&TriangleMesh) -> bool| {
        p.document()
            .elements()
            .filter(|e| e.component_id == comp)
            .find(|e| p.document().get_mesh(e.id).is_some_and(pick))
            .map(|e| e.id.to_string())
            .unwrap()
    };
    let mid = find("apex.wall", &|m| {
        m.aabb()
            .is_some_and(|(a, b)| b[0] - a[0] < 0.5 && a[0] > 4.0 && a[1] < 1.0)
    });
    let window = find("apex.window", &|_| true);
    let roof = find("apex.roof.pitched", &|_| true);
    vec![
        json!({"op":"move_elements","ids":[mid],"delta":[0.3,0,0]}),
        json!({"op":"set_element_species","id":window,"species":"apex.window.double-1500x1400"}),
        json!({"op":"update_element","id":roof,"params":{"overhang":0.7}}),
    ]
}

/// Before/after numbers for the performance phase: full load and three
/// edits per kernel, with the number of element rebuilds each one costs.
/// `cargo test --release -p apex-core --test kernel_scenes bench -- --ignored --nocapture`
#[test]
#[ignore]
fn bench_house_edits() {
    use apex_core::{element_build_ms, element_builds};
    for kernel in ["mesh", "smlib"] {
        let mut p = scenes::e2e_house();
        let t = Instant::now();
        let b0 = element_builds();
        if kernel == "smlib" {
            p.set_kernel(Arc::new(SmlibKernel::default()));
        } else {
            p.reset_kernel();
        }
        let full = (t.elapsed().as_secs_f64() * 1e3, element_builds() - b0);
        let find = |p: &Project, comp: &str, pick: &dyn Fn(&TriangleMesh) -> bool| {
            p.document()
                .elements()
                .filter(|e| e.component_id == comp)
                .find(|e| p.document().get_mesh(e.id).is_some_and(pick))
                .map(|e| e.id.to_string())
                .unwrap()
        };
        let mid = find(&p, "apex.wall", &|m| {
            m.aabb()
                .is_some_and(|(a, b)| b[0] - a[0] < 0.5 && a[0] > 4.0 && a[1] < 1.0)
        });
        let window = find(&p, "apex.window", &|_| true);
        let roof = find(&p, "apex.roof.pitched", &|_| true);
        let edits = [
            (
                "move wall",
                json!({"op":"move_elements","ids":[mid],"delta":[0.3,0,0]}),
            ),
            (
                "window species",
                json!({"op":"set_element_species","id":window,"species":"apex.window.double-1500x1400"}),
            ),
            (
                "roof overhang",
                json!({"op":"update_element","id":roof,"params":{"overhang":0.7}}),
            ),
        ];
        let mut out = vec![format!("full {:.0} ms / {} builds", full.0, full.1)];
        for (name, e) in edits {
            eprintln!("EDIT {kernel} {name}");
            let b0 = element_builds();
            let m0 = element_build_ms();
            let t = Instant::now();
            ex(&mut p, e);
            out.push(format!(
                "{name} {:.1} ms ({:.1} ms building) / {} builds",
                t.elapsed().as_secs_f64() * 1e3,
                element_build_ms() - m0,
                element_builds() - b0
            ));
        }
        let t = Instant::now();
        let buffers = p.document().build_scene_buffers();
        let tb = t.elapsed().as_secs_f64() * 1e3;
        let t = Instant::now();
        p.hide_buried_edges(&buffers.edge_positions);
        out.push(format!(
            "scene buffers {tb:.1} ms, buried edges {:.1} ms",
            t.elapsed().as_secs_f64() * 1e3
        ));
        eprintln!("BENCH {kernel}: {}", out.join("; "));
    }
}
