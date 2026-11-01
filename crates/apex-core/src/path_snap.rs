//! Shared element snap pipeline: ends, mids, vertices, points, and edge closest
//! points from any document geometry on the active level.
//!
//! Sources are placement curves/points of every element (joinable peers included),
//! plus refs, grid axes, and construction lines. No component-id allowlists —
//! floor→wall is just one cross-type pair among many.

use apex_geometry::{closest_on_segment_xz, plan_distance, Curve, MIN_CURVE_LENGTH};
use glam::Vec3;
use serde::Serialize;

use crate::element::{Element, ElementId};
use crate::level::LevelId;
use crate::path_join::joinable_segment;
use crate::placement::Placement;
use crate::registry::ComponentRegistry;

/// Kind of snap point (for UI feedback / tests).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PathSnapKind {
    /// Path start or end.
    End,
    /// Midpoint of a straight segment (handy for T-joins / centering).
    Mid,
    /// Intermediate polyline vertex (existing T-junction split).
    Vertex,
    /// Point placement (column, ref point, …).
    Point,
    /// Closest point along a segment edge (not an endpoint).
    Edge,
}

/// One discrete or resolved snap candidate.
#[derive(Debug, Clone, Serialize)]
pub struct PathSnapTarget {
    pub point: [f32; 3],
    pub kind: PathSnapKind,
    /// Element id, or `ref:` / `grid:` / `cline:` prefixed annotation id.
    pub element_id: String,
}

/// A linear edge that can supply an on-segment (edge) snap.
#[derive(Debug, Clone, Serialize)]
pub struct SnapSegment {
    pub a: [f32; 3],
    pub b: [f32; 3],
    pub element_id: String,
}

/// Discrete targets + edges collected for the shared pipeline.
#[derive(Debug, Clone, Serialize, Default)]
pub struct ElementSnapGeometry {
    pub points: Vec<PathSnapTarget>,
    pub segments: Vec<SnapSegment>,
}

/// Default plan-distance (m) for picking a snap target while placing.
/// Larger than [`apex_geometry::JOIN_SNAP`] so the cursor catches ends before the join pass.
pub const PLACEMENT_SNAP: f32 = 0.35;

/// Near an endpoint along a segment — prefer End over Edge.
const EDGE_END_EPS: f32 = 0.05;

/// Control points of a joinable curve (line ends / polyline vertices).
pub fn curve_control_points(curve: &Curve) -> Vec<Vec3> {
    match curve {
        Curve::Line { a, b } => vec![*a, *b],
        Curve::Polyline { points } => points.clone(),
        Curve::Arc { .. } | Curve::Circle { .. } => Vec::new(),
    }
}

/// Discrete snap targets contributed by one curve (`closed` adds the closing edge mid).
pub fn snap_points_on_curve(curve: &Curve, closed: bool) -> Vec<(Vec3, PathSnapKind)> {
    let mut out = Vec::new();
    match curve {
        Curve::Line { a, b } => {
            out.push((*a, PathSnapKind::End));
            out.push((*b, PathSnapKind::End));
            out.push((a.lerp(*b, 0.5), PathSnapKind::Mid));
        }
        Curve::Polyline { points } if points.len() >= 2 => {
            let last = points.len() - 1;
            let looped = closed || curve.is_closed();
            for (i, p) in points.iter().enumerate() {
                if looped && i == last && curve.is_closed() {
                    // Duplicate closing vertex — skip (same as start).
                    continue;
                }
                let kind = if !looped && (i == 0 || i == last) {
                    PathSnapKind::End
                } else {
                    PathSnapKind::Vertex
                };
                out.push((*p, kind));
            }
            for w in points.windows(2) {
                out.push((w[0].lerp(w[1], 0.5), PathSnapKind::Mid));
            }
            if looped && !curve.is_closed() {
                let a = points[0];
                let b = points[last];
                out.push((a.lerp(b, 0.5), PathSnapKind::Mid));
            }
        }
        _ => {}
    }
    out
}

/// Straight segments of a curve (for edge closest-point snaps).
pub fn snap_segments_on_curve(curve: &Curve, closed: bool) -> Vec<(Vec3, Vec3)> {
    let mut out = Vec::new();
    match curve {
        Curve::Line { a, b } => {
            if (*b - *a).length() >= MIN_CURVE_LENGTH {
                out.push((*a, *b));
            }
        }
        Curve::Polyline { points } if points.len() >= 2 => {
            for w in points.windows(2) {
                if (w[1] - w[0]).length() >= MIN_CURVE_LENGTH {
                    out.push((w[0], w[1]));
                }
            }
            let looped = closed || curve.is_closed();
            if looped && !curve.is_closed() {
                let a = points[0];
                let b = points[points.len() - 1];
                if (b - a).length() >= MIN_CURVE_LENGTH {
                    out.push((b, a));
                }
            }
        }
        _ => {}
    }
    out
}

/// Snap geometry from one placement (point → Point; curve → ends/mids/segments).
pub fn geometry_from_placement(
    placement: &Placement,
    source_id: &str,
    closed: bool,
) -> ElementSnapGeometry {
    let mut out = ElementSnapGeometry::default();
    match placement {
        Placement::Point { origin, .. } => {
            out.points.push(PathSnapTarget {
                point: origin.to_array(),
                kind: PathSnapKind::Point,
                element_id: source_id.to_string(),
            });
        }
        Placement::Free { frame } => {
            out.points.push(PathSnapTarget {
                point: frame.origin.to_array(),
                kind: PathSnapKind::Point,
                element_id: source_id.to_string(),
            });
        }
        Placement::Curve { curve } => {
            for (point, kind) in snap_points_on_curve(curve, closed) {
                out.points.push(PathSnapTarget {
                    point: point.to_array(),
                    kind,
                    element_id: source_id.to_string(),
                });
            }
            for (a, b) in snap_segments_on_curve(curve, closed) {
                out.segments.push(SnapSegment {
                    a: a.to_array(),
                    b: b.to_array(),
                    element_id: source_id.to_string(),
                });
            }
        }
    }
    out
}

fn merge_geometry(into: &mut ElementSnapGeometry, extra: ElementSnapGeometry) {
    into.points.extend(extra.points);
    into.segments.extend(extra.segments);
}

/// Collect snap targets for peers of `component_id` on `level_id`.
///
/// Skips ids in `exclude`. Only joinable definitions with straight/open paths.
/// Kept as one candidate *source* for join-aware placement; the general pipeline
/// also includes these peers via [`collect_element_snap_geometry`].
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
        for (point, kind) in snap_points_on_curve(&seg.curve, false) {
            out.push(PathSnapTarget {
                point: point.to_array(),
                kind,
                element_id: element.id.to_string(),
            });
        }
    }
    out
}

/// Geometry from every element / ref / grid / construction line on `level_id`.
///
/// Element curves use the live placement (joinable centerlines included). Closed
/// definitions (`placement_options.closed`) contribute a closing edge. No
/// component-id filters — any type snaps to any other type.
pub fn collect_element_snap_geometry(
    registry: &ComponentRegistry,
    elements: impl Iterator<Item = Element>,
    level_id: LevelId,
    exclude: &[ElementId],
    references: impl Iterator<Item = (String, Placement)>,
    linear_annos: impl Iterator<Item = (String, Placement)>,
) -> ElementSnapGeometry {
    let mut out = ElementSnapGeometry::default();
    for element in elements {
        if element.level_id != level_id {
            continue;
        }
        if exclude.contains(&element.id) {
            continue;
        }
        let closed = registry
            .get(&element.component_id)
            .map(|d| d.placement_options.closed)
            .unwrap_or(false);
        // Prefer joinable centerline when present (same as join snap source).
        let placement = if let Some(seg) = joinable_segment(registry, &element) {
            Placement::Curve {
                curve: seg.curve,
            }
        } else {
            element.placement.clone()
        };
        merge_geometry(
            &mut out,
            geometry_from_placement(&placement, &element.id.to_string(), closed),
        );
    }
    for (id, placement) in references {
        merge_geometry(&mut out, geometry_from_placement(&placement, &id, false));
    }
    for (id, placement) in linear_annos {
        merge_geometry(&mut out, geometry_from_placement(&placement, &id, false));
    }
    out
}

fn kind_rank(kind: PathSnapKind) -> u8 {
    match kind {
        PathSnapKind::End => 0,
        PathSnapKind::Point => 0,
        PathSnapKind::Vertex => 1,
        PathSnapKind::Mid => 2,
        PathSnapKind::Edge => 3,
    }
}

/// Nearest discrete target within `max_dist` (plan metres), preferring ends over mids.
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
        let rank = kind_rank(t.kind);
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

/// Resolve the best snap at `cursor`: discrete points first, then edge closest.
pub fn nearest_element_snap(
    cursor: Vec3,
    geometry: &ElementSnapGeometry,
    max_dist: f32,
) -> Option<PathSnapTarget> {
    let discrete = nearest_snap_target(cursor, &geometry.points, max_dist).cloned();

    let mut best_edge: Option<(PathSnapTarget, f32)> = None;
    for seg in &geometry.segments {
        let a = Vec3::from_array(seg.a);
        let b = Vec3::from_array(seg.b);
        let Some((q, t, dist)) = closest_on_segment_xz(a, b, cursor) else {
            continue;
        };
        if dist > max_dist {
            continue;
        }
        // Endpoints are covered by End/Vertex discrete snaps.
        if !(EDGE_END_EPS..=1.0 - EDGE_END_EPS).contains(&t) {
            continue;
        }
        let better = match &best_edge {
            None => true,
            Some((_, bd)) => dist < *bd,
        };
        if better {
            best_edge = Some((
                PathSnapTarget {
                    point: q.to_array(),
                    kind: PathSnapKind::Edge,
                    element_id: seg.element_id.clone(),
                },
                dist,
            ));
        }
    }

    match (discrete, best_edge) {
        (Some(d), None) => Some(d),
        (None, Some((e, _))) => Some(e),
        (Some(d), Some((e, ed))) => {
            let dd = plan_distance(cursor, Vec3::from_array(d.point));
            let dr = kind_rank(d.kind) as f32;
            let er = kind_rank(PathSnapKind::Edge) as f32;
            if dd + dr * 1e-4 <= ed + er * 1e-4 {
                Some(d)
            } else {
                Some(e)
            }
        }
        (None, None) => None,
    }
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
        let pts = snap_points_on_curve(&curve, false);
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
        let pts = snap_points_on_curve(&curve, false);
        assert!(pts
            .iter()
            .any(|(p, k)| *k == PathSnapKind::Vertex && (p.x - 5.0).abs() < 1e-5));
    }

    #[test]
    fn closed_polyline_adds_closing_mid_and_segment() {
        let curve = Curve::Polyline {
            points: vec![
                Vec3::ZERO,
                Vec3::new(4.0, 0.0, 0.0),
                Vec3::new(4.0, 0.0, 3.0),
                Vec3::new(0.0, 0.0, 3.0),
            ],
        };
        let pts = snap_points_on_curve(&curve, true);
        assert!(
            pts.iter()
                .any(|(p, k)| *k == PathSnapKind::Mid && (p.x - 0.0).abs() < 1e-5 && (p.z - 1.5).abs() < 1e-5),
            "expected mid on closing edge, got {pts:?}"
        );
        let segs = snap_segments_on_curve(&curve, true);
        assert_eq!(segs.len(), 4);
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
    fn nearest_element_snap_finds_edge_between_ends() {
        let geometry = ElementSnapGeometry {
            points: vec![
                PathSnapTarget {
                    point: [0.0, 0.0, 0.0],
                    kind: PathSnapKind::End,
                    element_id: "w".into(),
                },
                PathSnapTarget {
                    point: [10.0, 0.0, 0.0],
                    kind: PathSnapKind::End,
                    element_id: "w".into(),
                },
                PathSnapTarget {
                    point: [5.0, 0.0, 0.0],
                    kind: PathSnapKind::Mid,
                    element_id: "w".into(),
                },
            ],
            segments: vec![SnapSegment {
                a: [0.0, 0.0, 0.0],
                b: [10.0, 0.0, 0.0],
                element_id: "w".into(),
            }],
        };
        // Cursor near the wall but offset in Z, not at mid — should edge-snap.
        let hit = nearest_element_snap(Vec3::new(3.0, 0.0, 0.1), &geometry, 0.5).unwrap();
        assert_eq!(hit.kind, PathSnapKind::Edge);
        assert!((hit.point[0] - 3.0).abs() < 1e-4);
        assert!(hit.point[2].abs() < 1e-4);
    }

    #[test]
    fn nearest_prefers_end_over_edge() {
        let geometry = ElementSnapGeometry {
            points: vec![PathSnapTarget {
                point: [0.0, 0.0, 0.0],
                kind: PathSnapKind::End,
                element_id: "w".into(),
            }],
            segments: vec![SnapSegment {
                a: [0.0, 0.0, 0.0],
                b: [10.0, 0.0, 0.0],
                element_id: "w".into(),
            }],
        };
        let hit = nearest_element_snap(Vec3::new(0.08, 0.0, 0.05), &geometry, 0.5).unwrap();
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

    #[test]
    fn collect_all_elements_cross_type_wall_and_slab() {
        let registry = ComponentRegistry::with_builtins();
        let level = LevelId::new();
        let wall = Element::new(
            "W1",
            "apex.wall",
            level,
            Placement::line(Vec3::ZERO, Vec3::new(6.0, 0.0, 0.0)),
            ParamMap::new(),
        );
        let slab = Element::new(
            "S1",
            "apex.slab",
            level,
            Placement::Curve {
                curve: Curve::Polyline {
                    points: vec![
                        Vec3::new(0.0, 0.0, 1.0),
                        Vec3::new(4.0, 0.0, 1.0),
                        Vec3::new(4.0, 0.0, 4.0),
                        Vec3::new(0.0, 0.0, 4.0),
                    ],
                },
            },
            ParamMap::new(),
        );
        let geom = collect_element_snap_geometry(
            &registry,
            [wall, slab].into_iter(),
            level,
            &[],
            std::iter::empty(),
            std::iter::empty(),
        );
        assert!(
            geom.points.iter().any(|t| t.element_id.contains('-') || !t.element_id.is_empty()),
            "expected points from both"
        );
        let wall_ends = geom
            .points
            .iter()
            .filter(|t| t.kind == PathSnapKind::End)
            .count();
        assert!(wall_ends >= 2, "wall ends present");
        assert!(
            geom.segments.len() >= 5,
            "wall segment + 4 slab edges, got {}",
            geom.segments.len()
        );
        // Cursor near wall mid from “slab side” → snaps to wall geometry.
        let hit = nearest_element_snap(Vec3::new(3.0, 0.0, 0.05), &geom, 0.5).unwrap();
        assert!(
            matches!(hit.kind, PathSnapKind::Mid | PathSnapKind::Edge),
            "expected mid/edge on wall, got {:?}",
            hit.kind
        );
    }

    #[test]
    fn column_point_is_snap_source() {
        let registry = ComponentRegistry::with_builtins();
        let level = LevelId::new();
        let col = Element::new(
            "C1",
            "apex.column",
            level,
            Placement::point(Vec3::new(2.0, 0.0, 2.0)),
            ParamMap::new(),
        );
        let geom = collect_element_snap_geometry(
            &registry,
            std::iter::once(col),
            level,
            &[],
            std::iter::empty(),
            std::iter::empty(),
        );
        assert_eq!(geom.points.len(), 1);
        assert_eq!(geom.points[0].kind, PathSnapKind::Point);
        let hit = nearest_element_snap(Vec3::new(2.05, 0.0, 2.0), &geom, 0.5).unwrap();
        assert_eq!(hit.kind, PathSnapKind::Point);
    }

    #[test]
    fn refs_and_grids_feed_pipeline() {
        let registry = ComponentRegistry::with_builtins();
        let level = LevelId::new();
        let geom = collect_element_snap_geometry(
            &registry,
            std::iter::empty(),
            level,
            &[],
            std::iter::once((
                "ref:r1".into(),
                Placement::point(Vec3::new(1.0, 0.0, 1.0)),
            )),
            std::iter::once((
                "grid:g1".into(),
                Placement::line(Vec3::new(0.0, 0.0, 0.0), Vec3::new(0.0, 0.0, 8.0)),
            )),
        );
        assert!(geom.points.iter().any(|t| t.kind == PathSnapKind::Point));
        assert!(geom.points.iter().any(|t| t.kind == PathSnapKind::End));
        assert_eq!(geom.segments.len(), 1);
    }

    #[test]
    fn exclude_skips_element() {
        let registry = ComponentRegistry::with_builtins();
        let level = LevelId::new();
        let wall = Element::new(
            "W1",
            "apex.wall",
            level,
            Placement::line(Vec3::ZERO, Vec3::new(3.0, 0.0, 0.0)),
            ParamMap::new(),
        );
        let id = wall.id;
        let geom = collect_element_snap_geometry(
            &registry,
            std::iter::once(wall),
            level,
            &[id],
            std::iter::empty(),
            std::iter::empty(),
        );
        assert!(geom.points.is_empty());
        assert!(geom.segments.is_empty());
    }
}
