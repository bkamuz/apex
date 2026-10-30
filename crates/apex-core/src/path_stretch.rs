//! Connected stretch for joinable path components.
//!
//! When a joinable path moves, peers that share endpoints (or T-junction
//! vertices) keep those shared vertices attached — far ends stay put so the
//! neighbour stretches. Pure geometry planning; Project applies the updates.

use apex_geometry::{plan_distance, Curve, JOIN_SNAP, MIN_CURVE_LENGTH};
use glam::Vec3;

use crate::element::ElementId;
use crate::path_join::JoinableSegment;
use crate::path_snap::curve_control_points;
use crate::placement::Placement;

/// One peer (or mover) placement rewrite from a stretch pass.
#[derive(Debug, Clone)]
pub struct StretchUpdate {
    pub id: ElementId,
    pub placement: Placement,
}

/// Plan-distance coincidence for shared vertices (same as path joins).
pub use apex_geometry::JOIN_SNAP as STRETCH_SNAP;

/// Apply vertex moves to a curve. Returns `None` when nothing changed or the
/// result would be degenerate.
pub fn apply_vertex_moves(curve: &Curve, moves: &[(Vec3, Vec3)], snap: f32) -> Option<Curve> {
    if moves.is_empty() {
        return None;
    }
    let map_point = |p: Vec3| -> Vec3 {
        for (from, to) in moves {
            if plan_distance(p, *from) <= snap {
                return *to;
            }
        }
        p
    };
    let next = match curve {
        Curve::Line { a, b } => {
            let na = map_point(*a);
            let nb = map_point(*b);
            if plan_distance(na, *a) <= 1e-9 && plan_distance(nb, *b) <= 1e-9 {
                return None;
            }
            Curve::Line { a: na, b: nb }
        }
        Curve::Polyline { points } => {
            let mut changed = false;
            let mapped: Vec<Vec3> = points
                .iter()
                .map(|p| {
                    let q = map_point(*p);
                    if plan_distance(q, *p) > 1e-9 {
                        changed = true;
                    }
                    q
                })
                .collect();
            if !changed {
                return None;
            }
            Curve::Polyline { points: mapped }
        }
        Curve::Arc { .. } | Curve::Circle { .. } => return None,
    };
    if next.length() < MIN_CURVE_LENGTH {
        return None;
    }
    Some(next)
}

/// Vertex moves implied by translating every control point of `seg` by `delta`.
pub fn translate_moves(seg: &JoinableSegment, delta: Vec3) -> Vec<(Vec3, Vec3)> {
    curve_control_points(&seg.curve)
        .into_iter()
        .map(|p| (p, p + delta))
        .collect()
}

/// Vertex moves from an old curve to a new curve (same topology / count).
///
/// Pairs control points by index. Used when an anchor drag edits one path.
pub fn placement_vertex_moves(old: &Curve, new: &Curve) -> Vec<(Vec3, Vec3)> {
    let a = curve_control_points(old);
    let b = curve_control_points(new);
    if a.len() != b.len() {
        // Topology changed (e.g. join split) — fall back to end pairing only.
        let mut moves = Vec::new();
        if plan_distance(old.start(), new.start()) > 1e-9 {
            moves.push((old.start(), new.start()));
        }
        if plan_distance(old.end(), new.end()) > 1e-9 {
            moves.push((old.end(), new.end()));
        }
        return moves;
    }
    a.into_iter()
        .zip(b)
        .filter(|(from, to)| plan_distance(*from, *to) > 1e-9)
        .collect()
}

/// Plan stretch updates for unselected peers when `moving` translate by `delta`.
///
/// Moving segments themselves are not listed — callers translate those fully.
/// A peer is rewritten only when at least one control point is coincident with
/// a moving control point (within [`JOIN_SNAP`]).
pub fn plan_stretch_translate(
    moving: &[JoinableSegment],
    peers: &[JoinableSegment],
    delta: Vec3,
) -> Vec<StretchUpdate> {
    if moving.is_empty() || delta.length_squared() < 1e-16 {
        return Vec::new();
    }
    let mut moves: Vec<(Vec3, Vec3)> = Vec::new();
    for seg in moving {
        moves.extend(translate_moves(seg, delta));
    }
    // Deduplicate near-identical from-points (shared corners among movers).
    dedupe_moves(&mut moves);

    let moving_ids: std::collections::BTreeSet<_> = moving.iter().map(|s| s.id).collect();
    let mut updates = Vec::new();
    for peer in peers {
        if moving_ids.contains(&peer.id) {
            continue;
        }
        if let Some(curve) = apply_vertex_moves(&peer.curve, &moves, JOIN_SNAP) {
            updates.push(StretchUpdate {
                id: peer.id,
                placement: Placement::Curve { curve },
            });
        }
    }
    updates
}

/// Plan stretch updates for peers when `source` changes from `old_curve` to `new_curve`.
///
/// Only partial edits stretch neighbours (e.g. dragging one end). When every
/// control point moves — a relocate / full translate via `update_element` —
/// peers are left alone; callers that translate should use
/// [`plan_stretch_translate`] instead so shared corners still follow.
pub fn plan_stretch_from_edit(
    source_id: ElementId,
    old_curve: &Curve,
    new_curve: &Curve,
    peers: &[JoinableSegment],
) -> Vec<StretchUpdate> {
    let moves = placement_vertex_moves(old_curve, new_curve);
    if moves.is_empty() {
        return Vec::new();
    }
    let old_pts = curve_control_points(old_curve);
    // Relocate: all defining points moved → disconnect joins, don't yank peers.
    if !old_pts.is_empty() && moves.len() >= old_pts.len() {
        return Vec::new();
    }
    let mut updates = Vec::new();
    for peer in peers {
        if peer.id == source_id {
            continue;
        }
        if let Some(curve) = apply_vertex_moves(&peer.curve, &moves, JOIN_SNAP) {
            updates.push(StretchUpdate {
                id: peer.id,
                placement: Placement::Curve { curve },
            });
        }
    }
    updates
}

fn dedupe_moves(moves: &mut Vec<(Vec3, Vec3)>) {
    let mut kept: Vec<(Vec3, Vec3)> = Vec::new();
    for (from, to) in moves.drain(..) {
        if kept
            .iter()
            .any(|(f, _)| plan_distance(*f, from) <= JOIN_SNAP)
        {
            continue;
        }
        kept.push((from, to));
    }
    *moves = kept;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::element::ElementId;

    fn seg(id: ElementId, a: Vec3, b: Vec3) -> JoinableSegment {
        JoinableSegment {
            id,
            curve: Curve::line(a, b),
            half_width: 0.1,
            join_start: 0.0,
            join_end: 0.0,
            allow_start: true,
            allow_end: true,
        }
    }

    #[test]
    fn moving_wall_stretches_connected_neighbour() {
        let a_id = ElementId::new();
        let b_id = ElementId::new();
        // A: (0,0)-(5,0)  B: (5,0)-(5,4)  shared corner at (5,0)
        let a = seg(a_id, Vec3::ZERO, Vec3::new(5.0, 0.0, 0.0));
        let b = seg(b_id, Vec3::new(5.0, 0.0, 0.0), Vec3::new(5.0, 0.0, 4.0));
        let delta = Vec3::new(0.0, 0.0, 2.0);
        let updates =
            plan_stretch_translate(std::slice::from_ref(&a), std::slice::from_ref(&b), delta);
        assert_eq!(updates.len(), 1);
        let u = &updates[0];
        assert_eq!(u.id, b_id);
        let curve = u.placement.curve().unwrap();
        // Shared end follows A; far end stays.
        assert!(plan_distance(curve.start(), Vec3::new(5.0, 0.0, 2.0)) < 1e-4);
        assert!(plan_distance(curve.end(), Vec3::new(5.0, 0.0, 4.0)) < 1e-4);
    }

    #[test]
    fn unconnected_peer_is_untouched() {
        let a = seg(ElementId::new(), Vec3::ZERO, Vec3::new(3.0, 0.0, 0.0));
        let far = seg(
            ElementId::new(),
            Vec3::new(10.0, 0.0, 0.0),
            Vec3::new(10.0, 0.0, 4.0),
        );
        let updates = plan_stretch_translate(
            std::slice::from_ref(&a),
            std::slice::from_ref(&far),
            Vec3::X,
        );
        assert!(updates.is_empty());
    }

    #[test]
    fn both_selected_no_peer_stretch_between_them() {
        let a_id = ElementId::new();
        let b_id = ElementId::new();
        let a = seg(a_id, Vec3::ZERO, Vec3::new(5.0, 0.0, 0.0));
        let b = seg(b_id, Vec3::new(5.0, 0.0, 0.0), Vec3::new(5.0, 0.0, 4.0));
        let updates = plan_stretch_translate(&[a, b], &[], Vec3::new(1.0, 0.0, 0.0));
        assert!(updates.is_empty());
    }

    #[test]
    fn anchor_edit_pulls_shared_end() {
        let a_id = ElementId::new();
        let b_id = ElementId::new();
        let old = Curve::line(Vec3::ZERO, Vec3::new(5.0, 0.0, 0.0));
        let new = Curve::line(Vec3::ZERO, Vec3::new(6.0, 0.0, 1.0));
        let b = seg(b_id, Vec3::new(5.0, 0.0, 0.0), Vec3::new(5.0, 0.0, 4.0));
        let updates = plan_stretch_from_edit(a_id, &old, &new, std::slice::from_ref(&b));
        assert_eq!(updates.len(), 1);
        let curve = updates[0].placement.curve().unwrap();
        assert!(plan_distance(curve.start(), Vec3::new(6.0, 0.0, 1.0)) < 1e-4);
        assert!(plan_distance(curve.end(), Vec3::new(5.0, 0.0, 4.0)) < 1e-4);
    }

    #[test]
    fn full_relocate_does_not_yank_peers() {
        let a_id = ElementId::new();
        let b_id = ElementId::new();
        let old = Curve::line(Vec3::new(5.0, 0.0, 0.0), Vec3::new(5.0, 0.0, 4.0));
        let new = Curve::line(Vec3::new(9.0, 0.0, 3.0), Vec3::new(9.0, 0.0, 6.0));
        let a = seg(a_id, Vec3::ZERO, Vec3::new(5.0, 0.0, 0.0));
        let updates = plan_stretch_from_edit(b_id, &old, &new, std::slice::from_ref(&a));
        assert!(updates.is_empty());
    }

    #[test]
    fn t_junction_vertex_follows_stem_tip() {
        let host_id = ElementId::new();
        let stem_id = ElementId::new();
        let host = JoinableSegment {
            id: host_id,
            curve: Curve::Polyline {
                points: vec![
                    Vec3::ZERO,
                    Vec3::new(5.0, 0.0, 0.0),
                    Vec3::new(10.0, 0.0, 0.0),
                ],
            },
            half_width: 0.1,
            join_start: 0.0,
            join_end: 0.0,
            allow_start: true,
            allow_end: true,
        };
        let stem = seg(stem_id, Vec3::new(5.0, 0.0, 3.0), Vec3::new(5.0, 0.0, 0.0));
        let delta = Vec3::new(1.0, 0.0, 0.0);
        let updates = plan_stretch_translate(
            std::slice::from_ref(&stem),
            std::slice::from_ref(&host),
            delta,
        );
        assert_eq!(updates.len(), 1);
        match updates[0].placement.curve() {
            Some(Curve::Polyline { points }) => {
                assert!(plan_distance(points[1], Vec3::new(6.0, 0.0, 0.0)) < 1e-4);
                assert!(plan_distance(points[0], Vec3::ZERO) < 1e-4);
                assert!(plan_distance(points[2], Vec3::new(10.0, 0.0, 0.0)) < 1e-4);
            }
            other => panic!("expected polyline host, got {other:?}"),
        }
    }
}
