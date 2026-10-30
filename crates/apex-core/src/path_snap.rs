//! Placement snap targets for joinable path components.
//!
//! Collects endpoints, segment midpoints, and intermediate polyline vertices
//! from joinable peers so placement tools can snap without type branches.

use apex_geometry::{plan_distance, Curve};
use glam::Vec3;
use serde::Serialize;

use crate::element::{Element, ElementId};
use crate::level::LevelId;
use crate::path_join::joinable_segment;
use crate::registry::ComponentRegistry;

/// Kind of joinable snap point (for UI feedback / tests).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PathSnapKind {
    /// Path start or end.
    End,
    /// Midpoint of a straight segment (handy for T-joins).
    Mid,
    /// Intermediate polyline vertex (existing T-junction split).
    Vertex,
}

/// One snap candidate on a joinable peer.
#[derive(Debug, Clone, Serialize)]
pub struct PathSnapTarget {
    pub point: [f32; 3],
    pub kind: PathSnapKind,
    pub element_id: String,
}

/// Default plan-distance (m) for picking a snap target while placing.
/// Larger than [`JOIN_SNAP`] so the cursor catches ends before the join pass.
pub const PLACEMENT_SNAP: f32 = 0.35;

/// Control points of a joinable curve (line ends / polyline vertices).
pub fn curve_control_points(curve: &Curve) -> Vec<Vec3> {
    match curve {
        Curve::Line { a, b } => vec![*a, *b],
        Curve::Polyline { points } => points.clone(),
        Curve::Arc { .. } | Curve::Circle { .. } => Vec::new(),
    }
}

/// Snap targets contributed by one joinable curve.
pub fn snap_points_on_curve(curve: &Curve) -> Vec<(Vec3, PathSnapKind)> {
    let mut out = Vec::new();
    match curve {
        Curve::Line { a, b } => {
            out.push((*a, PathSnapKind::End));
            out.push((*b, PathSnapKind::End));
            out.push((a.lerp(*b, 0.5), PathSnapKind::Mid));
        }
        Curve::Polyline { points } if points.len() >= 2 => {
            let last = points.len() - 1;
            for (i, p) in points.iter().enumerate() {
                let kind = if i == 0 || i == last {
                    PathSnapKind::End
                } else {
                    PathSnapKind::Vertex
                };
                out.push((*p, kind));
            }
            for w in points.windows(2) {
                out.push((w[0].lerp(w[1], 0.5), PathSnapKind::Mid));
            }
        }
        _ => {}
    }
    out
}

/// Collect snap targets for peers of `component_id` on `level_id`.
///
/// Skips ids in `exclude`. Only joinable definitions with straight/open paths.
pub fn collect_joinable_snap_targets(
    registry: &ComponentRegistry,
    elements: impl Iterator<Item = Element>,
    component_id: &str,
    level_id: LevelId,
    exclude: &[ElementId],
) -> Vec<PathSnapTarget> {
    let mut out = Vec::new();
    for element in elements {
        if element.component_id != component_id {
            continue;
        }
        if element.level_id != level_id {
            continue;
        }
        if exclude.contains(&element.id) {
            continue;
        }
        let Some(seg) = joinable_segment(registry, &element) else {
            continue;
        };
        for (point, kind) in snap_points_on_curve(&seg.curve) {
            out.push(PathSnapTarget {
                point: point.to_array(),
                kind,
                element_id: element.id.to_string(),
            });
        }
    }
    out
}

/// Nearest target within `max_dist` (plan metres), preferring ends over mids.
pub fn nearest_snap_target(
    cursor: Vec3,
    targets: &[PathSnapTarget],
    max_dist: f32,
) -> Option<&PathSnapTarget> {
    let mut best: Option<(&PathSnapTarget, f32, u8)> = None;
    for t in targets {
        let p = Vec3::from_array(t.point);
        let dist = plan_distance(cursor, p);
        if dist > max_dist {
            continue;
        }
        let rank = match t.kind {
            PathSnapKind::End => 0u8,
            PathSnapKind::Vertex => 1,
            PathSnapKind::Mid => 2,
        };
        let better = match best {
            None => true,
            Some((_, bd, br)) => dist + rank as f32 * 1e-4 < bd + br as f32 * 1e-4,
        };
        if better {
            best = Some((t, dist, rank));
        }
    }
    best.map(|(t, _, _)| t)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::level::LevelId;
    use crate::param::ParamMap;
    use crate::placement::Placement;
    use crate::registry::ComponentRegistry;
    use crate::Element;

    #[test]
    fn line_exposes_ends_and_mid() {
        let curve = Curve::line(Vec3::ZERO, Vec3::new(4.0, 0.0, 0.0));
        let pts = snap_points_on_curve(&curve);
        assert_eq!(pts.len(), 3);
        assert!(pts
            .iter()
            .any(|(p, k)| { *k == PathSnapKind::End && plan_distance(*p, Vec3::ZERO) < 1e-5 }));
        assert!(pts
            .iter()
            .any(|(p, k)| { *k == PathSnapKind::Mid && (p.x - 2.0).abs() < 1e-5 }));
    }

    #[test]
    fn polyline_exposes_vertex_for_t_join() {
        let curve = Curve::Polyline {
            points: vec![
                Vec3::ZERO,
                Vec3::new(5.0, 0.0, 0.0),
                Vec3::new(10.0, 0.0, 0.0),
            ],
        };
        let pts = snap_points_on_curve(&curve);
        assert!(pts
            .iter()
            .any(|(p, k)| *k == PathSnapKind::Vertex && (p.x - 5.0).abs() < 1e-5));
    }

    #[test]
    fn nearest_prefers_end_over_nearby_mid() {
        let targets = vec![
            PathSnapTarget {
                point: [0.0, 0.0, 0.0],
                kind: PathSnapKind::End,
                element_id: "a".into(),
            },
            PathSnapTarget {
                point: [0.05, 0.0, 0.0],
                kind: PathSnapKind::Mid,
                element_id: "a".into(),
            },
        ];
        let hit = nearest_snap_target(Vec3::new(0.02, 0.0, 0.0), &targets, 0.5).unwrap();
        assert_eq!(hit.kind, PathSnapKind::End);
    }

    #[test]
    fn collect_targets_from_wall_peers() {
        let registry = ComponentRegistry::with_builtins();
        let level = LevelId::new();
        let wall = Element::new(
            "W1",
            "apex.wall",
            level,
            Placement::line(Vec3::ZERO, Vec3::new(3.0, 0.0, 0.0)),
            ParamMap::new(),
        );
        let targets = collect_joinable_snap_targets(
            &registry,
            std::iter::once(wall),
            "apex.wall",
            level,
            &[],
        );
        assert!(
            targets.len() >= 3,
            "expected ends+mid, got {}",
            targets.len()
        );
    }
}
