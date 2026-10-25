//! Universal path joins: corner miters and T-junctions for joinable components.
//!
//! Operates on path placements + profile half-width. No wall/beam type switches —
//! a definition opts in with [`crate::ComponentDefinition::joinable`].
//!
//! Corner miters adjust [`crate::Element::join_start`] / [`crate::Element::join_end`]
//! (sweep extensions) so centerlines stay at user picks. T-junctions also insert
//! a host polyline vertex and trim the stem via a negative join offset.

use apex_geometry::{
    angle_between, closest_on_segment_xz, collapse_colinear_path, miter_extension, outward_dir,
    plan_distance, segment_intersect_xz, split_curve_at, stem_trim, Curve, JOIN_SNAP,
    MIN_CURVE_LENGTH,
};
use glam::Vec3;

use crate::component::GeometryRecipe;
use crate::element::{Element, ElementId};
use crate::join_end::{JoinEndSettings, JoinStyle};
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
    pub join_start_settings: JoinEndSettings,
    pub join_end_settings: JoinEndSettings,
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
        join_start_settings: element.join_start_settings,
        join_end_settings: element.join_end_settings,
    })
}

/// Recompute joins for every segment in the slice (global pass, offsets reset).
pub fn plan_joins_all(segments: &[JoinableSegment]) -> Vec<JoinUpdate> {
    if segments.is_empty() {
        return Vec::new();
    }
    let mut state: std::collections::BTreeMap<ElementId, SegState> =
        std::collections::BTreeMap::new();
    for seg in segments {
        let curve = collapse_colinear_path(&seg.curve, JOIN_SNAP);
        let canonicalized = curve != seg.curve;
        state.insert(
            seg.id,
            SegState {
                curve,
                join_start: 0.0,
                join_end: 0.0,
                placement_changed: canonicalized,
                touched: canonicalized,
            },
        );
    }

    let ids: Vec<ElementId> = state.keys().copied().collect();

    // --- X junctions: crossing mid-spans split both hosts ----------------------
    for i in 0..ids.len() {
        for j in (i + 1)..ids.len() {
            let id_a = ids[i];
            let id_b = ids[j];
            let pairs_a = segment_pairs(state.get(&id_a).unwrap().curve.clone());
            let pairs_b = segment_pairs(state.get(&id_b).unwrap().curve.clone());
            for (a0, a1) in &pairs_a {
                for (b0, b1) in &pairs_b {
                    let Some((hit, _, _)) = segment_intersect_xz(*a0, *a1, *b0, *b1, 1e-4) else {
                        continue;
                    };
                    if let Some(split) = split_curve_at(&state.get(&id_a).unwrap().curve, hit, JOIN_SNAP)
                    {
                        if split != state.get(&id_a).unwrap().curve {
                            let s = state.get_mut(&id_a).unwrap();
                            s.curve = split;
                            s.placement_changed = true;
                            s.touched = true;
                        }
                    }
                    if let Some(split) = split_curve_at(&state.get(&id_b).unwrap().curve, hit, JOIN_SNAP)
                    {
                        if split != state.get(&id_b).unwrap().curve {
                            let s = state.get_mut(&id_b).unwrap();
                            s.curve = split;
                            s.placement_changed = true;
                            s.touched = true;
                        }
                    }
                }
            }
        }
    }

    // --- Corner miters -------------------------------------------------------
    for i in 0..ids.len() {
        for j in 0..ids.len() {
            if i == j {
                continue;
            }
            let id_a = ids[i];
            let id_b = ids[j];
            let seg_a = segments.iter().find(|s| s.id == id_a).expect("seg");
            let seg_b = segments.iter().find(|s| s.id == id_b).expect("seg");
            for (a_at_start, b_at_start) in
                [(true, true), (true, false), (false, true), (false, false)]
            {
                if !end_allows(seg_a, a_at_start) || !end_allows(seg_b, b_at_start) {
                    continue;
                }
                let curve_a = state.get(&id_a).unwrap().curve.clone();
                let curve_b = state.get(&id_b).unwrap().curve.clone();
                let end_a = endpoint(&curve_a, a_at_start);
                let end_b = endpoint(&curve_b, b_at_start);
                if plan_distance(end_a, end_b) > JOIN_SNAP {
                    continue;
                }
                let Some(dir_a) = outward_dir(&curve_a, a_at_start) else {
                    continue;
                };
                let Some(dir_b) = outward_dir(&curve_b, b_at_start) else {
                    continue;
                };
                let Some(theta) = angle_between(dir_a, dir_b) else {
                    continue;
                };
                if theta < 0.15 || (std::f32::consts::PI - theta) < 0.15 {
                    continue;
                }
                let ext_a = style_extension(
                    end_style(seg_a, a_at_start),
                    seg_a.half_width,
                    theta,
                );
                let ext_b = style_extension(
                    end_style(seg_b, b_at_start),
                    seg_b.half_width,
                    theta,
                );
                if ext_a <= 0.0 && ext_b <= 0.0 {
                    continue;
                }
                set_join_offset(&mut state, id_a, a_at_start, ext_a);
                set_join_offset(&mut state, id_b, b_at_start, ext_b);
            }
        }
    }

    // --- T-junctions ---------------------------------------------------------
    for i in 0..ids.len() {
        for j in 0..ids.len() {
            if i == j {
                continue;
            }
            let stem_id = ids[i];
            let host_id = ids[j];
            let stem = segments.iter().find(|s| s.id == stem_id).expect("seg");
            let host = segments.iter().find(|s| s.id == host_id).expect("seg");
            for stem_at_start in [true, false] {
                if !end_allows(stem, stem_at_start) {
                    continue;
                }
                let stem_curve = state.get(&stem_id).unwrap().curve.clone();
                let host_curve = state.get(&host_id).unwrap().curve.clone();
                let tip = endpoint(&stem_curve, stem_at_start);
                let Some((hit, t, dist)) = closest_on_host(&host_curve, tip) else {
                    continue;
                };
                if dist > JOIN_SNAP || !(0.05..=0.95).contains(&t) {
                    continue;
                }
                if plan_distance(tip, host_curve.start()) <= JOIN_SNAP
                    || plan_distance(tip, host_curve.end()) <= JOIN_SNAP
                {
                    continue;
                }
                let Some(stem_out) = outward_dir(&stem_curve, stem_at_start) else {
                    continue;
                };
                let host_dir = host_tangent_at(&host_curve, hit).unwrap_or(Vec3::X);
                let Some(phi) = angle_between(stem_out, host_dir) else {
                    continue;
                };
                let hit_angle = phi.min(std::f32::consts::PI - phi);
                if hit_angle < 0.15 {
                    continue;
                }
                let trim = stem_trim(host.half_width, hit_angle);
                set_join_offset(&mut state, stem_id, stem_at_start, -trim);
                if let Some(split) = split_curve_at(&host_curve, hit, JOIN_SNAP) {
                    if split != host_curve {
                        let s = state.get_mut(&host_id).unwrap();
                        s.curve = split;
                        s.placement_changed = true;
                        s.touched = true;
                    }
                }
            }
        }
    }

    state
        .into_iter()
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

/// Compute updates that join `new_seg` with existing peers (global pass on the set).
pub fn plan_joins(new_seg: &JoinableSegment, peers: &[JoinableSegment]) -> Vec<JoinUpdate> {
    let mut all: Vec<JoinableSegment> = peers.to_vec();
    if !all.iter().any(|p| p.id == new_seg.id) {
        all.push(new_seg.clone());
    }
    plan_joins_all(&all)
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

fn end_allows(seg: &JoinableSegment, at_start: bool) -> bool {
    if at_start {
        seg.join_start_settings.allow_join
    } else {
        seg.join_end_settings.allow_join
    }
}

fn end_style(seg: &JoinableSegment, at_start: bool) -> JoinStyle {
    if at_start {
        seg.join_start_settings.style
    } else {
        seg.join_end_settings.style
    }
}

fn style_extension(style: JoinStyle, half_width: f32, theta: f32) -> f32 {
    match style {
        JoinStyle::Miter => miter_extension(half_width, theta),
        JoinStyle::Butt => 0.0,
        JoinStyle::Square => half_width,
    }
}

fn segment_pairs(curve: Curve) -> Vec<(Vec3, Vec3)> {
    match curve {
        Curve::Line { a, b } => vec![(a, b)],
        Curve::Polyline { points } => points
            .windows(2)
            .map(|w| (w[0], w[1]))
            .collect(),
        _ => Vec::new(),
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
            join_start_settings: JoinEndSettings::default(),
            join_end_settings: JoinEndSettings::default(),
        };
        let b = JoinableSegment {
            id: ElementId::new(),
            curve: Curve::line(Vec3::new(5.0, 0.0, 0.0), Vec3::new(5.0, 0.0, 4.0)),
            half_width: 0.1,
            join_start: 0.0,
            join_end: 0.0,
            join_start_settings: JoinEndSettings::default(),
            join_end_settings: JoinEndSettings::default(),
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
            join_start_settings: JoinEndSettings::default(),
            join_end_settings: JoinEndSettings::default(),
        };
        let stem = JoinableSegment {
            id: ElementId::new(),
            curve: Curve::line(Vec3::new(5.0, 0.0, 3.0), Vec3::new(5.0, 0.0, 0.0)),
            half_width: 0.1,
            join_start: 0.0,
            join_end: 0.0,
            join_start_settings: JoinEndSettings::default(),
            join_end_settings: JoinEndSettings::default(),
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
    fn x_junction_splits_both_walls_at_crossing() {
        let a = JoinableSegment {
            id: ElementId::new(),
            curve: Curve::line(Vec3::ZERO, Vec3::new(10.0, 0.0, 0.0)),
            half_width: 0.1,
            join_start: 0.0,
            join_end: 0.0,
            join_start_settings: JoinEndSettings::default(),
            join_end_settings: JoinEndSettings::default(),
        };
        let b = JoinableSegment {
            id: ElementId::new(),
            curve: Curve::line(Vec3::new(5.0, 0.0, -3.0), Vec3::new(5.0, 0.0, 3.0)),
            half_width: 0.1,
            join_start: 0.0,
            join_end: 0.0,
            join_start_settings: JoinEndSettings::default(),
            join_end_settings: JoinEndSettings::default(),
        };
        let updates = plan_joins_all(&[a.clone(), b.clone()]);
        let a_u = updates.iter().find(|u| u.id == a.id).expect("a");
        let b_u = updates.iter().find(|u| u.id == b.id).expect("b");
        match a_u.placement.as_ref().and_then(|p| p.curve()) {
            Some(Curve::Polyline { points }) => assert_eq!(points.len(), 3),
            other => panic!("wall a should split at cross, got {other:?}"),
        }
        match b_u.placement.as_ref().and_then(|p| p.curve()) {
            Some(Curve::Polyline { points }) => assert_eq!(points.len(), 3),
            other => panic!("wall b should split at cross, got {other:?}"),
        }
    }

    #[test]
    fn different_thickness_stem_trim_uses_host_half_width() {
        let host = JoinableSegment {
            id: ElementId::new(),
            curve: Curve::line(Vec3::ZERO, Vec3::new(10.0, 0.0, 0.0)),
            half_width: 0.2,
            join_start: 0.0,
            join_end: 0.0,
            join_start_settings: JoinEndSettings::default(),
            join_end_settings: JoinEndSettings::default(),
        };
        let stem = JoinableSegment {
            id: ElementId::new(),
            curve: Curve::line(Vec3::new(5.0, 0.0, 3.0), Vec3::new(5.0, 0.0, 0.0)),
            half_width: 0.1,
            join_start: 0.0,
            join_end: 0.0,
            join_start_settings: JoinEndSettings::default(),
            join_end_settings: JoinEndSettings::default(),
        };
        let updates = plan_joins_all(&[host.clone(), stem.clone()]);
        let stem_u = updates.iter().find(|u| u.id == stem.id).expect("stem");
        assert!(
            (stem_u.join_end + 0.2).abs() < 0.04,
            "trim should use host half-width 0.2, got {}",
            stem_u.join_end
        );
    }

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
