//! Universal path joins: corner miters and T-junctions for joinable components.
//!
//! Operates on path placements + profile half-width. No wall/beam type switches —
//! a definition opts in with [`crate::ComponentDefinition::joinable`].
//!
//! Corner miters adjust [`crate::Element::join_start`] / [`crate::Element::join_end`]
//! (sweep extensions) so centerlines stay at user picks. T-junctions also insert
//! a host polyline vertex and trim the stem via a negative join offset.

use apex_geometry::{
    angle_between, closest_on_segment_xz, miter_extension, outward_dir, plan_distance,
    split_curve_at, stem_trim, Curve, JOIN_SNAP, MIN_CURVE_LENGTH,
};
use glam::Vec3;

use crate::component::GeometryRecipe;
use crate::element::{Element, ElementId};
use crate::placement::Placement;
use crate::registry::ComponentRegistry;

/// A straight open path eligible for joining.
#[derive(Debug, Clone)]
pub struct JoinableSegment {
    pub id: ElementId,
    pub curve: Curve,
    pub half_width: f32,
    pub join_start: f32,
    pub join_end: f32,
}

/// One rewrite produced by a join pass.
#[derive(Debug, Clone)]
pub struct JoinUpdate {
    pub id: ElementId,
    pub placement: Option<Placement>,
    pub join_start: f32,
    pub join_end: f32,
}

/// Plan-distance snap for endpoint / mid-span hits.
pub use apex_geometry::JOIN_SNAP as PATH_JOIN_SNAP;

/// Half-width of a swept profile along local U (thickness / beam width).
pub fn profile_half_width(registry: &ComponentRegistry, element: &Element) -> Option<f32> {
    let definition = registry.get(&element.component_id)?;
    let GeometryRecipe::Sweep { profile, .. } = &definition.recipe else {
        return None;
    };
    let params = registry
        .eval_params(&element.component_id, &element.params)
        .ok()?;
    let profile = profile.evaluate(&params, registry.profiles()).ok()?;
    let (min, max) = profile.bounds();
    let width = max[0] - min[0];
    if width <= 0.0 {
        return None;
    }
    Some(width * 0.5)
}

/// Build a joinable segment from an element when its definition is joinable
/// and the placement is a straight line or open polyline (arcs skipped in MVP).
pub fn joinable_segment(
    registry: &ComponentRegistry,
    element: &Element,
) -> Option<JoinableSegment> {
    let definition = registry.get(&element.component_id)?;
    if !definition.joinable {
        return None;
    }
    let curve = element.placement.curve()?.clone();
    match &curve {
        Curve::Line { .. } => {}
        Curve::Polyline { points } if points.len() >= 2 && !curve.is_closed() => {}
        Curve::Arc { .. } | Curve::Circle { .. } | Curve::Polyline { .. } => return None,
    }
    if curve.length() < MIN_CURVE_LENGTH {
        return None;
    }
    let half_width = profile_half_width(registry, element)?;
    Some(JoinableSegment {
        id: element.id,
        curve,
        half_width,
        join_start: element.join_start,
        join_end: element.join_end,
    })
}

/// Compute updates that join `new_seg` with existing peers.
///
/// Corner: two ends within [`JOIN_SNAP`] → miter extensions on both.
/// T-junction: end hits mid-span of a peer → split host + trim stem.
pub fn plan_joins(new_seg: &JoinableSegment, peers: &[JoinableSegment]) -> Vec<JoinUpdate> {
    let mut state: std::collections::BTreeMap<ElementId, SegState> =
        std::collections::BTreeMap::new();

    let mut ensure = |seg: &JoinableSegment| {
        state.entry(seg.id).or_insert_with(|| SegState {
            curve: seg.curve.clone(),
            // Preserve existing join offsets on ends this pass does not touch.
            join_start: seg.join_start,
            join_end: seg.join_end,
            placement_changed: false,
            touched: false,
        });
    };
    ensure(new_seg);
    for peer in peers {
        ensure(peer);
    }

    // --- Corner miters -------------------------------------------------------
    for peer in peers {
        if peer.id == new_seg.id {
            continue;
        }
        for (new_at_start, peer_at_start) in
            [(true, true), (true, false), (false, true), (false, false)]
        {
            let new_curve = state.get(&new_seg.id).unwrap().curve.clone();
            let peer_curve = state.get(&peer.id).unwrap().curve.clone();
            let new_end = endpoint(&new_curve, new_at_start);
            let peer_end = endpoint(&peer_curve, peer_at_start);
            if plan_distance(new_end, peer_end) > JOIN_SNAP {
                continue;
            }

            let Some(dir_new) = outward_dir(&new_curve, new_at_start) else {
                continue;
            };
            let Some(dir_peer) = outward_dir(&peer_curve, peer_at_start) else {
                continue;
            };
            let Some(theta) = angle_between(dir_new, dir_peer) else {
                continue;
            };
            if theta < 0.15 || (std::f32::consts::PI - theta) < 0.15 {
                continue;
            }

            let ext_new = miter_extension(new_seg.half_width, theta);
            let ext_peer = miter_extension(peer.half_width, theta);
            if ext_new <= 0.0 && ext_peer <= 0.0 {
                continue;
            }

            set_join_offset(&mut state, new_seg.id, new_at_start, ext_new);
            set_join_offset(&mut state, peer.id, peer_at_start, ext_peer);
        }
    }

    // --- T-junctions: new end → mid-span of peer -----------------------------
    for peer in peers {
        if peer.id == new_seg.id {
            continue;
        }
        for new_at_start in [true, false] {
            let new_curve = state.get(&new_seg.id).unwrap().curve.clone();
            let peer_curve = state.get(&peer.id).unwrap().curve.clone();
            let tip = endpoint(&new_curve, new_at_start);
            let Some((hit, t, dist)) = closest_on_host(&peer_curve, tip) else {
                continue;
            };
            if dist > JOIN_SNAP || !(0.05..=0.95).contains(&t) {
                continue;
            }
            if plan_distance(tip, peer_curve.start()) <= JOIN_SNAP
                || plan_distance(tip, peer_curve.end()) <= JOIN_SNAP
            {
                continue;
            }

            let Some(stem_out) = outward_dir(&new_curve, new_at_start) else {
                continue;
            };
            let host_dir = host_tangent_at(&peer_curve, hit).unwrap_or(Vec3::X);
            let Some(phi) = angle_between(stem_out, host_dir) else {
                continue;
            };
            let hit_angle = phi.min(std::f32::consts::PI - phi);
            if hit_angle < 0.15 {
                continue;
            }

            let trim = stem_trim(peer.half_width, hit_angle);
            // Keep centerline tip on host; negative extension pulls the mesh face back.
            set_join_offset(&mut state, new_seg.id, new_at_start, -trim);

            if let Some(split) = split_curve_at(&peer_curve, hit, JOIN_SNAP) {
                if split != peer_curve {
                    let s = state.get_mut(&peer.id).unwrap();
                    s.curve = split;
                    s.placement_changed = true;
                    s.touched = true;
                }
            }
        }
    }

    // --- Inverse T: peer end → mid-span of new path --------------------------
    for peer in peers {
        if peer.id == new_seg.id {
            continue;
        }
        for peer_at_start in [true, false] {
            let new_curve = state.get(&new_seg.id).unwrap().curve.clone();
            let peer_curve = state.get(&peer.id).unwrap().curve.clone();
            let tip = endpoint(&peer_curve, peer_at_start);
            let Some((hit, t, dist)) = closest_on_host(&new_curve, tip) else {
                continue;
            };
            if dist > JOIN_SNAP || !(0.05..=0.95).contains(&t) {
                continue;
            }
            if plan_distance(tip, new_curve.start()) <= JOIN_SNAP
                || plan_distance(tip, new_curve.end()) <= JOIN_SNAP
            {
                continue;
            }

            let Some(stem_out) = outward_dir(&peer_curve, peer_at_start) else {
                continue;
            };
            let host_dir = host_tangent_at(&new_curve, hit).unwrap_or(Vec3::X);
            let Some(phi) = angle_between(stem_out, host_dir) else {
                continue;
            };
            let hit_angle = phi.min(std::f32::consts::PI - phi);
            if hit_angle < 0.15 {
                continue;
            }

            let trim = stem_trim(new_seg.half_width, hit_angle);
            set_join_offset(&mut state, peer.id, peer_at_start, -trim);

            if let Some(split) = split_curve_at(&new_curve, hit, JOIN_SNAP) {
                if split != new_curve {
                    let s = state.get_mut(&new_seg.id).unwrap();
                    s.curve = split;
                    s.placement_changed = true;
                    s.touched = true;
                }
            }
        }
    }

    state
        .into_iter()
        .filter(|(_, s)| s.touched)
        .map(|(id, s)| JoinUpdate {
            id,
            placement: s
                .placement_changed
                .then_some(Placement::Curve { curve: s.curve }),
            join_start: s.join_start,
            join_end: s.join_end,
        })
        .collect()
}

#[derive(Debug, Clone)]
struct SegState {
    curve: Curve,
    join_start: f32,
    join_end: f32,
    placement_changed: bool,
    touched: bool,
}

fn endpoint(curve: &Curve, at_start: bool) -> Vec3 {
    if at_start {
        curve.start()
    } else {
        curve.end()
    }
}

fn set_join_offset(
    state: &mut std::collections::BTreeMap<ElementId, SegState>,
    id: ElementId,
    at_start: bool,
    value: f32,
) {
    let s = state.get_mut(&id).expect("segment state");
    if at_start {
        s.join_start = value;
    } else {
        s.join_end = value;
    }
    s.touched = true;
}

fn closest_on_host(curve: &Curve, tip: Vec3) -> Option<(Vec3, f32, f32)> {
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

fn host_tangent_at(curve: &Curve, point: Vec3) -> Option<Vec3> {
    match curve {
        Curve::Line { a, b } => (*b - *a).try_normalize(),
        Curve::Polyline { points } => {
            let mut best: Option<(Vec3, f32)> = None;
            for w in points.windows(2) {
                if let Some((_, _, dist)) = closest_on_segment_xz(w[0], w[1], point) {
                    if best.as_ref().map(|b| dist < b.1).unwrap_or(true) {
                        best = (w[1] - w[0]).try_normalize().map(|d| (d, dist));
                    }
                }
            }
            best.map(|(d, _)| d)
        }
        _ => curve.tangent_at(0.5).ok(),
    }
}

/// Collect joinable peers on a level with the same component id as `element`.
pub fn peers_for<'a>(
    registry: &ComponentRegistry,
    elements: impl Iterator<Item = &'a Element>,
    element: &Element,
) -> Vec<JoinableSegment> {
    let mut out = Vec::new();
    for other in elements {
        if other.id == element.id {
            continue;
        }
        if other.component_id != element.component_id {
            continue;
        }
        if other.level_id != element.level_id {
            continue;
        }
        if let Some(seg) = joinable_segment(registry, other) {
            out.push(seg);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::level::LevelId;
    use crate::param::ParamMap;
    use crate::registry::ComponentRegistry;
    use crate::Element;

    #[test]
    fn corner_miter_sets_join_offsets_without_moving_centerline() {
        let a = JoinableSegment {
            id: ElementId::new(),
            curve: Curve::line(Vec3::ZERO, Vec3::new(5.0, 0.0, 0.0)),
            half_width: 0.1,
            join_start: 0.0,
            join_end: 0.0,
        };
        let b = JoinableSegment {
            id: ElementId::new(),
            curve: Curve::line(Vec3::new(5.0, 0.0, 0.0), Vec3::new(5.0, 0.0, 4.0)),
            half_width: 0.1,
            join_start: 0.0,
            join_end: 0.0,
        };
        let updates = plan_joins(&b, &[a.clone()]);
        assert!(
            updates.len() >= 2,
            "expected updates for both walls, got {}",
            updates.len()
        );

        let a_u = updates.iter().find(|u| u.id == a.id).expect("a updated");
        let b_u = updates.iter().find(|u| u.id == b.id).expect("b updated");
        assert!(a_u.placement.is_none(), "corner must not move centerline");
        assert!(b_u.placement.is_none(), "corner must not move centerline");
        assert!(
            (a_u.join_end - 0.1).abs() < 0.02,
            "a join_end={}",
            a_u.join_end
        );
        assert!(
            (b_u.join_start - 0.1).abs() < 0.02,
            "b join_start={}",
            b_u.join_start
        );
    }

    #[test]
    fn t_junction_splits_host_and_trims_stem() {
        let host = JoinableSegment {
            id: ElementId::new(),
            curve: Curve::line(Vec3::ZERO, Vec3::new(10.0, 0.0, 0.0)),
            half_width: 0.1,
            join_start: 0.0,
            join_end: 0.0,
        };
        let stem = JoinableSegment {
            id: ElementId::new(),
            curve: Curve::line(Vec3::new(5.0, 0.0, 3.0), Vec3::new(5.0, 0.0, 0.0)),
            half_width: 0.1,
            join_start: 0.0,
            join_end: 0.0,
        };
        let updates = plan_joins(&stem, &[host.clone()]);
        let host_u = updates.iter().find(|u| u.id == host.id).expect("host");
        let stem_u = updates.iter().find(|u| u.id == stem.id).expect("stem");

        match host_u.placement.as_ref().and_then(|p| p.curve()) {
            Some(Curve::Polyline { points }) => {
                assert_eq!(points.len(), 3);
                assert!((points[1].x - 5.0).abs() < 0.05);
            }
            other => panic!("host should become polyline, got {other:?}"),
        }

        assert!(
            (stem_u.join_end + 0.1).abs() < 0.03,
            "stem join_end={}",
            stem_u.join_end
        );
    }

    #[test]
    fn wall_profile_half_width_is_half_thickness() {
        let registry = ComponentRegistry::with_builtins();
        let element = Element::new(
            "W1",
            "apex.wall",
            LevelId::new(),
            Placement::line(Vec3::ZERO, Vec3::new(3.0, 0.0, 0.0)),
            ParamMap::new(),
        );
        let hw = profile_half_width(&registry, &element).expect("half width");
        assert!(
            (hw - 0.1).abs() < 1e-4,
            "default wall thickness 0.2 → half 0.1, got {hw}"
        );
    }
}
