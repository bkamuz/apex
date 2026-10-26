//! Detect enclosed rooms from wall centerlines on a level.
//!
//! Builds a planar graph from wall path segments (endpoints snapped within a
//! tolerance), then walks faces via the left-hand rule. Arc/circle walls are
//! skipped in v1. Nested rooms and wall holes are best-effort only.

use apex_geometry::{Curve, MIN_CURVE_LENGTH};
use glam::Vec3;

use crate::element::Element;

/// Snap tolerance for wall endpoints on the plan (metres).
pub const ENDPOINT_SNAP: f32 = 0.05;
/// Ignore edges shorter than this after snapping.
const MIN_EDGE: f32 = 0.05;
/// Discard faces smaller than this area (m²) in the XZ plane.
const MIN_FACE_AREA: f32 = 0.25;

/// Extract straight centerline segments from a wall-like element.
///
/// Lines and polylines contribute edges. Arcs and circles are skipped (MVP).
pub fn wall_centerline_segments(element: &Element) -> Vec<(Vec3, Vec3)> {
    let Some(curve) = element.placement.curve() else {
        return Vec::new();
    };
    match curve {
        Curve::Line { a, b } => {
            if (*b - *a).length() >= MIN_CURVE_LENGTH {
                vec![(*a, *b)]
            } else {
                Vec::new()
            }
        }
        Curve::Polyline { points } => points
            .windows(2)
            .filter_map(|w| {
                if (w[1] - w[0]).length() >= MIN_CURVE_LENGTH {
                    Some((w[0], w[1]))
                } else {
                    None
                }
            })
            .collect(),
        Curve::Arc { .. } | Curve::Circle { .. } => Vec::new(),
    }
}

/// Find closed room polygons (XZ) from wall centerline segments.
///
/// Returns rings without a repeated closing vertex. The unbounded exterior face
/// is discarded (largest |area|). Remaining faces with sufficient area are kept.
pub fn detect_room_polygons(segments: &[(Vec3, Vec3)], snap: f32) -> Vec<Vec<Vec3>> {
    let split = split_at_junctions(segments, snap);
    let segments = split.as_slice();
    let elevation = segments.first().map(|(a, _)| a.y).unwrap_or(0.0);

    let mut nodes: Vec<[f32; 2]> = Vec::new();
    let snap_node = |nodes: &mut Vec<[f32; 2]>, p: Vec3| -> usize {
        let xz = [p.x, p.z];
        for (i, n) in nodes.iter().enumerate() {
            let dx = n[0] - xz[0];
            let dz = n[1] - xz[1];
            if dx * dx + dz * dz <= snap * snap {
                return i;
            }
        }
        nodes.push(xz);
        nodes.len() - 1
    };

    let mut undirected: Vec<(usize, usize)> = Vec::new();
    for &(a, b) in segments {
        let u = snap_node(&mut nodes, a);
        let v = snap_node(&mut nodes, b);
        if u == v {
            continue;
        }
        let (lo, hi) = if u < v { (u, v) } else { (v, u) };
        if undirected.iter().any(|&(x, y)| x == lo && y == hi) {
            continue;
        }
        let dx = nodes[u][0] - nodes[v][0];
        let dz = nodes[u][1] - nodes[v][1];
        if (dx * dx + dz * dz).sqrt() < MIN_EDGE {
            continue;
        }
        undirected.push((lo, hi));
    }

    if undirected.is_empty() {
        return Vec::new();
    }

    // Adjacency: neighbor index + undirected edge id.
    let mut adj: Vec<Vec<(usize, usize)>> = vec![Vec::new(); nodes.len()];
    for (eid, &(u, v)) in undirected.iter().enumerate() {
        adj[u].push((v, eid));
        adj[v].push((u, eid));
    }

    // Sort outgoing by angle so face walks can pick the next turn.
    for (i, outs) in adj.iter_mut().enumerate() {
        let ox = nodes[i][0];
        let oz = nodes[i][1];
        outs.sort_by(|a, b| {
            let ang_a = (nodes[a.0][1] - oz).atan2(nodes[a.0][0] - ox);
            let ang_b = (nodes[b.0][1] - oz).atan2(nodes[b.0][0] - ox);
            ang_a
                .partial_cmp(&ang_b)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
    }

    // Directed half-edges keyed by (from, to) via edge id + bit.
    // used[eid * 2] = u->v for undirected (u,v) with u < v stored as lo,hi
    // Actually store used as (from, to) set via bitset on eid*2 + direction.
    let mut used = vec![false; undirected.len() * 2];
    let dir_key = |from: usize, to: usize, eid: usize| -> usize {
        let (lo, hi) = undirected[eid];
        // bit 0: lo -> hi, bit 1: hi -> lo
        if from == lo && to == hi {
            eid * 2
        } else {
            debug_assert!(from == hi && to == lo);
            eid * 2 + 1
        }
    };

    let mut faces: Vec<Vec<usize>> = Vec::new();

    for start_from in 0..nodes.len() {
        for &(start_to, start_eid) in &adj[start_from] {
            let start_key = dir_key(start_from, start_to, start_eid);
            if used[start_key] {
                continue;
            }

            let mut ring: Vec<usize> = Vec::new();
            let mut from = start_from;
            let mut to = start_to;
            let mut eid = start_eid;
            let mut closed = false;

            for _ in 0..(undirected.len() * 2 + 2) {
                let key = dir_key(from, to, eid);
                if used[key] {
                    break;
                }
                used[key] = true;
                ring.push(from);

                // Arrive at `to` via from→to. Take the next CW outgoing (left
                // hand when walking with +Y up / atan2 CCW).
                let outs = &adj[to];
                let Some(rev_idx) = outs.iter().position(|&(n, _)| n == from) else {
                    break;
                };
                let next_idx = (rev_idx + outs.len() - 1) % outs.len();
                let (next_to, next_eid) = outs[next_idx];
                from = to;
                to = next_to;
                eid = next_eid;

                if from == start_from && to == start_to {
                    closed = true;
                    break;
                }
            }

            if closed && ring.len() >= 3 {
                faces.push(ring);
            }
        }
    }

    // Compute signed area in XZ; drop exterior (largest |area|) and tiny faces.
    let mut scored: Vec<(f32, Vec<usize>)> = faces
        .into_iter()
        .filter_map(|ring| {
            let area = signed_area_xz(&nodes, &ring);
            if area.abs() < MIN_FACE_AREA {
                return None;
            }
            Some((area, ring))
        })
        .collect();

    if scored.is_empty() {
        return Vec::new();
    }

    // Exterior face has the largest absolute area.
    let exterior_i = scored
        .iter()
        .enumerate()
        .max_by(|(_, (a, _)), (_, (b, _))| {
            a.abs()
                .partial_cmp(&b.abs())
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .map(|(i, _)| i)
        .unwrap_or(0);
    scored.remove(exterior_i);

    // Prefer CCW rings (positive area) for consistent overlay winding.
    scored
        .into_iter()
        .map(|(area, mut ring)| {
            if area < 0.0 {
                ring.reverse();
            }
            ring.into_iter()
                .map(|i| Vec3::new(nodes[i][0], elevation, nodes[i][1]))
                .collect()
        })
        .collect()
}

/// Split every segment where another segment's end point lies on its interior
/// (T-junctions, e.g. a partition ending mid-way along a polyline wall), so the
/// planar graph has a node there.
fn split_at_junctions(segments: &[(Vec3, Vec3)], snap: f32) -> Vec<(Vec3, Vec3)> {
    let ends: Vec<Vec3> = segments.iter().flat_map(|&(a, b)| [a, b]).collect();
    let mut out = Vec::with_capacity(segments.len());
    for &(a, b) in segments {
        let d = Vec3::new(b.x - a.x, 0.0, b.z - a.z);
        let len2 = d.length_squared();
        if len2 <= f32::EPSILON {
            out.push((a, b));
            continue;
        }
        let len = len2.sqrt();
        let mut ts: Vec<f32> = ends
            .iter()
            .filter_map(|p| {
                let v = Vec3::new(p.x - a.x, 0.0, p.z - a.z);
                let t = v.dot(d) / len2;
                let along = t * len;
                if along <= snap || along >= len - snap {
                    return None;
                }
                let off = (v - d * t).length();
                (off <= snap).then_some(t)
            })
            .collect();
        ts.sort_by(|x, y| x.partial_cmp(y).unwrap_or(std::cmp::Ordering::Equal));
        ts.dedup_by(|x, y| (*x - *y).abs() * len <= snap);
        let mut prev = a;
        for t in ts {
            let p = a + (b - a) * t;
            out.push((prev, p));
            prev = p;
        }
        out.push((prev, b));
    }
    out
}

fn signed_area_xz(nodes: &[[f32; 2]], ring: &[usize]) -> f32 {
    let n = ring.len();
    if n < 3 {
        return 0.0;
    }
    let mut sum = 0.0_f32;
    for i in 0..n {
        let a = nodes[ring[i]];
        let b = nodes[ring[(i + 1) % n]];
        sum += a[0] * b[1] - b[0] * a[1];
    }
    sum * 0.5
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::element::Element;
    use crate::level::LevelId;
    use crate::param::ParamMap;
    use crate::placement::Placement;

    #[test]
    fn rectangle_of_four_walls_yields_one_room() {
        let segs = [
            (Vec3::new(0.0, 0.0, 0.0), Vec3::new(4.0, 0.0, 0.0)),
            (Vec3::new(4.0, 0.0, 0.0), Vec3::new(4.0, 0.0, 3.0)),
            (Vec3::new(4.0, 0.0, 3.0), Vec3::new(0.0, 0.0, 3.0)),
            (Vec3::new(0.0, 0.0, 3.0), Vec3::new(0.0, 0.0, 0.0)),
        ];
        let rooms = detect_room_polygons(&segs, ENDPOINT_SNAP);
        assert_eq!(rooms.len(), 1, "expected one interior face");
        assert_eq!(rooms[0].len(), 4);
        let area = polygon_area(&rooms[0]);
        assert!((area - 12.0).abs() < 1e-3, "area={area}");
    }

    #[test]
    fn snapped_near_miss_endpoints_still_close() {
        let segs = [
            (Vec3::new(0.0, 0.0, 0.0), Vec3::new(4.0, 0.0, 0.0)),
            (Vec3::new(4.02, 0.0, 0.0), Vec3::new(4.0, 0.0, 3.0)),
            (Vec3::new(4.0, 0.0, 3.01), Vec3::new(0.0, 0.0, 3.0)),
            (Vec3::new(0.0, 0.0, 3.0), Vec3::new(-0.01, 0.0, 0.0)),
        ];
        let rooms = detect_room_polygons(&segs, ENDPOINT_SNAP);
        assert_eq!(rooms.len(), 1);
    }

    #[test]
    fn two_adjacent_rooms_share_a_wall() {
        // Two 4×3 rooms side by side sharing the middle wall.
        let segs = [
            (Vec3::new(0.0, 0.0, 0.0), Vec3::new(4.0, 0.0, 0.0)),
            (Vec3::new(4.0, 0.0, 0.0), Vec3::new(8.0, 0.0, 0.0)),
            (Vec3::new(8.0, 0.0, 0.0), Vec3::new(8.0, 0.0, 3.0)),
            (Vec3::new(8.0, 0.0, 3.0), Vec3::new(4.0, 0.0, 3.0)),
            (Vec3::new(4.0, 0.0, 3.0), Vec3::new(0.0, 0.0, 3.0)),
            (Vec3::new(0.0, 0.0, 3.0), Vec3::new(0.0, 0.0, 0.0)),
            (Vec3::new(4.0, 0.0, 0.0), Vec3::new(4.0, 0.0, 3.0)),
        ];
        let rooms = detect_room_polygons(&segs, ENDPOINT_SNAP);
        assert_eq!(rooms.len(), 2);
    }

    #[test]
    fn partitions_ending_mid_span_split_rooms() {
        // L-shaped polyline outline with partitions that T into its sides.
        let pts = [
            (0.0, 0.0),
            (12.0, 0.0),
            (12.0, 5.0),
            (7.0, 5.0),
            (7.0, 9.0),
            (0.0, 9.0),
            (0.0, 0.0),
        ];
        let mut segs: Vec<(Vec3, Vec3)> = pts
            .windows(2)
            .map(|w| {
                (
                    Vec3::new(w[0].0, 0.0, w[0].1),
                    Vec3::new(w[1].0, 0.0, w[1].1),
                )
            })
            .collect();
        for (a, b) in [
            ((0.0, 5.0), (7.0, 5.0)),
            ((7.0, 0.0), (7.0, 5.0)),
            ((3.5, 0.0), (3.5, 5.0)),
            ((4.0, 5.0), (4.0, 9.0)),
        ] {
            segs.push((Vec3::new(a.0, 0.0, a.1), Vec3::new(b.0, 0.0, b.1)));
        }
        let rooms = detect_room_polygons(&segs, ENDPOINT_SNAP);
        assert_eq!(rooms.len(), 5, "{rooms:?}");
        let total: f32 = rooms.iter().map(|r| polygon_area(r)).sum();
        assert!((total - 88.0).abs() < 0.01, "total {total}");
    }

    #[test]
    fn open_chain_yields_no_room() {
        let segs = [
            (Vec3::new(0.0, 0.0, 0.0), Vec3::new(4.0, 0.0, 0.0)),
            (Vec3::new(4.0, 0.0, 0.0), Vec3::new(4.0, 0.0, 3.0)),
        ];
        assert!(detect_room_polygons(&segs, ENDPOINT_SNAP).is_empty());
    }

    #[test]
    fn wall_centerline_skips_arcs() {
        let line = Element::new(
            "W",
            "apex.wall",
            LevelId::new(),
            Placement::line(Vec3::ZERO, Vec3::new(2.0, 0.0, 0.0)),
            ParamMap::new(),
        );
        assert_eq!(wall_centerline_segments(&line).len(), 1);

        let arc_placement = Placement::Curve {
            curve: Curve::arc_from_three_points(
                Vec3::ZERO,
                Vec3::new(1.0, 0.0, 1.0),
                Vec3::new(2.0, 0.0, 0.0),
            )
            .expect("arc"),
        };
        let arc = Element::new(
            "A",
            "apex.wall",
            LevelId::new(),
            arc_placement,
            ParamMap::new(),
        );
        assert!(wall_centerline_segments(&arc).is_empty());
    }

    fn polygon_area(pts: &[Vec3]) -> f32 {
        let n = pts.len();
        let mut sum = 0.0_f32;
        for i in 0..n {
            let a = pts[i];
            let b = pts[(i + 1) % n];
            sum += a.x * b.z - b.x * a.z;
        }
        (sum * 0.5).abs()
    }
}
