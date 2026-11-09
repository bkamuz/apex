//! The exact SMLib kernel against the mesh kernel on walls with hosted
//! openings: same volume, closed result, deterministic output.

use std::sync::Arc;

use apex_core::{ElementId, ParamMap, ParamValue, Placement, Project};
use apex_geometry::{is_watertight, mesh_volume, TriangleMesh};
use apex_smlib::SmlibKernel;
use glam::Vec3;

fn wall_with(project: &mut Project, openings: &[(&str, f32, f32, f32)]) -> ElementId {
    let wall = project
        .create_element(
            "apex.wall",
            Placement::line(Vec3::ZERO, Vec3::new(6.0, 0.0, 0.0)),
            ParamMap::new(),
        )
        .expect("wall");
    for &(kind, x, w, h) in openings {
        project
            .create_element_with_parent(
                kind,
                Placement::point(Vec3::new(x, 0.0, 0.0)),
                ParamMap::new()
                    .with("width", ParamValue::Length(w as f64))
                    .with("height", ParamValue::Length(h as f64)),
                Some(wall),
            )
            .expect("opening");
    }
    wall
}

fn mesh(project: &Project, id: ElementId) -> TriangleMesh {
    project.document().get_mesh(id).expect("mesh").clone()
}

fn both(openings: &[(&str, f32, f32, f32)]) -> (TriangleMesh, TriangleMesh) {
    let mut p = Project::new();
    let wall = wall_with(&mut p, openings);
    let old = mesh(&p, wall);
    p.set_kernel(Arc::new(SmlibKernel::default()));
    assert_eq!(p.kernel_name(), "smlib");
    (old, mesh(&p, wall))
}

const CASES: &[&[(&str, f32, f32, f32)]] = &[
    &[("apex.door", 1.5, 1.0, 2.1)],
    &[("apex.window", 3.0, 1.2, 1.4)],
    &[
        ("apex.door", 1.0, 0.9, 2.1),
        ("apex.window", 3.2, 1.2, 1.4),
        ("apex.window", 5.0, 0.8, 1.2),
    ],
];

#[test]
fn smlib_host_cuts_match_mesh_volume_and_are_closed() {
    for case in CASES {
        let (old, exact) = both(case);
        let (vo, ve) = (mesh_volume(&old), mesh_volume(&exact));
        assert!(
            (vo - ve).abs() < 1e-3 * vo.abs().max(1.0),
            "{case:?}: mesh {vo} vs smlib {ve}"
        );
        assert!(is_watertight(&exact), "{case:?}: smlib result not closed");
        assert!(exact.triangle_count() > 0);
        eprintln!(
            "{case:?}: volume mesh {vo:.6} smlib {ve:.6}, tris {} vs {}",
            old.triangle_count(),
            exact.triangle_count()
        );
    }
}

#[test]
fn smlib_host_cuts_are_deterministic() {
    for case in CASES {
        let (_, a) = both(case);
        let (_, b) = both(case);
        assert_eq!(a.positions, b.positions, "{case:?}");
        assert_eq!(a.indices, b.indices, "{case:?}");
    }
}

#[test]
fn reset_restores_the_mesh_kernel_result() {
    let mut p = Project::new();
    let wall = wall_with(&mut p, CASES[2]);
    let old = mesh(&p, wall);
    p.set_kernel(Arc::new(SmlibKernel::default()));
    p.reset_kernel();
    assert_eq!(p.kernel_name(), "mesh");
    let back = mesh(&p, wall);
    assert_eq!(old.positions, back.positions);
}

#[test]
fn external_kernel_round_trip_matches_native() {
    let mut p = Project::new();
    let wall = wall_with(&mut p, CASES[2]);
    let before = mesh(&p, wall);
    p.set_external_kernel();
    // Pending: the mesh path stays in place until results arrive.
    assert_eq!(mesh(&p, wall).positions, before.positions);
    let jobs = p.take_kernel_jobs();
    assert!(!jobs.is_empty());
    assert_eq!(p.kernel_status().pending, jobs.len());
    // Chained booleans (cut, then the body's exact union) settle over a
    // few rounds, like the browser's job pump.
    let mut jobs = jobs;
    let mut rebuilt = Vec::new();
    for _ in 0..8 {
        if jobs.is_empty() {
            break;
        }
        let (results, stale) = apex_core::run_job_chain(jobs.clone(), |s| {
            apex_smlib::run(s, 1e-3).ok().map(|r| (r.points, r.tris))
        });
        rebuilt.extend(p.apply_kernel_results_chained(results, stale));
        jobs = p.take_kernel_jobs();
    }
    assert!(rebuilt.contains(&wall));
    assert_eq!(p.kernel_status().pending, 0);
    let ext = mesh(&p, wall);
    assert!(is_watertight(&ext));

    let mut q = Project::new();
    let w2 = wall_with(&mut q, CASES[2]);
    q.set_kernel(Arc::new(SmlibKernel::default()));
    let native = mesh(&q, w2);
    assert!((mesh_volume(&ext) - mesh_volume(&native)).abs() < 1e-6);
}

/// Terrain on the SMLib kernel looks like on the mesh kernel: a smooth
/// toposurface, not a B-rep with one face (and one drawn edge) per triangle.
#[test]
fn smlib_terrain_keeps_toposurface_lines_and_smooth_normals() {
    let mut p = Project::new();
    let placement = apex_core::PlacementKind::Polyline
        .build(
            &[
                Vec3::new(0.0, 0.0, 0.0),
                Vec3::new(20.0, 0.0, 0.0),
                Vec3::new(20.0, 0.0, 16.0),
                Vec3::new(0.0, 0.0, 16.0),
            ],
            0.0,
            &apex_geometry::Frame::horizontal(0.0),
        )
        .expect("terrain poly");
    let terrain = p
        .create_element(
            "apex.terrain",
            placement,
            ParamMap::new()
                .with("contour_interval", ParamValue::Length(0.5))
                .with("major_contour_interval", ParamValue::Length(2.5)),
        )
        .expect("terrain");
    p.set_slab_shape(
        terrain,
        &apex_core::SlabShape {
            z: vec![0.0, 1.0, 6.0, 2.0],
            points: vec![[8.0, 7.0, 4.2], [14.0, 4.0, 0.6]],
            creases: vec![],
        },
    )
    .expect("grade");
    let old = mesh(&p, terrain);
    p.set_kernel(Arc::new(SmlibKernel::default()));
    assert_eq!(p.kernel_name(), "smlib");
    let exact = mesh(&p, terrain);
    assert!(is_watertight(&exact));
    assert_eq!(
        exact.edge_count(),
        old.edge_count(),
        "same outline + major contours"
    );
    assert_eq!(
        exact.minor_edge_count(),
        old.minor_edge_count(),
        "minor contours kept"
    );
    assert_eq!(exact.triangle_count(), old.triangle_count());
    assert!((mesh_volume(&exact) - mesh_volume(&old)).abs() < 1e-3);
}
