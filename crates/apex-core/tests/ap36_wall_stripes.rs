//! AP-36: wall-face sill/head stripes after join corner drag.
//!
//! Moving a house corner join-stretches peers into kinked polylines. Band-XOR
//! caps on those walls used to keep collinear outer-face detours past openings,
//! which #141 treated as sill/head creases — leaving triangle/CAD stripes on
//! the solid faces. Hosted openings must also reproject onto the stretched
//! centreline so frames stay on the wall.

use apex_core::Project;
use apex_geometry::TriangleMesh;
use serde_json::json;

mod support;
use support::*;

fn sample_like_house() -> (Project, String) {
    let mut p = Project::new();
    let s = id(&ex(
        &mut p,
        json!({"op":"create_element","component":"apex.wall","points":[[0,0,0],[10,0,0]]}),
    ));
    let e = id(&ex(
        &mut p,
        json!({"op":"create_element","component":"apex.wall","points":[[10,0,0],[10,0,8]]}),
    ));
    let n = id(&ex(
        &mut p,
        json!({"op":"create_element","component":"apex.wall","points":[[10,0,8],[0,0,8]]}),
    ));
    let w = id(&ex(
        &mut p,
        json!({"op":"create_element","component":"apex.wall","points":[[0,0,8],[0,0,0]]}),
    ));
    let _mid = id(&ex(
        &mut p,
        json!({"op":"create_element","component":"apex.wall","points":[[5,0,0],[5,0,8]]}),
    ));
    for (parent, x, z, door) in [
        (&s, 2.0, 0.0, true),
        (&s, 7.5, 0.0, false),
        (&w, 0.0, 4.0, false),
        (&n, 7.5, 8.0, false),
        (&n, 2.5, 8.0, false),
        (&e, 10.0, 2.0, false),
        (&e, 10.0, 6.0, false),
    ] {
        ex(
            &mut p,
            json!({
                "op":"create_element",
                "component": if door { "apex.door" } else { "apex.window" },
                "parent": parent,
                "points":[[x,0,z]]
            }),
        );
    }
    (p, w)
}

fn long_horiz_face_seams(mesh: &TriangleMesh) -> Vec<String> {
    let mut bad = Vec::new();
    for t in mesh.indices.chunks(3) {
        let p = |i: u32| {
            let k = i as usize * 3;
            [
                mesh.positions[k],
                mesh.positions[k + 1],
                mesh.positions[k + 2],
            ]
        };
        let (a, b, c) = (p(t[0]), p(t[1]), p(t[2]));
        for (u, v) in [(a, b), (b, c), (c, a)] {
            let dy = (u[1] - v[1]).abs();
            let len = ((u[0] - v[0]).hypot(u[2] - v[2])).hypot(dy);
            if dy > 1e-3 || len < 1.5 {
                continue;
            }
            let y = 0.5 * (u[1] + v[1]);
            if (y - 0.88).abs() > 0.05 && (y - 2.12).abs() > 0.05 && (y - 2.32).abs() > 0.05 {
                continue;
            }
            bad.push(format!(
                "y={y:.3} len={len:.3} ({:.3},{:.3},{:.3})->({:.3},{:.3},{:.3})",
                u[0], u[1], u[2], v[0], v[1], v[2]
            ));
        }
    }
    bad.sort();
    bad.dedup();
    bad
}

#[test]
fn openings_reproject_onto_join_stretched_host() {
    let (mut p, west) = sample_like_house();
    let south = p
        .document()
        .elements()
        .find(|e| {
            e.component_id == "apex.wall"
                && e.placement
                    .anchors()
                    .iter()
                    .any(|a| a.x.abs() < 0.05 && a.z.abs() < 0.05)
                && e.placement
                    .anchors()
                    .iter()
                    .any(|a| (a.x - 10.0).abs() < 0.05 && a.z.abs() < 0.05)
        })
        .map(|e| e.id)
        .expect("south");
    ex(
        &mut p,
        json!({"op":"move_elements","ids":[west],"delta":[-0.8,0.0,-0.8]}),
    );
    let south_el = p.document().get_element(south).unwrap();
    let anchors = south_el.placement.anchors();
    for child_id in p.document().children_of(south) {
        let child = p.document().get_element(child_id).unwrap();
        let o = child.placement.origin();
        let dist = anchors
            .windows(2)
            .map(|w| {
                let ab = w[1] - w[0];
                let ap = o - w[0];
                let t = (ap.dot(ab) / ab.length_squared()).clamp(0.0, 1.0);
                (w[0] + ab * t - o).length()
            })
            .fold(f32::MAX, f32::min);
        assert!(
            dist < 0.05,
            "{} left host centreline (dist={dist})",
            child.component_id
        );
    }
}

#[test]
fn four_wall_house_no_face_stripes_after_corner_drag() {
    let (mut p, west) = sample_like_house();
    assert!(
        p.document()
            .elements()
            .filter(|e| e.component_id == "apex.wall")
            .all(|e| long_horiz_face_seams(&p.closed_wall_solid(e.id).unwrap()).is_empty()),
        "unexpected stripes before move"
    );
    ex(
        &mut p,
        json!({"op":"move_elements","ids":[west],"delta":[-0.8,0.0,-0.8]}),
    );
    let after: Vec<_> = p
        .document()
        .elements()
        .filter(|e| e.component_id == "apex.wall")
        .filter_map(|e| {
            let bad = long_horiz_face_seams(&p.closed_wall_solid(e.id)?);
            (!bad.is_empty())
                .then(|| format!("{} anchors={:?}: {bad:?}", e.id, e.placement.anchors()))
        })
        .collect();
    assert!(
        after.is_empty(),
        "wall-face stripes after corner drag:\n{}",
        after.join("\n")
    );
}
