//! A site line seated on the cached terrain cover.
//!
//! The uncut mesh is cached by the cover fingerprint, the path and the
//! evaluated params. A terrain edit rebuilds the lines on that level; an
//! unrelated edit hits the cache and does not sample the terrain again.
//! Hosted gates punch the cached mesh on the way out, so the cache stays the
//! uncut solid.

use std::hash::{Hash, Hasher};

use apex_geometry::{
    posts_along, profile_line, profile_segments, repeated_line, LineProfile, RepeatedLine,
    TerrainSampler, TriangleMesh, JOINT_GAP,
};
use glam::Vec3;

use crate::element::{Element, ElementId};
use crate::param::ParamMap;
use crate::registry::SITE_LINE;

use super::drape::CachedSiteLine;
use super::Project;

const EMBED: f64 = 0.02;
/// How far a gate void reaches below the line, so posts in a valley are cut.
const VOID_BELOW: f32 = 4.0;
const LINE_CAP: usize = 64;

impl Project {
    /// Uncut site-line mesh, or `None` when `element` is not a site line.
    pub(super) fn site_line_mesh(&self, element: &Element) -> Option<TriangleMesh> {
        if element.component_id != SITE_LINE {
            return None;
        }
        Some(self.cached_site_line(element).mesh)
    }

    /// Site lines on the same level as a terrain element, plus the openings
    /// hosted on a site line. A terrain edit rebuilds the lines and their
    /// gates; editing the line itself rebuilds only the gates (the line
    /// mesh is already fresh).
    pub(super) fn site_line_dependents(&self, element: &Element) -> Vec<ElementId> {
        let lines: Vec<ElementId> = if self.is_topo_element(element) {
            let level = self
                .document
                .effective_level_id(element.id)
                .unwrap_or(element.level_id);
            self.document
                .elements_on_level(level)
                .into_iter()
                .filter(|id| {
                    self.document
                        .get_element(*id)
                        .is_some_and(|e| e.component_id == SITE_LINE)
                })
                .collect()
        } else if element.component_id == SITE_LINE {
            vec![element.id]
        } else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for id in lines {
            if self.is_topo_element(element) {
                out.push(id);
            }
            out.extend(self.hosted_openings(id));
        }
        out
    }

    fn hosted_openings(&self, host_id: ElementId) -> Vec<ElementId> {
        self.document
            .children_of(host_id)
            .into_iter()
            .filter(|id| {
                self.document.get_element(*id).is_some_and(|child| {
                    self.registry
                        .get(&child.component_id)
                        .is_some_and(|def| def.host_cut.is_some())
                })
            })
            .collect()
    }

    /// World Y of the seated line at plan `(x, z)`.
    ///
    /// The stored path stays at the level. The mesh, a gate leaf, and the
    /// gate void use this height instead, so a line that starts on high
    /// ground or carries an elevation offset is cut where it actually is.
    pub(crate) fn site_line_height_at(&self, host: &Element, x: f64, z: f64) -> Option<f64> {
        if host.component_id != SITE_LINE {
            return None;
        }
        let cached = self.cached_site_line(host);
        if let Some(stones) = &cached.stones {
            return height_on_segments(stones, x, z);
        }
        height_on_polyline(&cached.polyline, x, z)
    }

    /// Gate voids. Genus openings are included: the punch is an AABB, not a
    /// kernel boolean, and it extends below the line so buried posts are cut.
    pub(super) fn site_line_voids(
        &self,
        host_id: ElementId,
    ) -> Vec<(f32, Vec3, [f32; 3], [f32; 3])> {
        let Some(host) = self.document.get_element(host_id) else {
            return Vec::new();
        };
        if host.component_id != SITE_LINE {
            return Vec::new();
        }
        let Some(host_def) = self.registry.get(&host.component_id) else {
            return Vec::new();
        };
        let mut voids = Vec::new();
        for child_id in self.document.children_of(host_id) {
            let Some(child) = self.document.get_element(child_id) else {
                continue;
            };
            let Some(child_def) = self.registry.get(&child.component_id) else {
                continue;
            };
            let Some(cut) = &child_def.host_cut else {
                continue;
            };
            if !cut
                .host_categories
                .iter()
                .any(|category| category == &host_def.category)
            {
                continue;
            }
            let Some((mut min, mut max)) = super::opening_void_aabb(child, child_def) else {
                continue;
            };
            let origin = child.placement.origin();
            if let Some(y) = self.site_line_height_at(host, origin.x as f64, origin.z as f64) {
                let dy = y as f32 - origin.y;
                min[1] += dy;
                max[1] += dy;
            }
            min[1] -= VOID_BELOW;
            max[1] += 0.5;
            let yaw = self.hosted_opening_yaw(child).unwrap_or(0.0);
            voids.push((yaw, origin, min, max));
        }
        voids
    }

    fn cached_site_line(&self, element: &Element) -> CachedSiteLine {
        let anchors = element.placement.anchors();
        let Ok(params) = self
            .registry
            .eval_params(&element.component_id, &element.params)
        else {
            return CachedSiteLine {
                key: 0,
                mesh: TriangleMesh::empty(),
                polyline: Vec::new(),
                stones: None,
            };
        };
        let cover = self.terrain_cover(element);
        let cover_key = cover.as_ref().map(|(key, _)| *key).unwrap_or(0);
        let key = fingerprint(&anchors, &params, cover_key);
        if let Some(hit) = self.drape_cache().lines.get(&element.id) {
            if hit.key == key {
                return hit.clone();
            }
        }
        let sampler = cover
            .as_ref()
            .map(|(_, facets)| TerrainSampler::new(facets));
        let sample = |x: f64, z: f64| sampler.as_ref().and_then(|s| s.height_at(x, z));
        let seating = params.text("seating").unwrap_or("level_from_start");
        let offset = params.number("elevation_offset").unwrap_or(0.0);
        let points = seated(&anchors, seating, offset, &sample);
        let each = seating == "each_object";
        let (mesh, polyline, stones) = if anchors.len() < 2 {
            (TriangleMesh::empty(), Vec::new(), None)
        } else if params.text("content") == Some("profile") {
            let stones = profile_stones(&anchors, &points, &params, &sample);
            let mesh = match &stones {
                Some(pieces) => {
                    let mut mesh = TriangleMesh::empty();
                    let spec = line_profile(&params);
                    for piece in pieces {
                        mesh.append(&profile_line(piece, &spec));
                    }
                    mesh
                }
                None => profile_line(&points, &line_profile(&params)),
            };
            (mesh, points, stones)
        } else {
            let spacing = params.number("post_spacing").unwrap_or(2.0);
            let mesh = repeated_line(
                &points,
                &sample,
                &RepeatedLine {
                    post_height: params.number("post_height").unwrap_or(1.6),
                    post_size: params.number("post_size").unwrap_or(0.12),
                    spacing,
                    panel_height: params.number("panel_height").unwrap_or(1.4),
                    panel_thickness: params.number("panel_thickness").unwrap_or(0.04),
                    embed: EMBED,
                    on_terrain: each,
                    lift: offset,
                },
            );
            let polyline = if each {
                posts_along(&points, spacing, true, offset, &sample)
            } else {
                points
            };
            (mesh, polyline, None)
        };
        let cached = CachedSiteLine {
            key,
            mesh,
            polyline,
            stones,
        };
        let mut cache = self.drape_cache();
        if cache.lines.len() >= LINE_CAP {
            cache.lines.clear();
        }
        cache.lines.insert(element.id, cached.clone());
        cached
    }
}

fn fingerprint(anchors: &[Vec3], params: &ParamMap, cover: u64) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    cover.hash(&mut hasher);
    for key in ["seating", "content"] {
        hasher.write(params.text(key).unwrap_or("").as_bytes());
    }
    for key in [
        "elevation_offset",
        "post_height",
        "post_spacing",
        "post_size",
        "panel_height",
        "panel_thickness",
        "profile_width",
        "profile_height",
        "segment_length",
    ] {
        params
            .number(key)
            .unwrap_or(0.0)
            .to_bits()
            .hash(&mut hasher);
    }
    for p in anchors {
        p.x.to_bits().hash(&mut hasher);
        p.y.to_bits().hash(&mut hasher);
        p.z.to_bits().hash(&mut hasher);
    }
    hasher.finish()
}

fn line_profile(params: &ParamMap) -> LineProfile {
    LineProfile {
        width: params.number("profile_width").unwrap_or(0.15),
        height: params.number("profile_height").unwrap_or(0.15),
    }
}

/// Seated stones, when the profile is segmented. `None` is one continuous piece.
fn profile_stones(
    anchors: &[Vec3],
    seated_points: &[[f64; 3]],
    params: &ParamMap,
    sample: &impl Fn(f64, f64) -> Option<f64>,
) -> Option<Vec<[[f64; 3]; 2]>> {
    let segment = params.number("segment_length").unwrap_or(0.0);
    if segment < 0.05 || seated_points.len() < 2 {
        return None;
    }
    let offset = params.number("elevation_offset").unwrap_or(0.0);
    // Level from start keeps every stone on one elevation. By ends and
    // each-object both sit a stone on the terrain under its own two ends.
    let level = params.text("seating") == Some("level_from_start");
    let y_level = seated_points.first().map(|p| p[1]).unwrap_or(0.0);
    let source: Vec<[f64; 3]> = if level {
        seated_points.to_vec()
    } else {
        anchors
            .iter()
            .map(|p| [p.x as f64, p.y as f64, p.z as f64])
            .collect()
    };
    let mut stones = Vec::new();
    for piece in profile_segments(&source, segment, JOINT_GAP) {
        let mut a = piece[0];
        let mut b = piece[1];
        if level {
            a[1] = y_level;
            b[1] = y_level;
        } else {
            let y = |p: [f64; 3]| sample(p[0], p[2]).unwrap_or(p[1]) + offset;
            a[1] = y(a);
            b[1] = y(b);
        }
        stones.push([a, b]);
    }
    Some(stones)
}

/// Height of the closest point on the seated polyline.
fn height_on_polyline(points: &[[f64; 3]], x: f64, z: f64) -> Option<f64> {
    let mut best: Option<(f64, f64)> = None;
    for w in points.windows(2) {
        let (ax, ay, az) = (w[0][0], w[0][1], w[0][2]);
        let (bx, by, bz) = (w[1][0], w[1][1], w[1][2]);
        let (dx, dz) = (bx - ax, bz - az);
        let len2 = dx * dx + dz * dz;
        if len2 < 1e-12 {
            continue;
        }
        let t = (((x - ax) * dx + (z - az) * dz) / len2).clamp(0.0, 1.0);
        let d2 = (x - (ax + t * dx)).powi(2) + (z - (az + t * dz)).powi(2);
        let y = ay + t * (by - ay);
        if best.is_none_or(|(bd, _)| d2 < bd) {
            best = Some((d2, y));
        }
    }
    best.map(|(_, y)| y)
}

/// Closest height on the stones themselves. The gap between two stones is
/// not a segment, so a point in the joint snaps to the nearer stone.
fn height_on_segments(segments: &[[[f64; 3]; 2]], x: f64, z: f64) -> Option<f64> {
    let mut best: Option<(f64, f64)> = None;
    for seg in segments {
        let (ax, ay, az) = (seg[0][0], seg[0][1], seg[0][2]);
        let (bx, by, bz) = (seg[1][0], seg[1][1], seg[1][2]);
        let (dx, dz) = (bx - ax, bz - az);
        let len2 = dx * dx + dz * dz;
        if len2 < 1e-12 {
            continue;
        }
        let t = (((x - ax) * dx + (z - az) * dz) / len2).clamp(0.0, 1.0);
        let d2 = (x - (ax + t * dx)).powi(2) + (z - (az + t * dz)).powi(2);
        let y = ay + t * (by - ay);
        if best.is_none_or(|(bd, _)| d2 < bd) {
            best = Some((d2, y));
        }
    }
    best.map(|(_, y)| y)
}

fn seated(
    anchors: &[Vec3],
    seating: &str,
    offset: f64,
    sample: &impl Fn(f64, f64) -> Option<f64>,
) -> Vec<[f64; 3]> {
    let height = |p: Vec3| sample(p.x as f64, p.z as f64).unwrap_or(p.y as f64);
    // Each object seats posts itself. Vertices still sit on the terrain so a
    // missing sample leaves the chord as a fallback.
    if seating != "level_from_start" {
        anchors
            .iter()
            .map(|p| [p.x as f64, height(*p) + offset, p.z as f64])
            .collect()
    } else {
        let y = anchors
            .first()
            .map(|p| height(*p) + offset)
            .unwrap_or(offset);
        anchors
            .iter()
            .map(|p| [p.x as f64, y, p.z as f64])
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::param::ParamValue;
    use crate::placement::{Placement, PlacementKind};
    use crate::registry::SITE_LINE;
    use crate::ParamMap;
    use crate::Project;

    fn poly(pts: &[(f32, f32)]) -> Placement {
        let v: Vec<Vec3> = pts.iter().map(|&(x, z)| Vec3::new(x, 0.0, z)).collect();
        PlacementKind::Polyline
            .build(&v, 0.0, &apex_geometry::Frame::horizontal(0.0))
            .unwrap()
    }

    fn line(a: [f32; 2], b: [f32; 2]) -> Placement {
        Placement::line(Vec3::new(a[0], 0.0, a[1]), Vec3::new(b[0], 0.0, b[1]))
    }

    fn sloped(project: &mut Project) -> ElementId {
        let id = project
            .create_element(
                "apex.terrain",
                poly(&[(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)]),
                ParamMap::new()
                    .with("bottom_offset", ParamValue::Length(0.2))
                    .with("smooth", ParamValue::Bool(false))
                    .with("contour_interval", ParamValue::Length(5.0)),
            )
            .unwrap();
        project
            .set_slab_shape(
                id,
                &crate::SlabShape {
                    z: vec![0.0, 0.0, 2.0, 2.0],
                    points: vec![],
                    creases: vec![],
                },
            )
            .unwrap();
        id
    }

    /// Highest triangle covering plan `(x, z)`.
    fn top_at(mesh: &TriangleMesh, x: f32, z: f32) -> Option<f32> {
        let mut best: Option<f32> = None;
        for t in mesh.indices.chunks(3) {
            let at = |i: u32| {
                let k = i as usize * 3;
                [
                    mesh.positions[k],
                    mesh.positions[k + 1],
                    mesh.positions[k + 2],
                ]
            };
            let p = [at(t[0]), at(t[1]), at(t[2])];
            let area = (p[1][0] - p[0][0]) * (p[2][2] - p[0][2])
                - (p[1][2] - p[0][2]) * (p[2][0] - p[0][0]);
            if area.abs() < 1e-8 {
                continue;
            }
            let l1 =
                ((p[1][2] - p[2][2]) * (x - p[2][0]) + (p[2][0] - p[1][0]) * (z - p[2][2])) / area;
            let l2 =
                ((p[2][2] - p[0][2]) * (x - p[2][0]) + (p[0][0] - p[2][0]) * (z - p[2][2])) / area;
            let l3 = 1.0 - l1 - l2;
            if l1 >= -1e-3 && l2 >= -1e-3 && l3 >= -1e-3 {
                let y = l1 * p[0][1] + l2 * p[1][1] + l3 * p[2][1];
                best = Some(best.map_or(y, |b| b.max(y)));
            }
        }
        best
    }

    fn lowest_near(mesh: &TriangleMesh, x: f32, z: f32, r: f32) -> Option<f32> {
        let mut lo = f32::MAX;
        let mut hit = false;
        for p in mesh.positions.chunks(3) {
            let dx = p[0] - x;
            let dz = p[2] - z;
            if dx * dx + dz * dz > r * r {
                continue;
            }
            hit = true;
            lo = lo.min(p[1]);
        }
        hit.then_some(lo)
    }

    fn highest_near(mesh: &TriangleMesh, x: f32, z: f32, r: f32) -> Option<f32> {
        let mut hi = f32::MIN;
        let mut hit = false;
        for p in mesh.positions.chunks(3) {
            let dx = p[0] - x;
            let dz = p[2] - z;
            if dx * dx + dz * dz > r * r {
                continue;
            }
            hit = true;
            hi = hi.max(p[1]);
        }
        hit.then_some(hi)
    }

    fn peaked(project: &mut Project) {
        let terrain = project
            .create_element(
                "apex.terrain",
                poly(&[(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)]),
                ParamMap::new().with("smooth", ParamValue::Bool(false)),
            )
            .unwrap();
        project
            .set_slab_shape(
                terrain,
                &crate::SlabShape {
                    z: vec![0.0, 0.0, 0.0, 0.0],
                    points: vec![[5.0, 5.0, 2.0]],
                    creases: vec![],
                },
            )
            .unwrap();
    }

    #[test]
    fn level_from_start_stays_flat_and_posts_reach_the_slope() {
        let mut project = Project::new();
        sloped(&mut project);
        let id = project
            .create_element(
                SITE_LINE,
                line([5.0, 9.0], [5.0, 1.0]),
                ParamMap::new()
                    .with("seating", ParamValue::Choice("level_from_start".into()))
                    .with("content", ParamValue::Choice("repeated".into()))
                    .with("post_spacing", ParamValue::Length(20.0))
                    .with("panel_height", ParamValue::Length(1.0))
                    .with("elevation_offset", ParamValue::Length(0.0)),
            )
            .unwrap();
        let mesh = project.document().get_mesh(id).unwrap();
        // Start is the high end: terrain y = 0.2 * z = 1.8. The panel stays there.
        let mid = top_at(mesh, 5.0, 5.0).expect("panel");
        assert!(
            mid > 2.5,
            "level panel top {mid} should stay near 1.8 + 1.0, not the slope"
        );
        let post = lowest_near(mesh, 5.0, 1.0, 0.15).expect("low post");
        assert!(
            post < 0.4,
            "low-end post reaches the ground (bottom {post})"
        );
    }

    #[test]
    fn by_ends_is_a_straight_chord_over_a_peak() {
        let mut project = Project::new();
        let terrain = project
            .create_element(
                "apex.terrain",
                poly(&[(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)]),
                ParamMap::new().with("smooth", ParamValue::Bool(false)),
            )
            .unwrap();
        project
            .set_slab_shape(
                terrain,
                &crate::SlabShape {
                    z: vec![0.0, 0.0, 0.0, 0.0],
                    points: vec![[5.0, 5.0, 2.0]],
                    creases: vec![],
                },
            )
            .unwrap();
        let ground = project.topo_height_at(
            project.document().active_level_id().unwrap(),
            5.0,
            5.0,
            None,
        );
        assert!(ground.unwrap_or(0.0) > 1.5, "peak {ground:?}");
        let id = project
            .create_element(
                SITE_LINE,
                line([0.0, 5.0], [10.0, 5.0]),
                ParamMap::new()
                    .with("species", ParamValue::Text("apex.site_line.curb".into()))
                    .with("seating", ParamValue::Text("by_ends".into()))
                    .with("content", ParamValue::Text("profile".into())),
            )
            .unwrap();
        let element = project.document().get_element(id).unwrap();
        assert_eq!(
            element.params.text("species"),
            Some("apex.site_line.curb"),
            "text and choice values of the same words stay on the curb species"
        );
        let mesh = project.document().get_mesh(id).unwrap();
        // The curb species is 1 m stones. A stone beside the peak sits on
        // the ground there, not on the chord through the outer ends.
        let ground = project
            .topo_height_at(
                project.document().active_level_id().unwrap(),
                4.5,
                5.0,
                None,
            )
            .unwrap_or(0.0);
        let stone = top_at(mesh, 4.5, 5.0).expect("stone beside the peak");
        let stone = f64::from(stone);
        assert!(
            stone > ground + 0.1 && stone < ground + 0.4,
            "stone top {stone} follows the ground {ground}, not the outer chord"
        );
        assert!(
            top_at(mesh, 5.0, 5.0).is_none(),
            "a joint gap sits on the 1 m station"
        );
    }

    #[test]
    fn a_zero_segment_length_is_one_chord_over_a_peak() {
        let mut project = Project::new();
        let terrain = project
            .create_element(
                "apex.terrain",
                poly(&[(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)]),
                ParamMap::new().with("smooth", ParamValue::Bool(false)),
            )
            .unwrap();
        project
            .set_slab_shape(
                terrain,
                &crate::SlabShape {
                    z: vec![0.0, 0.0, 0.0, 0.0],
                    points: vec![[5.0, 5.0, 2.0]],
                    creases: vec![],
                },
            )
            .unwrap();
        let id = project
            .create_element(
                SITE_LINE,
                line([0.0, 5.0], [10.0, 5.0]),
                ParamMap::new()
                    .with("seating", ParamValue::Choice("by_ends".into()))
                    .with("content", ParamValue::Choice("profile".into()))
                    .with("segment_length", ParamValue::Length(0.0))
                    .with("profile_height", ParamValue::Length(0.15))
                    .with("elevation_offset", ParamValue::Length(0.0)),
            )
            .unwrap();
        let mid = top_at(project.document().get_mesh(id).unwrap(), 5.0, 5.0).expect("curb");
        assert!(
            mid < 0.5,
            "one piece follows the chord ({mid}), not the peak"
        );
    }

    #[test]
    fn level_segments_stay_flat_on_a_slope() {
        let mut project = Project::new();
        sloped(&mut project);
        let id = project
            .create_element(
                SITE_LINE,
                line([5.0, 9.0], [5.0, 1.0]),
                ParamMap::new()
                    .with("seating", ParamValue::Choice("level_from_start".into()))
                    .with("content", ParamValue::Choice("profile".into()))
                    .with("segment_length", ParamValue::Length(2.0))
                    .with("profile_height", ParamValue::Length(0.2))
                    .with("elevation_offset", ParamValue::Length(0.0)),
            )
            .unwrap();
        let mesh = project.document().get_mesh(id).unwrap();
        // Start is the high end, terrain y = 0.2 * 9 = 1.8. Stones stay there.
        let high = top_at(mesh, 5.0, 8.0).expect("high stone");
        let low = top_at(mesh, 5.0, 2.0).expect("low stone");
        assert!((high - 2.0).abs() < 0.15, "high stone top {high}");
        assert!(
            (low - high).abs() < 0.05,
            "level stones share one elevation ({high} vs {low})"
        );
        assert!(
            top_at(mesh, 5.0, 7.0).is_none(),
            "a joint gap at the 2 m station"
        );
    }

    #[test]
    fn a_post_in_a_valley_drops_and_the_panel_stays_on_the_chord() {
        let mut project = Project::new();
        let terrain = project
            .create_element(
                "apex.terrain",
                poly(&[(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)]),
                ParamMap::new().with("smooth", ParamValue::Bool(false)),
            )
            .unwrap();
        project
            .set_slab_shape(
                terrain,
                &crate::SlabShape {
                    z: vec![0.0, 0.0, 0.0, 0.0],
                    points: vec![[5.0, 5.0, -1.5]],
                    creases: vec![],
                },
            )
            .unwrap();
        let id = project
            .create_element(
                SITE_LINE,
                line([0.0, 5.0], [10.0, 5.0]),
                ParamMap::new()
                    .with("seating", ParamValue::Choice("by_ends".into()))
                    .with("content", ParamValue::Choice("repeated".into()))
                    .with("post_spacing", ParamValue::Length(5.0))
                    .with("panel_height", ParamValue::Length(0.8))
                    .with("elevation_offset", ParamValue::Length(0.0)),
            )
            .unwrap();
        let mesh = project.document().get_mesh(id).unwrap();
        let post = lowest_near(mesh, 5.0, 5.0, 0.2).expect("mid post");
        assert!(post < -1.2, "post drops into the valley, bottom {post}");
        let panel = top_at(mesh, 2.5, 5.0).expect("panel");
        assert!(
            (panel - 0.8).abs() < 0.15,
            "panel stays on the chord, top {panel}"
        );
    }

    #[test]
    fn an_unrelated_edit_does_not_rebuild_the_line() {
        let mut project = Project::new();
        sloped(&mut project);
        let id = project
            .create_element(SITE_LINE, line([2.0, 2.0], [8.0, 8.0]), ParamMap::new())
            .unwrap();
        let before = project.document().get_mesh(id).unwrap().positions.clone();
        let wall = project
            .create_element("apex.wall", line([0.0, 12.0], [4.0, 12.0]), ParamMap::new())
            .unwrap();
        project
            .update_element(
                wall,
                Some(ParamMap::new().with("height", ParamValue::Length(4.0))),
                None,
                true,
            )
            .unwrap();
        let after = &project.document().get_mesh(id).unwrap().positions;
        assert_eq!(before, *after);
    }

    #[test]
    fn editing_the_terrain_rebuilds_only_the_line_on_that_grade() {
        let mut project = Project::new();
        let terrain = sloped(&mut project);
        let id = project
            .create_element(
                SITE_LINE,
                line([5.0, 9.0], [5.0, 1.0]),
                ParamMap::new().with("panel_height", ParamValue::Length(1.0)),
            )
            .unwrap();
        let before = top_at(project.document().get_mesh(id).unwrap(), 5.0, 5.0).unwrap();
        project
            .set_slab_shape(
                terrain,
                &crate::SlabShape {
                    z: vec![0.0, 0.0, 4.0, 4.0],
                    points: vec![],
                    creases: vec![],
                },
            )
            .unwrap();
        let after = top_at(project.document().get_mesh(id).unwrap(), 5.0, 5.0).unwrap();
        assert!(
            after > before + 1.0,
            "raising the north edge lifts the level line ({before} → {after})"
        );
    }

    #[test]
    fn a_gate_punches_the_line_without_a_boolean() {
        let mut project = Project::new();
        let id = project
            .create_element(
                SITE_LINE,
                line([0.0, 0.0], [10.0, 0.0]),
                ParamMap::new().with("post_spacing", ParamValue::Length(2.0)),
            )
            .unwrap();
        assert!(
            top_at(project.document().get_mesh(id).unwrap(), 5.0, 0.0).is_some(),
            "panel before the gate"
        );
        project
            .create_element_with_parent(
                "apex.gate",
                Placement::point(Vec3::new(5.0, 0.0, 0.0)),
                ParamMap::new(),
                Some(id),
            )
            .unwrap();
        assert!(
            top_at(project.document().get_mesh(id).unwrap(), 5.0, 0.0).is_none(),
            "the gate opening is empty"
        );
    }

    #[test]
    fn a_gate_on_a_raised_line_cuts_the_panels_and_sits_on_them() {
        let mut project = Project::new();
        let terrain = sloped(&mut project);
        // High contour (z = 8 → terrain 1.6) plus an offset the path does not store.
        let id = project
            .create_element(
                SITE_LINE,
                line([1.0, 8.0], [9.0, 8.0]),
                ParamMap::new()
                    .with("seating", ParamValue::Choice("level_from_start".into()))
                    .with("content", ParamValue::Choice("repeated".into()))
                    .with("post_spacing", ParamValue::Length(20.0))
                    .with("panel_height", ParamValue::Length(1.0))
                    .with("elevation_offset", ParamValue::Length(0.4)),
            )
            .unwrap();
        let gate = project
            .create_element_with_parent(
                "apex.gate",
                Placement::point(Vec3::new(5.0, 0.0, 8.0)),
                ParamMap::new(),
                Some(id),
            )
            .unwrap();
        let host = project.document().get_mesh(id).unwrap();
        assert!(
            top_at(host, 5.0, 8.0).is_none(),
            "the opening reaches the panels above the level"
        );
        let leaf = project.document().get_mesh(gate).unwrap();
        let bottom = lowest_near(leaf, 5.0, 8.0, 1.0).expect("gate leaf");
        assert!(
            (bottom - 2.0).abs() < 0.25,
            "leaf sits on the seated line (1.6 + 0.4), bottom {bottom}"
        );

        project
            .set_slab_shape(
                terrain,
                &crate::SlabShape {
                    z: vec![0.0, 0.0, 4.0, 4.0],
                    points: vec![],
                    creases: vec![],
                },
            )
            .unwrap();
        let raised = lowest_near(project.document().get_mesh(gate).unwrap(), 5.0, 8.0, 1.0)
            .expect("gate after the grade change");
        assert!(
            raised > bottom + 1.0,
            "the leaf follows the terrain ({bottom} → {raised})"
        );
        assert!(
            top_at(project.document().get_mesh(id).unwrap(), 5.0, 8.0).is_none(),
            "the opening follows the raised panels"
        );
    }

    #[test]
    fn a_gate_on_a_sloping_line_sits_on_the_local_chord() {
        let mut project = Project::new();
        sloped(&mut project);
        let id = project
            .create_element(
                SITE_LINE,
                line([5.0, 1.0], [5.0, 9.0]),
                ParamMap::new()
                    .with("seating", ParamValue::Choice("by_ends".into()))
                    .with("content", ParamValue::Choice("repeated".into()))
                    .with("post_spacing", ParamValue::Length(20.0))
                    .with("panel_height", ParamValue::Length(1.0)),
            )
            .unwrap();
        let gate = project
            .create_element_with_parent(
                "apex.gate",
                Placement::point(Vec3::new(5.0, 0.0, 5.0)),
                ParamMap::new(),
                Some(id),
            )
            .unwrap();
        // Ends are at terrain 0.2 and 1.8; the chord at mid-span is 1.0.
        let bottom = lowest_near(project.document().get_mesh(gate).unwrap(), 5.0, 5.0, 1.0)
            .expect("gate leaf");
        assert!(
            (bottom - 1.0).abs() < 0.25,
            "leaf follows the chord, bottom {bottom}"
        );
        assert!(
            top_at(project.document().get_mesh(id).unwrap(), 5.0, 5.0).is_none(),
            "the opening is cut at the chord, not at the level"
        );
    }

    #[test]
    fn a_gate_on_segmented_curb_sits_on_the_local_stone() {
        let mut project = Project::new();
        let terrain = project
            .create_element(
                "apex.terrain",
                poly(&[(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)]),
                ParamMap::new().with("smooth", ParamValue::Bool(false)),
            )
            .unwrap();
        project
            .set_slab_shape(
                terrain,
                &crate::SlabShape {
                    z: vec![0.0, 0.0, 0.0, 0.0],
                    points: vec![[5.0, 5.0, 2.0]],
                    creases: vec![],
                },
            )
            .unwrap();
        let id = project
            .create_element(
                SITE_LINE,
                line([0.0, 5.0], [10.0, 5.0]),
                ParamMap::new().with("species", ParamValue::Text("apex.site_line.curb".into())),
            )
            .unwrap();
        let gate = project
            .create_element_with_parent(
                "apex.gate",
                Placement::point(Vec3::new(4.5, 0.0, 5.0)),
                ParamMap::new(),
                Some(id),
            )
            .unwrap();
        let ground = project
            .topo_height_at(
                project.document().active_level_id().unwrap(),
                4.5,
                5.0,
                None,
            )
            .unwrap_or(0.0);
        let bottom = lowest_near(project.document().get_mesh(gate).unwrap(), 4.5, 5.0, 1.0)
            .expect("gate leaf");
        assert!(
            (f64::from(bottom) - ground).abs() < 0.35,
            "leaf sits on the stone at the peak ({bottom}), ground {ground}, not on the outer chord"
        );
    }

    #[test]
    fn each_object_seats_every_post_and_the_panel_between_them() {
        let mut project = Project::new();
        peaked(&mut project);
        let ground = project
            .topo_height_at(
                project.document().active_level_id().unwrap(),
                5.0,
                5.0,
                None,
            )
            .unwrap_or(0.0);
        assert!(ground > 1.5, "peak {ground}");
        let id = project
            .create_element(
                SITE_LINE,
                line([0.0, 5.0], [10.0, 5.0]),
                ParamMap::new()
                    .with("seating", ParamValue::Choice("each_object".into()))
                    .with("content", ParamValue::Choice("repeated".into()))
                    .with("post_spacing", ParamValue::Length(5.0))
                    .with("post_height", ParamValue::Length(1.0))
                    .with("panel_height", ParamValue::Length(0.8))
                    .with("elevation_offset", ParamValue::Length(0.0)),
            )
            .unwrap();
        let mesh = project.document().get_mesh(id).unwrap();
        let top = highest_near(mesh, 5.0, 5.0, 0.15).expect("mid post");
        assert!(
            (f64::from(top) - (ground + 1.0)).abs() < 0.15,
            "post top {top} stands on the peak {ground}, not on the chord"
        );
        let panel = top_at(mesh, 2.5, 5.0).expect("panel");
        assert!(
            (panel - 1.8).abs() < 0.25,
            "panel top {panel} follows the line between the end and the peak"
        );
    }

    #[test]
    fn a_gate_on_each_object_sits_on_the_bay() {
        let mut project = Project::new();
        peaked(&mut project);
        let id = project
            .create_element(
                SITE_LINE,
                line([0.0, 5.0], [10.0, 5.0]),
                ParamMap::new()
                    .with("seating", ParamValue::Choice("each_object".into()))
                    .with("content", ParamValue::Choice("repeated".into()))
                    .with("post_spacing", ParamValue::Length(10.0))
                    .with("panel_height", ParamValue::Length(0.8))
                    .with("elevation_offset", ParamValue::Length(0.0)),
            )
            .unwrap();
        let gate = project
            .create_element_with_parent(
                "apex.gate",
                Placement::point(Vec3::new(5.0, 0.0, 5.0)),
                ParamMap::new(),
                Some(id),
            )
            .unwrap();
        let ground = project
            .topo_height_at(
                project.document().active_level_id().unwrap(),
                5.0,
                5.0,
                None,
            )
            .unwrap_or(0.0);
        assert!(ground > 1.5, "peak under the gate {ground}");
        let bottom = lowest_near(project.document().get_mesh(gate).unwrap(), 5.0, 5.0, 1.0)
            .expect("gate leaf");
        assert!(
            f64::from(bottom) < 0.35,
            "leaf sits on the bay between the end posts ({bottom}), not on the peak {ground}"
        );
        assert!(
            top_at(project.document().get_mesh(id).unwrap(), 5.0, 5.0).is_none(),
            "the opening is cut through the panel on that bay"
        );
    }

    #[test]
    fn rebuilding_one_line_stays_within_the_edit_budget() {
        let mut project = Project::new();
        sloped(&mut project);
        let id = project
            .create_element(SITE_LINE, line([1.0, 1.0], [9.0, 8.0]), ParamMap::new())
            .unwrap();
        project
            .update_element(
                id,
                Some(ParamMap::new().with("post_height", ParamValue::Length(1.7))),
                None,
                true,
            )
            .unwrap();
        let t0 = std::time::Instant::now();
        project
            .update_element(
                id,
                Some(ParamMap::new().with("post_height", ParamValue::Length(1.8))),
                None,
                true,
            )
            .unwrap();
        let ms = t0.elapsed().as_secs_f64() * 1000.0;
        assert!(
            ms < 50.0,
            "one site-line edit took {ms:.2} ms (debug budget 50 ms)"
        );
    }

    /// Drop one key from a saved species, the way a file written before that
    /// param existed does.
    fn drop_species_param(snap: &mut serde_json::Value, id: &str, param: &str) {
        for species in snap["species"].as_array_mut().unwrap() {
            if species["id"] == id {
                species["values"].as_object_mut().unwrap().remove(param);
            }
        }
    }

    #[test]
    fn an_old_curb_species_without_segment_length_loads_as_one_metre_stones() {
        let mut project = Project::new();
        let id = project
            .create_element(
                SITE_LINE,
                line([0.0, 0.0], [4.0, 0.0]),
                ParamMap::new().with("species", ParamValue::Text("apex.site_line.curb".into())),
            )
            .unwrap();
        let mut snap = serde_json::to_value(project.export_snapshot()).unwrap();
        drop_species_param(&mut snap, "apex.site_line.curb", "segment_length");
        drop_species_param(&mut snap, "apex.site_line.fence-terrain", "seating");
        for element in snap["elements"].as_array_mut().unwrap() {
            if let Some(params) = element["params"].as_object_mut() {
                if params.get("species").and_then(|v| v.as_str()) == Some("apex.site_line.curb") {
                    params.remove("segment_length");
                }
            }
        }
        // A user species is not a shipped one: a missing key stays on the genus default.
        snap["species"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({
                "id": "user.apex.site_line.old",
                "genus": "apex.site_line",
                "name": "Old copy",
                "values": { "content": "profile", "seating": "by_ends" }
            }));

        let mut loaded = Project::new();
        loaded
            .import_snapshot(serde_json::from_value(snap).unwrap())
            .unwrap();
        let curb = loaded.registry().species("apex.site_line.curb").unwrap();
        assert!(
            (curb.values.number("segment_length").unwrap() - 1.0).abs() < 1e-9,
            "a missing curb segment length takes the shipped 1 m"
        );
        let element = loaded.document().get_element(id).unwrap();
        assert!((element.params.number("segment_length").unwrap() - 1.0).abs() < 1e-9);
        let mesh = loaded.document().get_mesh(id).unwrap();
        assert!(
            top_at(mesh, 0.4, 0.0).is_some(),
            "the restored curb has a stone"
        );
        assert!(
            top_at(mesh, 1.0, 0.0).is_none(),
            "1 m stones leave a joint at the station"
        );
        assert_eq!(
            loaded
                .registry()
                .species("apex.site_line.fence-terrain")
                .unwrap()
                .values
                .text("seating"),
            Some("each_object")
        );
        assert_eq!(
            loaded
                .registry()
                .species("user.apex.site_line.old")
                .unwrap()
                .values
                .number("segment_length"),
            Some(0.0)
        );
    }

    #[test]
    fn a_stored_segment_length_of_zero_is_not_replaced_on_load() {
        let mut project = Project::new();
        project
            .update_species(
                "apex.site_line.curb",
                None,
                &ParamMap::new().with("segment_length", ParamValue::Length(0.0)),
            )
            .unwrap();
        let id = project
            .create_element(
                SITE_LINE,
                line([0.0, 0.0], [4.0, 0.0]),
                ParamMap::new().with("species", ParamValue::Text("apex.site_line.curb".into())),
            )
            .unwrap();
        let snap = project.export_snapshot();
        let mut loaded = Project::new();
        loaded.import_snapshot(snap).unwrap();
        assert_eq!(
            loaded
                .registry()
                .species("apex.site_line.curb")
                .unwrap()
                .values
                .number("segment_length"),
            Some(0.0)
        );
        assert!(
            top_at(loaded.document().get_mesh(id).unwrap(), 1.0, 0.0).is_some(),
            "an explicit 0 stays one continuous piece"
        );
    }
}
