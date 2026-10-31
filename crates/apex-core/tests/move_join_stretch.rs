//! House-sample Move / path-handle join stretch: T-junction mid vertices must
//! not kink hosts into acute spikes.

use apex_core::{ParamMap, Placement, Project};
use apex_geometry::Curve;
use glam::Vec3;

fn wall(p: &mut Project, a: Vec3, b: Vec3) -> apex_core::ElementId {
    p.create_element("apex.wall", Placement::line(a, b), ParamMap::new())
        .expect("wall")
}

fn curve_pts(p: &Project, id: apex_core::ElementId) -> Vec<Vec3> {
    let el = p.document().get_element(id).unwrap();
    match el.placement.curve().unwrap() {
        Curve::Line { a, b } => vec![*a, *b],
        Curve::Polyline { points } => points.clone(),
        other => panic!("unexpected {other:?}"),
    }
}

fn dump_walls(p: &Project, label: &str) {
    eprintln!("=== {label} ===");
    for el in p.document().elements() {
        if el.component_id != "apex.wall" {
            continue;
        }
        let c = el.placement.curve().unwrap();
        let pts: Vec<_> = match c {
            Curve::Line { a, b } => vec![*a, *b],
            Curve::Polyline { points } => points.clone(),
            _ => continue,
        };
        let fmt: Vec<_> = pts
            .iter()
            .map(|v| format!("({:.2},{:.2},{:.2})", v.x, v.y, v.z))
            .collect();
        eprintln!(
            "  {} join=({:.3},{:.3}) {}",
            el.id,
            el.join_start,
            el.join_end,
            fmt.join(" - ")
        );
    }
}

/// Colinear (within plan eps) — no acute kink.
fn assert_no_plan_kink(pts: &[Vec3], label: &str) {
    if pts.len() < 3 {
        return;
    }
    for i in 1..pts.len() - 1 {
        let a = pts[i - 1];
        let b = pts[i];
        let c = pts[i + 1];
        let ab = Vec3::new(b.x - a.x, 0.0, b.z - a.z);
        let bc = Vec3::new(c.x - b.x, 0.0, c.z - b.z);
        let ab_len = ab.length();
        let bc_len = bc.length();
        if ab_len < 1e-4 || bc_len < 1e-4 {
            continue;
        }
        let cos = ab.normalize().dot(bc.normalize());
        assert!(
            cos > 0.98,
            "{label}: acute/kinked polyline at {b:?} (cos={cos:.4}): {pts:?}"
        );
    }
}

/// House-sample L0 exterior as four walls + mid + cross (matches houseSample.ts).
fn house_l0(p: &mut Project) -> Vec<apex_core::ElementId> {
    let south = wall(p, Vec3::new(0.0, 0.0, 0.0), Vec3::new(10.0, 0.0, 0.0));
    let east = wall(p, Vec3::new(10.0, 0.0, 0.0), Vec3::new(10.0, 0.0, 8.0));
    let north = wall(p, Vec3::new(10.0, 0.0, 8.0), Vec3::new(0.0, 0.0, 8.0));
    let west = wall(p, Vec3::new(0.0, 0.0, 8.0), Vec3::new(0.0, 0.0, 0.0));
    let mid = wall(p, Vec3::new(5.0, 0.0, 0.0), Vec3::new(5.0, 0.0, 8.0));
    let cross = wall(p, Vec3::new(5.0, 0.0, 4.0), Vec3::new(10.0, 0.0, 4.0));
    vec![south, east, north, west, mid, cross]
}

#[test]
fn move_south_wall_keeps_orthogonal_peers() {
    let mut p = Project::new();
    let ids = house_l0(&mut p);
    dump_walls(&p, "before");
    let south = ids[0];
    let west = ids[3];
    let mid = ids[4];

    p.translate_elements(&[south], Vec3::new(0.0, 0.0, -2.0), true)
        .expect("translate");
    dump_walls(&p, "after south -2z");

    let south_pts = curve_pts(&p, south);
    for pt in &south_pts {
        assert!(
            (pt.z + 2.0).abs() < 1e-3,
            "south pts should be at z=-2, got {pt:?}"
        );
    }
    assert_no_plan_kink(&south_pts, "south");

    let west_pts = curve_pts(&p, west);
    let near = west_pts
        .iter()
        .min_by(|a, b| a.z.partial_cmp(&b.z).unwrap())
        .unwrap();
    let far = west_pts
        .iter()
        .max_by(|a, b| a.z.partial_cmp(&b.z).unwrap())
        .unwrap();
    assert!(
        (near.z + 2.0).abs() < 1e-3,
        "west near should follow south: {near:?}"
    );
    assert!((far.z - 8.0).abs() < 1e-3, "west far should stay: {far:?}");
    assert!(
        west_pts.iter().all(|pt| pt.x.abs() < 1e-3),
        "west should stay on x=0: {west_pts:?}"
    );

    let mid_pts = curve_pts(&p, mid);
    let mid_near = mid_pts
        .iter()
        .min_by(|a, b| a.z.partial_cmp(&b.z).unwrap())
        .unwrap();
    assert!(
        (mid_near.z + 2.0).abs() < 1e-3,
        "mid T tip should follow: {mid_near:?}"
    );
    assert!(
        mid_pts.iter().all(|pt| (pt.x - 5.0).abs() < 1e-3),
        "mid stay x=5: {mid_pts:?}"
    );
}

#[test]
fn move_west_wall_keeps_orthogonal_peers() {
    let mut p = Project::new();
    let ids = house_l0(&mut p);
    let west = ids[3];
    p.translate_elements(&[west], Vec3::new(-2.0, 0.0, 0.0), true)
        .expect("translate");
    dump_walls(&p, "after west -2x");

    for el in p.document().elements() {
        if el.component_id != "apex.wall" {
            continue;
        }
        let pts = match el.placement.curve().unwrap() {
            Curve::Line { a, b } => vec![*a, *b],
            Curve::Polyline { points } => points.clone(),
            _ => continue,
        };
        assert_no_plan_kink(&pts, &format!("wall {}", el.id));
    }
}

#[test]
fn move_mid_partition_does_not_spike_hosts() {
    let mut p = Project::new();
    let ids = house_l0(&mut p);
    let mid = ids[4];
    let south = ids[0];
    let north = ids[2];
    p.translate_elements(&[mid], Vec3::new(0.0, 0.0, -2.0), true)
        .expect("translate mid");
    dump_walls(&p, "after mid translate -2z");

    let south_pts = curve_pts(&p, south);
    let north_pts = curve_pts(&p, north);
    assert_no_plan_kink(&south_pts, "south");
    assert_no_plan_kink(&north_pts, "north");
    // Hosts stay on their original plan lines (no yanked T mid).
    assert!(
        south_pts.iter().all(|pt| pt.z.abs() < 1e-3),
        "south must stay at z=0, got {south_pts:?}"
    );
    assert!(
        north_pts.iter().all(|pt| (pt.z - 8.0).abs() < 1e-3),
        "north must stay at z=8, got {north_pts:?}"
    );
}

#[test]
fn move_mid_partition_perpendicular_slides_on_hosts() {
    let mut p = Project::new();
    let ids = house_l0(&mut p);
    let mid = ids[4];
    p.translate_elements(&[mid], Vec3::new(1.0, 0.0, 0.0), true)
        .expect("translate mid");
    dump_walls(&p, "after mid +1x");

    let mid_pts = curve_pts(&p, mid);
    assert!(
        mid_pts.iter().all(|pt| (pt.x - 6.0).abs() < 1e-3),
        "mid should translate in X: {mid_pts:?}"
    );
    let south = curve_pts(&p, ids[0]);
    assert_no_plan_kink(&south, "south");
    assert!(
        south.iter().all(|pt| pt.z.abs() < 1e-3),
        "south stays flat: {south:?}"
    );
}

#[test]
fn endpoint_edit_on_t_split_host_remaps_interior() {
    let mut p = Project::new();
    let ids = house_l0(&mut p);
    let south = ids[0];
    let pts = curve_pts(&p, south);
    assert!(pts.len() >= 3, "expected T-split south, got {pts:?}");

    let placement = p
        .placement_from_element_anchors(
            south,
            &[Vec3::new(0.0, 0.0, -2.0), Vec3::new(10.0, 0.0, -2.0)],
            0.0,
        )
        .expect("endpoint edit");
    p.update_element(south, None, Some(placement), true)
        .expect("commit");
    dump_walls(&p, "after endpoint-only edit");

    let after = curve_pts(&p, south);
    assert!(after.len() >= 3, "T interior preserved: {after:?}");
    assert_no_plan_kink(&after, "south after endpoint edit");
    assert!(
        after.iter().all(|pt| (pt.z + 2.0).abs() < 1e-3),
        "whole chord at z=-2: {after:?}"
    );
}
