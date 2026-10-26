//! Walls attached to a roof still join: the joined cluster renders as one
//! closed solid (each wall clipped to its own roof), with no internal faces
//! and a merged plan outline.
use apex_core::{mesh_section_loops, Project};
use apex_geometry::{is_closed, mesh_volume, TriangleMesh};
use serde_json::{json, Value};

fn ex(p: &mut Project, v: Value) -> Value {
    p.execute_json(&v.to_string()).unwrap()
}
fn wall(p: &mut Project, pts: Value, params: Value) -> String {
    ex(
        p,
        json!({"op":"create_element","component":"apex.wall","points":pts,"params":params}),
    )["id"]
        .as_str()
        .unwrap()
        .to_string()
}
fn hip(p: &mut Project, a: [f64; 2], b: [f64; 2], width: f64) {
    ex(
        p,
        json!({"op":"create_element","component":"apex.roof.pitched","points":[[a[0],0,a[1]],[b[0],0,b[1]]],"params":{"roof_type":"hip","width":width,"overhang":0.5,"slope_by":"angle","pitch":0.5}}),
    );
}
fn mesh(p: &Project, id: &str) -> TriangleMesh {
    p.document().get_mesh(id.parse().unwrap()).unwrap().clone()
}
fn area(m: &TriangleMesh) -> f64 {
    m.indices
        .chunks(3)
        .map(|t| {
            let v = |i: u32| {
                let k = i as usize * 3;
                glam::DVec3::new(
                    m.positions[k] as f64,
                    m.positions[k + 1] as f64,
                    m.positions[k + 2] as f64,
                )
            };
            (v(t[1]) - v(t[0])).cross(v(t[2]) - v(t[0])).length() * 0.5
        })
        .sum()
}
fn combined(p: &Project, ids: &[String]) -> TriangleMesh {
    let mut all = TriangleMesh::empty();
    for id in ids {
        all.append(&mesh(p, id));
    }
    all
}

/// Checks shared by every case: the walls render one closed solid with
/// the volume of their clipped pieces, the shared faces are gone (less
/// surface than the separate pieces), each wall's top follows its own
/// roof, and the plan cut is `loops` outlines with no internal segment.
fn check(p: &Project, ids: &[String], loops: usize, cut_y: f32) {
    let all = combined(p, ids);
    assert!(is_closed(&all), "cluster not closed");
    let v = p.query_json(&json!({"op":"validate"}).to_string()).unwrap();
    assert_eq!(v["errors"], 0, "{v}");
    let pieces: Vec<TriangleMesh> = ids
        .iter()
        .map(|id| {
            p.closed_wall_solid(id.parse().unwrap())
                .expect("closed piece")
        })
        .collect();
    let sum_vol: f64 = pieces.iter().map(mesh_volume).sum();
    let vol = mesh_volume(&all);
    assert!(
        (vol - sum_vol).abs() < 1e-3 * sum_vol.max(1.0),
        "volume {vol} vs pieces {sum_vol}"
    );
    let sum_area: f64 = pieces.iter().map(area).sum();
    assert!(
        area(&all) < sum_area - 0.05,
        "internal faces kept: {} vs {sum_area}",
        area(&all)
    );
    for m in &pieces {
        assert!(is_closed(m));
    }
    let sec = mesh_section_loops(&all, cut_y);
    assert_eq!(sec.len(), loops, "plan outline loops: {sec:?}");
}

#[test]
fn l_join_two_attached_walls_under_hip_roof() {
    let mut p = Project::new();
    let a = wall(&mut p, json!([[0, 0, 0], [8, 0, 0]]), json!({}));
    let b = wall(&mut p, json!([[8, 0, 0], [8, 0, 5]]), json!({}));
    hip(&mut p, [0.0, 2.5], [8.0, 2.5], 5.0);
    ex(&mut p, json!({"op":"attach_top","ids":[a,b]}));
    check(&p, &[a.clone(), b.clone()], 1, 1.2);
    // Hip: both walls stay under the eave line plus a little rise.
    for id in [&a, &b] {
        let top = mesh(&p, id)
            .positions
            .chunks(3)
            .map(|v| v[1])
            .fold(f32::MIN, f32::max);
        assert!(top < 3.5, "{top}");
    }
}

#[test]
fn t_join_attached_and_unattached() {
    let mut p = Project::new();
    let host = wall(&mut p, json!([[0, 0, 0], [8, 0, 0]]), json!({}));
    let stem = wall(&mut p, json!([[4, 0, 0], [4, 0, 5]]), json!({}));
    hip(&mut p, [0.0, 2.5], [8.0, 2.5], 5.0);
    // Only the stem rises into the roof: it is taller than the host at the
    // junction, so the host's side face stays exposed above the host.
    ex(&mut p, json!({"op":"attach_top","ids":[stem]}));
    check(&p, &[host.clone(), stem.clone()], 1, 1.2);
    let top = mesh(&p, &stem)
        .positions
        .chunks(3)
        .map(|v| v[1])
        .fold(f32::MIN, f32::max);
    assert!(top > 3.2, "stem not raised: {top}");
    // And the other way round.
    let mut p = Project::new();
    let host = wall(&mut p, json!([[0, 0, 0], [8, 0, 0]]), json!({}));
    let stem = wall(&mut p, json!([[4, 0, 0], [4, 0, 5]]), json!({}));
    hip(&mut p, [0.0, 2.5], [8.0, 2.5], 5.0);
    ex(&mut p, json!({"op":"attach_top","ids":[host]}));
    check(&p, &[host, stem], 1, 1.2);
}

#[test]
fn x_join_attached_walls() {
    let mut p = Project::new();
    let a = wall(&mut p, json!([[0, 0, 2.5], [8, 0, 2.5]]), json!({}));
    let b = wall(&mut p, json!([[4, 0, -1], [4, 0, 6]]), json!({}));
    hip(&mut p, [0.0, 2.5], [8.0, 2.5], 6.0);
    ex(&mut p, json!({"op":"attach_top","ids":[a,b]}));
    check(&p, &[a, b], 1, 1.2);
}

#[test]
fn different_thicknesses_attached() {
    let mut p = Project::new();
    let t = ex(
        &mut p,
        json!({"op":"create_wall_type","name":"Thick 400","thickness":0.4}),
    );
    let prof = t["profile"].as_str().unwrap();
    let a = wall(
        &mut p,
        json!([[0, 0, 0], [8, 0, 0]]),
        json!({"profile":prof}),
    );
    let b = wall(&mut p, json!([[8, 0, 0], [8, 0, 5]]), json!({}));
    let c = wall(&mut p, json!([[4, 0, 0], [4, 0, 5]]), json!({}));
    hip(&mut p, [0.0, 2.5], [8.0, 2.5], 5.0);
    ex(&mut p, json!({"op":"attach_top","ids":[a,b]}));
    check(&p, &[a, b, c], 1, 1.2);
}

#[test]
fn closed_rectangle_under_hip_roof_is_one_ring_pair() {
    let mut p = Project::new();
    let mut ids = vec![];
    for pts in [
        json!([[0, 0, 0], [8, 0, 0]]),
        json!([[8, 0, 0], [8, 0, 5]]),
        json!([[8, 0, 5], [0, 0, 5]]),
        json!([[0, 0, 5], [0, 0, 0]]),
        json!([[4, 0, 0], [4, 0, 5]]),
    ] {
        ids.push(wall(&mut p, pts, json!({})));
    }
    hip(&mut p, [0.0, 2.5], [8.0, 2.5], 5.0);
    ex(&mut p, json!({"op":"attach_top","ids":ids[..4]}));
    // Outer ring + two room holes.
    check(&p, &ids, 3, 1.2);
}
