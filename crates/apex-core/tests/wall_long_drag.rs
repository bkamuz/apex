//! A wall end dragged far enough to fold a joined corner used to abort the
//! process inside the plan triangulation (`bulk_load_cdt` panics on the
//! retraced mitre spike). The rebuild has to finish with a real solid on
//! both kernels.

use std::sync::Arc;

use apex_core::{ParamMap, Placement, Project};
use apex_geometry::{mesh_volume, TriangleMesh};
use apex_smlib::SmlibKernel;
use glam::Vec3;

fn wall(p: &mut Project, a: Vec3, b: Vec3) -> apex_core::ElementId {
    p.create_element("apex.wall", Placement::line(a, b), ParamMap::new())
        .expect("wall")
}

fn anchors(p: &Project, id: apex_core::ElementId) -> Vec<Vec3> {
    p.document().get_element(id).unwrap().placement.anchors()
}

fn l_corner() -> (Project, apex_core::ElementId) {
    let mut p = Project::new();
    let south = wall(&mut p, Vec3::new(0.0, 0.0, 0.0), Vec3::new(6.0, 0.0, 0.0));
    wall(&mut p, Vec3::new(6.0, 0.0, 0.0), Vec3::new(6.0, 0.0, 4.0));
    (p, south)
}

fn commit(p: &mut Project, id: apex_core::ElementId, points: &[Vec3]) {
    let placement = p
        .placement_from_element_anchors(id, points, 0.0)
        .expect("placement");
    p.update_element(id, None, Some(placement), true)
        .expect("rebuild");
}

fn has_cap(mesh: &TriangleMesh) -> bool {
    mesh.indices.chunks(3).any(|tri| {
        let p = |i: u32| {
            let k = i as usize * 3;
            [
                mesh.positions[k] as f64,
                mesh.positions[k + 1] as f64,
                mesh.positions[k + 2] as f64,
            ]
        };
        let (a, b, c) = (p(tri[0]), p(tri[1]), p(tri[2]));
        let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        let v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        let n = [
            u[1] * v[2] - u[2] * v[1],
            u[2] * v[0] - u[0] * v[2],
            u[0] * v[1] - u[1] * v[0],
        ];
        let len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
        len > 1e-8 && n[1].abs() > 0.9 * len
    })
}

fn assert_walls(p: &Project, label: &str) {
    let mut walls = 0;
    for el in p.document().elements() {
        if el.component_id != "apex.wall" {
            continue;
        }
        walls += 1;
        let mesh = p.document().get_mesh(el.id).expect("mesh");
        assert!(
            mesh.positions.iter().all(|v| v.is_finite()),
            "{label} non-finite"
        );
        assert!(
            mesh.indices.len() >= 12,
            "{label} mesh too small ({} tris)",
            mesh.indices.len() / 3
        );
        assert!(has_cap(mesh), "{label} missing cap");
        let vol = mesh_volume(mesh).abs();
        assert!(vol > 0.05, "{label} volume {vol}");
    }
    assert!(walls >= 2, "{label} lost a wall");
}

#[test]
fn drag_wall_end_twelve_metres_rebuilds() {
    // Straight 12 m extension of the free end.
    let (mut mesh_p, south) = l_corner();
    let mut pts = anchors(&mesh_p, south);
    let end = pts.len() - 1;
    pts[end].x += 12.0;
    commit(&mut mesh_p, south, &pts);
    assert_walls(&mesh_p, "mesh +12m");

    let (mut exact, south) = l_corner();
    exact.set_kernel(Arc::new(SmlibKernel::default()));
    let mut pts = anchors(&exact, south);
    let end = pts.len() - 1;
    pts[end].x += 12.0;
    commit(&mut exact, south, &pts);
    assert_walls(&exact, "smlib +12m");

    // The fold that used to panic: corner pulled ~12 m southwest, both kernels.
    let to = Vec3::new(-2.485282, 0.0, -8.485281);
    for (label, kernel) in [("mesh fold", false), ("smlib fold", true)] {
        let (mut p, south) = l_corner();
        if kernel {
            p.set_kernel(Arc::new(SmlibKernel::default()));
        }
        let mut pts = anchors(&p, south);
        let end = pts.len() - 1;
        pts[end] = to;
        commit(&mut p, south, &pts);
        assert_walls(&p, label);
    }

    // Same fold with a window, so the exact kernel actually subtracts a void.
    let (mut cut, south) = l_corner();
    cut.create_element_with_parent(
        "apex.window",
        Placement::point(Vec3::new(3.0, 1.2, 0.0)),
        ParamMap::new(),
        Some(south),
    )
    .expect("window");
    cut.set_kernel(Arc::new(SmlibKernel::default()));
    let mut pts = anchors(&cut, south);
    let end = pts.len() - 1;
    pts[end] = to;
    commit(&mut cut, south, &pts);
    assert_walls(&cut, "smlib window fold");

    // Sweep the 12 m circle. Every heading has to rebuild.
    for i in 0..24 {
        let ang = i as f32 * std::f32::consts::TAU / 24.0;
        let to = Vec3::new(6.0 + 12.0 * ang.cos(), 0.0, 12.0 * ang.sin());
        let (mut p, south) = l_corner();
        let mut pts = anchors(&p, south);
        let end = pts.len() - 1;
        pts[end] = to;
        commit(&mut p, south, &pts);
        assert_walls(&p, "sweep");
    }

    // Drag preview stays on the recipe mesh. Time it on the fold that
    // used to crash the commit.
    let (p, south) = l_corner();
    let mut pts = anchors(&p, south);
    let end = pts.len() - 1;
    pts[end] = to;
    let placement = p
        .placement_from_element_anchors(south, &pts, 0.0)
        .expect("preview placement");
    let _ = p.preview_path_anchor_edit(south, &placement).expect("warm");
    let n = 100u32;
    let t0 = std::time::Instant::now();
    for _ in 0..n {
        p.preview_path_anchor_edit(south, &placement).unwrap();
    }
    let ms = t0.elapsed().as_secs_f64() * 1000.0 / f64::from(n);
    eprintln!("folded-corner drag preview: {ms:.3} ms/edit");
    assert!(ms < 2.0, "preview regressed to {ms:.3} ms");
}
