//! Join clusters: united plan cut outlines and end-cap connectivity.

use std::collections::{BTreeMap, HashMap, HashSet};

use apex_geometry::{path_footprint_union, plan_distance, union_contours, Contour2, JOIN_SNAP};
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

/// One merged plan outline for a connected join cluster (2+ elements).
#[derive(Debug, Clone)]
pub struct JoinClusterOutline {
    pub level_id: LevelId,
    pub component_id: ComponentId,
    pub element_ids: Vec<ElementId>,
    /// Closed XZ loop as world-space points on the level (Y from first element).
    pub points: Vec<Vec3>,
}

fn curve_endpoints(curve: &apex_geometry::Curve) -> (Vec3, Vec3) {
    (curve.start(), curve.end())
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
                    if dist <= PATH_JOIN_SNAP && (0.02..=0.98).contains(&t) {
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
        let ci = segments[i].curve.clone();
        let (a0, a1) = curve_endpoints(&ci);
        for j in (i + 1)..segments.len() {
            let cj = segments[j].curve.clone();
            let (b0, b1) = curve_endpoints(&cj);
            let mut linked = false;
            for p in [a0, a1] {
                for q in [b0, b1] {
                    if plan_distance(p, q) <= JOIN_SNAP {
                        linked = true;
                        break;
                    }
                }
                if linked {
                    break;
                }
            }
            if !linked {
                for p in [a0, a1] {
                    if apex_geometry::closest_on_segment_xz(b0, b1, p)
                        .is_some_and(|(_, t, d)| d <= JOIN_SNAP && (0.02..=0.98).contains(&t))
                    {
                        linked = true;
                        break;
                    }
                }
            }
            if linked {
                unite(&mut parent, segments[i].id, segments[j].id);
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
        let Some(outer) = merged.into_iter().next() else {
            continue;
        };
        let y = group
            .first()
            .and_then(|s| y_by_id.get(&s.id).copied())
            .unwrap_or(0.0);
        let points: Vec<Vec3> = outer.iter().map(|[x, z]| Vec3::new(*x, y, *z)).collect();
        if points.len() >= 3 {
            outlines.push(JoinClusterOutline {
                level_id,
                component_id: component_id.to_string(),
                element_ids: ids,
                points,
            });
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
