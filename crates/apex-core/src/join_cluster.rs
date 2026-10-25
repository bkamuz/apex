//! Join clusters: united plan cut outlines and end-cap connectivity.

use std::collections::{BTreeMap, HashMap, HashSet};

use apex_geometry::{
    path_footprint_union, plan_distance, segment_intersect_xz, union_contours, Contour2, Curve,
    Frame, Point2, Profile, JOIN_SNAP,
};
use glam::Vec3;

use crate::element::{ComponentId, Element, ElementId};
use crate::level::LevelId;
use crate::path_join::{joinable_segment, JoinableSegment, PATH_JOIN_SNAP};
use crate::registry::ComponentRegistry;

/// Whether an open path end should keep its end cap in the 3D mesh.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct JoinConnectivity {
    pub cap_start: bool,
    pub cap_end: bool,
}

impl JoinConnectivity {
    pub fn open() -> Self {
        Self {
            cap_start: true,
            cap_end: true,
        }
    }
}

/// Flat plan-view fill for a united join outline (pick id 0 in the scene).
pub fn plan_fill_from_outline(points: &[Vec3]) -> Option<(Vec<f32>, Vec<f32>, Vec<u32>)> {
    if points.len() < 3 {
        return None;
    }
    let y = points[0].y;
    let outer: Vec<Point2> = points.iter().map(|p| [p.x, p.z]).collect();
    let profile = Profile::new(outer, vec![]).ok()?;
    let outline = profile.loops().first()?.clone();
    let tris = profile.triangulate().ok()?;
    let frame = Frame::horizontal(y);
    let mut positions = Vec::with_capacity(outline.len() * 3);
    for p in &outline {
        let v = frame.point(p[0], p[1]);
        positions.extend_from_slice(&[v.x, v.y, v.z]);
    }
    let normal = [0.0f32, 1.0, 0.0];
    let normals: Vec<f32> = outline.iter().flat_map(|_| normal).collect();
    let mut indices = Vec::with_capacity(tris.len() * 3);
    for t in tris {
        indices.extend_from_slice(&[t[0] as u32, t[1] as u32, t[2] as u32]);
    }
    Some((positions, normals, indices))
}

/// One merged plan outline for a connected join cluster (2+ elements).
#[derive(Debug, Clone)]
pub struct JoinClusterOutline {
    pub level_id: LevelId,
    pub component_id: ComponentId,
    pub element_ids: Vec<ElementId>,
    /// Closed XZ loop as world-space points on the level (Y from first element).
    pub points: Vec<Vec3>,
}

fn curve_segments(curve: &Curve) -> Vec<(Vec3, Vec3)> {
    match curve {
        Curve::Line { a, b } => vec![(*a, *b)],
        Curve::Polyline { points } => points.windows(2).map(|w| (w[0], w[1])).collect(),
        _ => Vec::new(),
    }
}

fn segments_linked(a: &Curve, b: &Curve) -> bool {
    let segs_a = curve_segments(a);
    let segs_b = curve_segments(b);
    for (a0, a1) in &segs_a {
        for (b0, b1) in &segs_b {
            for p in [*a0, *a1] {
                for q in [*b0, *b1] {
                    if plan_distance(p, q) <= JOIN_SNAP {
                        return true;
                    }
                }
            }
            for p in [*a0, *a1] {
                if apex_geometry::closest_on_segment_xz(*b0, *b1, p)
                    .is_some_and(|(_, t, d)| d <= PATH_JOIN_SNAP && (0.0..=1.0).contains(&t))
                {
                    return true;
                }
                if apex_geometry::closest_on_segment_xz(*a0, *a1, p)
                    .is_some_and(|(_, t, d)| d <= PATH_JOIN_SNAP && (0.0..=1.0).contains(&t))
                {
                    return true;
                }
            }
            if segment_intersect_xz(*a0, *a1, *b0, *b1, 1e-4).is_some() {
                return true;
            }
        }
    }
    false
}

/// Signed area in XZ (positive = CCW outer loop).
fn signed_area_xz(contour: &Contour2) -> f32 {
    let mut a = 0.0f32;
    for w in contour.windows(2) {
        a += w[0][0] * w[1][1] - w[1][0] * w[0][1];
    }
    if let (Some(first), Some(last)) = (contour.first(), contour.last()) {
        a += last[0] * first[1] - first[0] * last[1];
    }
    a * 0.5
}

/// Outermost loops after a boolean union (drop holes / sliver inners).
fn outermost_contours(contours: &[Contour2]) -> Vec<Contour2> {
    if contours.is_empty() {
        return Vec::new();
    }
    let candidates: Vec<Contour2> = contours
        .iter()
        .filter(|c| c.len() >= 3 && signed_area_xz(c).abs() > 1e-5)
        .cloned()
        .collect();
    if candidates.is_empty() {
        return Vec::new();
    }
    let max_area = candidates
        .iter()
        .map(|c| signed_area_xz(c).abs())
        .fold(0.0f32, f32::max);
    candidates
        .into_iter()
        .filter(|c| signed_area_xz(c).abs() >= max_area * 0.85)
        .collect()
}

/// Extrude a closed XZ outline to a solid wall block (world Y up).
pub fn extrude_outline_to_mesh(points: &[Vec3], height: f32) -> (Vec<f32>, Vec<f32>, Vec<u32>) {
    if points.len() < 3 || height <= 1e-4 {
        return (Vec::new(), Vec::new(), Vec::new());
    }
    let y0 = points[0].y;
    let y1 = y0 + height;
    let n = points.len();
    let mut positions = Vec::with_capacity(n * 6);
    let mut normals = Vec::with_capacity(n * 6);
    let mut indices = Vec::new();

    for p in points {
        positions.extend_from_slice(&[p.x, y0, p.z]);
        normals.push(0.0);
        normals.push(-1.0);
        normals.push(0.0);
    }
    let bottom_base = 0u32;
    for p in points {
        positions.extend_from_slice(&[p.x, y1, p.z]);
        normals.push(0.0);
        normals.push(1.0);
        normals.push(0.0);
    }
    let top_base = n as u32;

    for i in 0..n {
        let j = (i + 1) % n;
        let ax = points[i].x;
        let az = points[i].z;
        let bx = points[j].x;
        let bz = points[j].z;
        let dx = bx - ax;
        let dz = bz - az;
        let len = (dx * dx + dz * dz).sqrt().max(1e-6);
        let nx = dz / len;
        let nz = -dx / len;
        let side_base = positions.len() / 3;
        for k in 0..4 {
            let (x, y, z) = match k {
                0 => (ax, y0, az),
                1 => (bx, y0, bz),
                2 => (bx, y1, bz),
                _ => (ax, y1, az),
            };
            positions.extend_from_slice(&[x, y, z]);
            normals.extend_from_slice(&[nx, 0.0, nz]);
        }
        let b = side_base as u32;
        indices.extend_from_slice(&[b, b + 1, b + 2, b, b + 2, b + 3]);
    }

    let outline: Vec<Point2> = points.iter().map(|p| [p.x, p.z]).collect();
    if let Ok(profile) = Profile::new(outline, vec![]) {
        if let Ok(tris) = profile.triangulate() {
            for t in tris {
                indices.extend_from_slice(&[
                    top_base + t[0] as u32,
                    top_base + t[1] as u32,
                    top_base + t[2] as u32,
                ]);
            }
        }
    }
    let _ = bottom_base;
    (positions, normals, indices)
}

/// Build connectivity from coincident / T-snapped ends among joinable segments.
pub fn join_connectivity(
    segments: &[JoinableSegment],
    curves: &BTreeMap<ElementId, apex_geometry::Curve>,
    join_start: &BTreeMap<ElementId, f32>,
    join_end: &BTreeMap<ElementId, f32>,
) -> HashMap<ElementId, JoinConnectivity> {
    let mut out: HashMap<ElementId, JoinConnectivity> = segments
        .iter()
        .map(|s| (s.id, JoinConnectivity::open()))
        .collect();

    for seg in segments {
        let curve = curves.get(&seg.id).unwrap_or(&seg.curve);
        for at_start in [true, false] {
            let settings = if at_start {
                seg.join_start_settings
            } else {
                seg.join_end_settings
            };
            if !settings.allow_join {
                continue;
            }
            let tip = if at_start { curve.start() } else { curve.end() };
            let mut connected = false;
            for other in segments {
                if other.id == seg.id {
                    continue;
                }
                let ocurve = curves.get(&other.id).unwrap_or(&other.curve);
                for peer_at_start in [true, false] {
                    let peer_settings = if peer_at_start {
                        other.join_start_settings
                    } else {
                        other.join_end_settings
                    };
                    if !peer_settings.allow_join {
                        continue;
                    }
                    let peer_tip = if peer_at_start {
                        ocurve.start()
                    } else {
                        ocurve.end()
                    };
                    if plan_distance(tip, peer_tip) <= PATH_JOIN_SNAP {
                        connected = true;
                        break;
                    }
                }
                if connected {
                    break;
                }
                if let Some((_, t, dist)) =
                    apex_geometry::closest_on_segment_xz(ocurve.start(), ocurve.end(), tip)
                {
                    if dist <= PATH_JOIN_SNAP && (0.0..=1.0).contains(&t) {
                        connected = true;
                        break;
                    }
                }
            }
            if connected {
                let entry = out.get_mut(&seg.id).expect("segment");
                if at_start {
                    entry.cap_start = false;
                } else {
                    entry.cap_end = false;
                }
            }
            let _ = join_start;
            let _ = join_end;
        }
    }
    out
}

/// Connected components among joinable elements on a level (same component id).
pub fn join_clusters_for_level<'a>(
    registry: &ComponentRegistry,
    elements: impl IntoIterator<Item = &'a Element>,
    level_id: LevelId,
    component_id: &str,
) -> (Vec<JoinClusterOutline>, HashMap<ElementId, usize>) {
    let elements: Vec<&Element> = elements.into_iter().collect();
    let mut segments = Vec::new();
    let mut y_by_id: HashMap<ElementId, f32> = HashMap::new();
    for el in &elements {
        if el.level_id != level_id || el.component_id != component_id {
            continue;
        }
        if let Some(seg) = joinable_segment(registry, el) {
            y_by_id.insert(el.id, el.placement.origin().y);
            segments.push(seg);
        }
    }
    if segments.len() < 2 {
        return (Vec::new(), HashMap::new());
    }

    let mut parent: HashMap<ElementId, ElementId> = segments.iter().map(|s| (s.id, s.id)).collect();
    fn find(parent: &mut HashMap<ElementId, ElementId>, id: ElementId) -> ElementId {
        let p = *parent.get(&id).unwrap_or(&id);
        if p != id {
            let root = find(parent, p);
            parent.insert(id, root);
            root
        } else {
            id
        }
    }
    fn unite(parent: &mut HashMap<ElementId, ElementId>, a: ElementId, b: ElementId) {
        let ra = find(parent, a);
        let rb = find(parent, b);
        if ra != rb {
            parent.insert(rb, ra);
        }
    }

    for i in 0..segments.len() {
        for j in (i + 1)..segments.len() {
            if segments_linked(&segments[i].curve, &segments[j].curve) {
                unite(&mut parent, segments[i].id, segments[j].id);
            }
        }
    }
    // Endpoint snaps (after join splits / polyline vertices).
    let mut tips: Vec<(ElementId, Vec3)> = Vec::new();
    for seg in &segments {
        let c = &seg.curve;
        tips.push((seg.id, c.start()));
        tips.push((seg.id, c.end()));
    }
    for i in 0..tips.len() {
        for j in (i + 1)..tips.len() {
            if tips[i].0 == tips[j].0 {
                continue;
            }
            if plan_distance(tips[i].1, tips[j].1) <= PATH_JOIN_SNAP {
                unite(&mut parent, tips[i].0, tips[j].0);
            }
        }
    }

    let mut groups: BTreeMap<ElementId, Vec<&JoinableSegment>> = BTreeMap::new();
    for seg in &segments {
        let root = find(&mut parent, seg.id);
        groups.entry(root).or_default().push(seg);
    }

    let mut outlines = Vec::new();
    let mut membership = HashMap::new();
    for (cluster_idx, (_root, group)) in groups.into_iter().enumerate() {
        if group.len() < 2 {
            continue;
        }
        let mut contours: Vec<Contour2> = Vec::new();
        let mut ids = Vec::new();
        for seg in &group {
            ids.push(seg.id);
            membership.insert(seg.id, cluster_idx);
            contours.extend(path_footprint_union(
                &seg.curve,
                seg.half_width,
                seg.join_start,
                seg.join_end,
            ));
        }
        let merged = union_contours(&contours);
        let outers = outermost_contours(&merged);
        let y = group
            .first()
            .and_then(|s| y_by_id.get(&s.id).copied())
            .unwrap_or(0.0);
        for outer in outers {
            let points: Vec<Vec3> = outer.iter().map(|[x, z]| Vec3::new(*x, y, *z)).collect();
            if points.len() >= 3 {
                outlines.push(JoinClusterOutline {
                    level_id,
                    component_id: component_id.to_string(),
                    element_ids: ids.clone(),
                    points,
                });
            }
        }
    }
    (outlines, membership)
}

/// All join cluster outlines on the document (per level × joinable component type).
pub fn all_join_cluster_outlines<'a>(
    registry: &ComponentRegistry,
    elements: impl Iterator<Item = &'a Element>,
) -> Vec<JoinClusterOutline> {
    let elements: Vec<&Element> = elements.collect();
    let mut keys: HashSet<(LevelId, ComponentId)> = HashSet::new();
    for el in &elements {
        let Some(def) = registry.get(&el.component_id) else {
            continue;
        };
        if def.joinable {
            keys.insert((el.level_id, el.component_id.clone()));
        }
    }
    let mut out = Vec::new();
    for (level_id, component_id) in keys {
        let (clusters, _) =
            join_clusters_for_level(registry, elements.iter().copied(), level_id, &component_id);
        out.extend(clusters);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::param::ParamMap;
    use crate::placement::Placement;
    use crate::project::Project;
    use glam::Vec3;

    fn wall_line(project: &mut Project, a: Vec3, b: Vec3) {
        let level = project.document().active_level_id().expect("level");
        let _ = project
            .create_element(
                "apex.wall",
                Placement::line(a, b),
                ParamMap::new().with("height", crate::param::ParamValue::Length(3.0)),
            )
            .expect("wall");
        let _ = level;
    }

    #[test]
    fn room_x_and_t_walls_form_one_cluster_with_outline() {
        let mut project = Project::new();
        // 6×6 m room centred at origin in XZ
        wall_line(
            &mut project,
            Vec3::new(-3.0, 0.0, -3.0),
            Vec3::new(3.0, 0.0, -3.0),
        );
        wall_line(
            &mut project,
            Vec3::new(3.0, 0.0, -3.0),
            Vec3::new(3.0, 0.0, 3.0),
        );
        wall_line(
            &mut project,
            Vec3::new(3.0, 0.0, 3.0),
            Vec3::new(-3.0, 0.0, 3.0),
        );
        wall_line(
            &mut project,
            Vec3::new(-3.0, 0.0, 3.0),
            Vec3::new(-3.0, 0.0, -3.0),
        );
        wall_line(
            &mut project,
            Vec3::new(-3.0, 0.0, 0.0),
            Vec3::new(3.0, 0.0, 0.0),
        );
        wall_line(
            &mut project,
            Vec3::new(0.0, 0.0, -3.0),
            Vec3::new(0.0, 0.0, 3.0),
        );
        wall_line(
            &mut project,
            Vec3::new(0.0, 0.0, 3.0),
            Vec3::new(0.0, 0.0, 6.0),
        );
        wall_line(
            &mut project,
            Vec3::new(3.0, 0.0, 0.0),
            Vec3::new(6.0, 0.0, 0.0),
        );
        wall_line(
            &mut project,
            Vec3::new(6.0, 0.0, 0.0),
            Vec3::new(6.0, 0.0, -2.0),
        );

        let clusters = all_join_cluster_outlines(project.registry(), project.document().elements());
        assert!(
            !clusters.is_empty(),
            "expected at least one join cluster outline"
        );
        let ids_in_clusters: HashSet<_> = clusters
            .iter()
            .flat_map(|c| c.element_ids.iter().copied())
            .collect();
        assert!(
            ids_in_clusters.len() >= 8,
            "most walls should share a cluster, got {}",
            ids_in_clusters.len()
        );

        let buffers = project.build_scene_buffers();
        assert!(
            buffers.join_outline_edges.len() > 24,
            "expected united outline segments"
        );
        assert!(
            buffers.join_cluster_pick_ids.len() >= 8,
            "cluster members hidden, got {}",
            buffers.join_cluster_pick_ids.len()
        );
        assert!(
            buffers.indices.len() > buffers.elements.len() * 12,
            "cluster extrusion/fill adds mesh beyond per-wall boxes"
        );
    }
}
