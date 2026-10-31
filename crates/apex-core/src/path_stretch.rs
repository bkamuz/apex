//! Connected stretch for joinable path components.
//!
//! When a joinable path moves, peers that share endpoints (or T-junction
//! vertices) keep those shared vertices attached — far ends stay put so the
//! neighbour stretches. Pure geometry planning; Project applies the updates.
//!
//! T-junction rule: a stem tip that sits mid-span on a host must stay on that
//! host. Stretching must not yank the host's inserted mid-vertex off the wall
//! (that created acute "spike" kinks on the house sample). Peer updates only
//! move **endpoints**; stem tips are re-projected onto unmoved hosts.

use apex_geometry::{closest_on_segment_xz, plan_distance, Curve, JOIN_SNAP, MIN_CURVE_LENGTH};
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

/// Parametric band that counts as mid-span (not an end corner) for T-joins.
const T_MID_MIN: f32 = 0.05;
const T_MID_MAX: f32 = 0.95;

/// Apply vertex moves to a curve. Returns `None` when nothing changed or the
/// result would be degenerate.
pub fn apply_vertex_moves(curve: &Curve, moves: &[(Vec3, Vec3)], snap: f32) -> Option<Curve> {
    apply_vertex_moves_inner(curve, moves, snap, false)
}

/// Like [`apply_vertex_moves`], but only rewrites curve **endpoints**.
///
/// Interior polyline vertices (T-junction inserts) stay put so a translating
/// stem cannot kink its host.
pub fn apply_endpoint_vertex_moves(
    curve: &Curve,
    moves: &[(Vec3, Vec3)],
    snap: f32,
) -> Option<Curve> {
    apply_vertex_moves_inner(curve, moves, snap, true)
}

fn apply_vertex_moves_inner(
    curve: &Curve,
    moves: &[(Vec3, Vec3)],
    snap: f32,
    endpoints_only: bool,
) -> Option<Curve> {
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
            let last = points.len().saturating_sub(1);
            let mut changed = false;
            let mapped: Vec<Vec3> = points
                .iter()
                .enumerate()
                .map(|(i, p)| {
                    if endpoints_only && i != 0 && i != last {
                        return *p;
                    }
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

/// Closest point on a straight/open host curve (plan XZ).
pub fn closest_on_curve(curve: &Curve, tip: Vec3) -> Option<(Vec3, f32, f32)> {
    match curve {
        Curve::Line { a, b } => closest_on_segment_xz(*a, *b, tip),
        Curve::Polyline { points } => {
            let mut best: Option<(Vec3, f32, f32)> = None;
            let total = curve.length();
            if total < MIN_CURVE_LENGTH {
                return None;
            }
            let mut travelled = 0.0;
            for w in points.windows(2) {
                let seg_len = (w[1] - w[0]).length();
                if let Some((q, t_local, dist)) = closest_on_segment_xz(w[0], w[1], tip) {
                    let t = ((travelled + t_local * seg_len) / total).clamp(0.0, 1.0);
                    if best.as_ref().map(|b| dist < b.2).unwrap_or(true) {
                        best = Some((q, t, dist));
                    }
                }
                travelled += seg_len;
            }
            best
        }
        _ => None,
    }
}

/// True when `tip` sits mid-span on `host` (T-junction), not at a corner.
pub fn tip_on_host_midspan(host: &Curve, tip: Vec3, snap: f32) -> bool {
    let Some((hit, t, dist)) = closest_on_curve(host, tip) else {
        return false;
    };
    if dist > snap || !(T_MID_MIN..=T_MID_MAX).contains(&t) {
        return false;
    }
    if plan_distance(tip, host.start()) <= snap || plan_distance(tip, host.end()) <= snap {
        return false;
    }
    let _ = hit;
    true
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

/// Remap a polyline when only its endpoints were edited: interior vertices
/// keep their relative arc-length parameters on the new start→end chord.
///
/// Used so joinable edit handles can expose only endpoints without wiping
/// T-junction inserts (and without leaving them as off-line spikes).
pub fn remap_curve_endpoints(old: &Curve, new_start: Vec3, new_end: Vec3) -> Option<Curve> {
    match old {
        Curve::Line { .. } => {
            if plan_distance(new_start, new_end) < MIN_CURVE_LENGTH {
                return None;
            }
            Some(Curve::line(new_start, new_end))
        }
        Curve::Polyline { points } if points.len() >= 2 => {
            if plan_distance(new_start, new_end) < MIN_CURVE_LENGTH {
                return None;
            }
            if points.len() == 2 {
                return Some(Curve::line(new_start, new_end));
            }
            let total = old.length();
            if total < MIN_CURVE_LENGTH {
                return None;
            }
            let mut travelled = 0.0;
            let mut mapped = Vec::with_capacity(points.len());
            mapped.push(new_start);
            for w in points.windows(2).take(points.len() - 2) {
                travelled += (w[1] - w[0]).length();
                let t = (travelled / total).clamp(0.0, 1.0);
                mapped.push(new_start.lerp(new_end, t));
            }
            mapped.push(new_end);
            Some(Curve::Polyline { points: mapped })
        }
        _ => None,
    }
}

/// Translate a curve by `delta` (line / open polyline only).
fn translated_curve(curve: &Curve, delta: Vec3) -> Curve {
    match curve {
        Curve::Line { a, b } => Curve::Line {
            a: *a + delta,
            b: *b + delta,
        },
        Curve::Polyline { points } => Curve::Polyline {
            points: points.iter().map(|p| *p + delta).collect(),
        },
        other => other.clone(),
    }
}

/// Final mover curve after rigid translate, with T-tips snapped onto unmoved hosts.
fn final_mover_curve(
    seg: &JoinableSegment,
    peers: &[JoinableSegment],
    moving_ids: &std::collections::BTreeSet<ElementId>,
    delta: Vec3,
) -> (Curve, bool) {
    let translated = translated_curve(&seg.curve, delta);
    let mut start = seg.curve.start() + delta;
    let mut end = seg.curve.end() + delta;
    let mut snapped = false;
    for (tip0, tip_slot) in [(seg.curve.start(), &mut start), (seg.curve.end(), &mut end)] {
        for peer in peers {
            if moving_ids.contains(&peer.id) {
                continue;
            }
            if !tip_on_host_midspan(&peer.curve, tip0, JOIN_SNAP) {
                continue;
            }
            let Some((q, _, _)) = closest_on_curve(&peer.curve, *tip_slot) else {
                continue;
            };
            if plan_distance(*tip_slot, q) > 1e-9 {
                *tip_slot = q;
                snapped = true;
            }
        }
    }
    if !snapped {
        return (translated, false);
    }
    match remap_curve_endpoints(&translated, start, end) {
        Some(curve) => (curve, true),
        None => (translated, false),
    }
}

/// Plan stretch updates for unselected peers when `moving` translate by `delta`.
///
/// Moving segments themselves are translated by the caller unless a T-tip snap
/// rewrites them (also listed here). Peer **endpoints** that coincided with a
/// mover control point map to the corresponding point on the mover's **final**
/// curve (after tip snap) — so a stem into a moving partition follows the
/// partition without kinking when tips snap back, and host interiors are never
/// yanked by a translating stem tip.
pub fn plan_stretch_translate(
    moving: &[JoinableSegment],
    peers: &[JoinableSegment],
    delta: Vec3,
) -> Vec<StretchUpdate> {
    if moving.is_empty() || delta.length_squared() < 1e-16 {
        return Vec::new();
    }
    let moving_ids: std::collections::BTreeSet<_> = moving.iter().map(|s| s.id).collect();

    // (old control points, final curve) per mover — tip snap applied first.
    let mut mover_finals: Vec<(ElementId, Vec<Vec3>, Curve, bool)> = Vec::new();
    for seg in moving {
        let (final_curve, snapped) = final_mover_curve(seg, peers, &moving_ids, delta);
        let old_pts = curve_control_points(&seg.curve);
        mover_finals.push((seg.id, old_pts, final_curve, snapped));
    }

    let mut updates = Vec::new();
    for (id, _old, final_curve, snapped) in &mover_finals {
        if *snapped {
            updates.push(StretchUpdate {
                id: *id,
                placement: Placement::Curve {
                    curve: final_curve.clone(),
                },
            });
        }
    }

    for peer in peers {
        if moving_ids.contains(&peer.id) {
            continue;
        }
        let mut endpoint_moves: Vec<(Vec3, Vec3)> = Vec::new();
        for tip in [peer.curve.start(), peer.curve.end()] {
            for (_id, old_pts, final_curve, _snapped) in &mover_finals {
                let final_pts = curve_control_points(final_curve);
                if old_pts.len() != final_pts.len() {
                    continue;
                }
                for (old_p, new_p) in old_pts.iter().zip(final_pts.iter()) {
                    if plan_distance(tip, *old_p) <= JOIN_SNAP {
                        if plan_distance(tip, *new_p) > 1e-9 {
                            endpoint_moves.push((tip, *new_p));
                        }
                        break;
                    }
                }
            }
        }
        dedupe_moves(&mut endpoint_moves);
        if let Some(curve) = apply_endpoint_vertex_moves(&peer.curve, &endpoint_moves, JOIN_SNAP) {
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
///
/// Peer **endpoints** follow freely. Peer **interior** vertices (T-inserts)
/// only slide along their local host segment so a stem tip cannot kink the host.
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
        if let Some(curve) = apply_peer_stretch_moves(&peer.curve, &moves, JOIN_SNAP) {
            updates.push(StretchUpdate {
                id: peer.id,
                placement: Placement::Curve { curve },
            });
        }
    }
    updates
}

/// Stretch a peer: endpoints follow `moves` freely; interior verts slide on
/// their local segment (projection of the target onto the neighbour chord).
fn apply_peer_stretch_moves(curve: &Curve, moves: &[(Vec3, Vec3)], snap: f32) -> Option<Curve> {
    if moves.is_empty() {
        return None;
    }
    let mapped_to = |p: Vec3| -> Option<Vec3> {
        for (from, to) in moves {
            if plan_distance(p, *from) <= snap {
                return Some(*to);
            }
        }
        None
    };
    match curve {
        Curve::Line { a, b } => {
            let na = mapped_to(*a).unwrap_or(*a);
            let nb = mapped_to(*b).unwrap_or(*b);
            if plan_distance(na, *a) <= 1e-9 && plan_distance(nb, *b) <= 1e-9 {
                return None;
            }
            let next = Curve::Line { a: na, b: nb };
            (next.length() >= MIN_CURVE_LENGTH).then_some(next)
        }
        Curve::Polyline { points } => {
            let last = points.len().saturating_sub(1);
            let mut changed = false;
            let mut mapped = points.clone();
            for i in 0..points.len() {
                let Some(to) = mapped_to(points[i]) else {
                    continue;
                };
                let q = if i == 0 || i == last {
                    to
                } else {
                    // Slide along the chord through neighbours (pre-edit).
                    let prev = points[i - 1];
                    let next = points[i + 1];
                    closest_on_segment_xz(prev, next, to)
                        .map(|(q, _, _)| q)
                        .unwrap_or(points[i])
                };
                if plan_distance(q, points[i]) > 1e-9 {
                    mapped[i] = q;
                    changed = true;
                }
            }
            if !changed {
                return None;
            }
            let next = Curve::Polyline { points: mapped };
            (next.length() >= MIN_CURVE_LENGTH).then_some(next)
        }
        Curve::Arc { .. } | Curve::Circle { .. } => None,
    }
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
        // Moving the HOST (polyline) still stretches the stem tip (endpoint).
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
            std::slice::from_ref(&host),
            std::slice::from_ref(&stem),
            delta,
        );
        assert_eq!(updates.len(), 1);
        let curve = updates[0].placement.curve().unwrap();
        // Stem tip (endpoint at host mid) follows; far end stays.
        assert!(plan_distance(curve.end(), Vec3::new(6.0, 0.0, 0.0)) < 1e-4);
        assert!(plan_distance(curve.start(), Vec3::new(5.0, 0.0, 3.0)) < 1e-4);
    }

    #[test]
    fn moving_stem_does_not_kink_host_polyline() {
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
        let stem = seg(stem_id, Vec3::new(5.0, 0.0, 0.0), Vec3::new(5.0, 0.0, 4.0));
        let delta = Vec3::new(0.0, 0.0, -2.0);
        let updates = plan_stretch_translate(
            std::slice::from_ref(&stem),
            std::slice::from_ref(&host),
            delta,
        );
        // Host must not appear as a kinked peer update.
        assert!(
            updates.iter().all(|u| u.id != host_id),
            "host interior must not be yanked: {updates:?}"
        );
        // Stem tip snaps back onto host at (5,0,0).
        let stem_u = updates.iter().find(|u| u.id == stem_id);
        assert!(stem_u.is_some(), "stem tip snap should rewrite mover");
        let curve = stem_u.unwrap().placement.curve().unwrap();
        assert!(
            plan_distance(curve.start(), Vec3::new(5.0, 0.0, 0.0)) < 1e-3,
            "tip stays on host, got {curve:?}"
        );
        assert!(
            plan_distance(curve.end(), Vec3::new(5.0, 0.0, 2.0)) < 1e-3,
            "far end still translated, got {curve:?}"
        );
    }

    #[test]
    fn remap_endpoints_keeps_interior_on_chord() {
        let old = Curve::Polyline {
            points: vec![
                Vec3::ZERO,
                Vec3::new(5.0, 0.0, 0.0),
                Vec3::new(10.0, 0.0, 0.0),
            ],
        };
        let next =
            remap_curve_endpoints(&old, Vec3::new(0.0, 0.0, -2.0), Vec3::new(10.0, 0.0, -2.0))
                .expect("remap");
        match next {
            Curve::Polyline { points } => {
                assert_eq!(points.len(), 3);
                assert!(plan_distance(points[0], Vec3::new(0.0, 0.0, -2.0)) < 1e-4);
                assert!(plan_distance(points[1], Vec3::new(5.0, 0.0, -2.0)) < 1e-4);
                assert!(plan_distance(points[2], Vec3::new(10.0, 0.0, -2.0)) < 1e-4);
            }
            other => panic!("expected polyline, got {other:?}"),
        }
    }

    #[test]
    fn stem_tip_edit_slides_host_t_vertex_on_line() {
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
        let old = Curve::line(Vec3::new(5.0, 0.0, 0.0), Vec3::new(5.0, 0.0, 4.0));
        // Drag tip along the host.
        let new = Curve::line(Vec3::new(7.0, 0.0, 0.0), Vec3::new(5.0, 0.0, 4.0));
        let updates = plan_stretch_from_edit(stem_id, &old, &new, std::slice::from_ref(&host));
        assert_eq!(updates.len(), 1);
        match updates[0].placement.curve() {
            Some(Curve::Polyline { points }) => {
                assert!(plan_distance(points[1], Vec3::new(7.0, 0.0, 0.0)) < 1e-4);
                assert!(plan_distance(points[0], Vec3::ZERO) < 1e-4);
                assert!(plan_distance(points[2], Vec3::new(10.0, 0.0, 0.0)) < 1e-4);
            }
            other => panic!("expected slid host, got {other:?}"),
        }
    }

    #[test]
    fn stem_tip_drag_off_host_does_not_spike() {
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
        let old = Curve::line(Vec3::new(5.0, 0.0, 0.0), Vec3::new(5.0, 0.0, 4.0));
        let new = Curve::line(Vec3::new(5.0, 0.0, -3.0), Vec3::new(5.0, 0.0, 4.0));
        let updates = plan_stretch_from_edit(stem_id, &old, &new, std::slice::from_ref(&host));
        // Host T-vertex projects back onto the facade — no spike.
        if let Some(u) = updates.first() {
            match u.placement.curve() {
                Some(Curve::Polyline { points }) => {
                    assert!(
                        points[1].z.abs() < 1e-3,
                        "host mid must stay on facade, got {points:?}"
                    );
                }
                other => panic!("unexpected {other:?}"),
            }
        }
    }
}
