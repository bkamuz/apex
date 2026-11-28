//! Terrain-draped site surfaces.
//!
//! A soft yard surface (lawn, path, gravel) keeps a 2D plan outline and
//! builds its solid by clipping that outline against the terrain
//! triangulation, then lifting a thin crust so it does not z-fight the
//! ground. Hard surfaces stay flat unless the placement mode says otherwise.
//!
//! The terrain top and the finished crust are cached by the inputs that
//! affect them. An edit that does not change the terrain or the surface
//! does not re-drape; a terrain edit rebuilds only the draped surfaces on
//! that level.

use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::Arc;

use apex_geometry::{drape_polygon, DrapedPatch, SurfaceMesh, TerrainFacet, TriangleMesh};

use crate::element::{Element, ElementId};
use crate::param::ParamValue;
use crate::placement::PlacementKind;
use crate::registry::default_site_placement_mode;

use super::Project;

/// Metres the crust sits above the terrain so the two surfaces do not z-fight.
pub(crate) const DRAPE_CLEARANCE: f64 = 0.02;
/// Thinnest crust. A zero thickness would be coplanar with the clearance plane.
pub(crate) const DRAPE_MIN_THICKNESS: f64 = 0.02;

/// Extra lift for a path or gravel area so it rests on a lawn crust instead
/// of occupying the same sheet of triangles.
const PATH_ON_LAWN: f64 = 0.06;

#[derive(Default)]
pub(crate) struct DrapeCache {
    /// Terrain id → (input fingerprint, drawn top).
    tops: HashMap<ElementId, (u64, Arc<SurfaceMesh>)>,
    /// Combined terrain fingerprint → facets used for clipping.
    covers: HashMap<u64, Arc<Vec<TerrainFacet>>>,
    /// Surface id → (shell fingerprint, mesh).
    shells: HashMap<ElementId, (u64, TriangleMesh)>,
    /// Site line id → uncut mesh plus the seated centreline a gate reads.
    /// Rebuilt only when the cover, the path, or the params change.
    pub(super) lines: HashMap<ElementId, CachedSiteLine>,
}

/// Cached site line. `polyline` is the seated centreline (one point per post
/// when each object sits on the terrain). `stones` replaces it for a
/// segmented profile.
#[derive(Clone)]
pub(super) struct CachedSiteLine {
    pub key: u64,
    pub mesh: TriangleMesh,
    pub polyline: Vec<[f64; 3]>,
    pub stones: Option<Vec<[[f64; 3]; 2]>>,
}

impl Project {
    pub(super) fn drape_cache(&self) -> std::sync::MutexGuard<'_, DrapeCache> {
        self.drape_cache.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// `draped` or `flat`. A missing value follows the surface kind: lawn,
    /// path and gravel drape; paving and driveway stay flat.
    pub(crate) fn site_placement_mode<'a>(&self, element: &'a Element) -> &'a str {
        match element.params.text("placement_mode") {
            Some("flat") => "flat",
            Some("draped") => "draped",
            _ => default_site_placement_mode(element.params.text("surface_kind").unwrap_or("lawn")),
        }
    }

    /// Fill `placement_mode` from the surface kind when a snapshot or a new
    /// element has not chosen one yet.
    pub(crate) fn migrate_site_placement(&self, element: &mut Element) {
        if !self.declares_placement_mode(&element.component_id) {
            return;
        }
        if element.params.text("placement_mode").is_some() {
            return;
        }
        let kind = element.params.text("surface_kind").unwrap_or("lawn");
        element.params.set(
            "placement_mode",
            ParamValue::Choice(default_site_placement_mode(kind).to_string()),
        );
    }

    fn declares_placement_mode(&self, component_id: &str) -> bool {
        self.registry
            .get(component_id)
            .is_some_and(|d| d.params.iter().any(|p| p.id == "placement_mode"))
    }

    fn site_wants_drape(&self, element: &Element) -> bool {
        self.declares_placement_mode(&element.component_id)
            && self.site_placement_mode(element) == "draped"
            && self
                .registry
                .get(&element.component_id)
                .is_some_and(|d| d.placement == PlacementKind::Polyline)
    }

    /// Draped surfaces on the same level as a terrain element. A terrain edit
    /// rebuilds these and nothing else.
    pub(crate) fn drape_dependents(&self, element: &Element) -> Vec<ElementId> {
        if !self.is_topo_element(element) {
            return Vec::new();
        }
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
                    .is_some_and(|e| self.site_wants_drape(e))
            })
            .collect()
    }

    fn plan_ring(element: &Element) -> Option<Vec<[f64; 2]>> {
        let mut anchors = element.placement.anchors();
        if anchors.len() > 3 {
            let (f, l) = (anchors[0], anchors[anchors.len() - 1]);
            if (f - l).length() < 1e-5 {
                anchors.pop();
            }
        }
        if anchors.len() < 3 {
            return None;
        }
        Some(anchors.iter().map(|p| [p.x as f64, p.z as f64]).collect())
    }

    fn clearance_for(kind: &str) -> f64 {
        match kind {
            "path" | "gravel" => DRAPE_CLEARANCE + PATH_ON_LAWN,
            _ => DRAPE_CLEARANCE,
        }
    }

    fn terrain_input_key(&self, element: &Element) -> u64 {
        let mut h = std::collections::hash_map::DefaultHasher::new();
        for p in element.placement.anchors() {
            p.x.to_bits().hash(&mut h);
            p.y.to_bits().hash(&mut h);
            p.z.to_bits().hash(&mut h);
        }
        h.write(element.params.text("shape").unwrap_or("").as_bytes());
        let smooth = self
            .registry
            .eval_params(&element.component_id, &element.params)
            .ok()
            .and_then(|p| p.bool("smooth"))
            .unwrap_or(true);
        u8::from(smooth).hash(&mut h);
        h.finish()
    }

    fn cached_topo(&self, element: &Element) -> Option<Arc<SurfaceMesh>> {
        let key = self.terrain_input_key(element);
        if let Some((k, mesh)) = self.drape_cache().tops.get(&element.id) {
            if *k == key {
                return Some(Arc::clone(mesh));
            }
        }
        let shape = self.slab_shape(element)?;
        let (surface, _) = self.surface_for(element, &shape)?;
        let top = self.topo_top(element, &surface)?;
        let mesh = Arc::new(top);
        self.drape_cache()
            .tops
            .insert(element.id, (key, Arc::clone(&mesh)));
        Some(mesh)
    }

    /// Facets of every terrain on the element's level, plus a fingerprint of
    /// those terrains. `None` when the level has no terrain.
    pub(super) fn terrain_cover(&self, element: &Element) -> Option<(u64, Arc<Vec<TerrainFacet>>)> {
        let level = self
            .document
            .effective_level_id(element.id)
            .unwrap_or(element.level_id);
        let mut ids: Vec<ElementId> = self
            .document
            .elements_on_level(level)
            .into_iter()
            .filter(|id| {
                self.document
                    .get_element(*id)
                    .is_some_and(|e| self.is_topo_element(e))
            })
            .collect();
        if ids.is_empty() {
            return None;
        }
        ids.sort();
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        let mut tops: Vec<Arc<SurfaceMesh>> = Vec::with_capacity(ids.len());
        for id in &ids {
            let terrain = self.document.get_element(*id)?;
            self.terrain_input_key(terrain).hash(&mut hasher);
            tops.push(self.cached_topo(terrain)?);
        }
        let cover_key = hasher.finish();
        if let Some(hit) = self.drape_cache().covers.get(&cover_key) {
            return Some((cover_key, Arc::clone(hit)));
        }
        let mut facets = Vec::new();
        for top in &tops {
            for t in &top.triangles {
                facets.push(TerrainFacet {
                    p: t.map(|i| top.points[i]),
                });
            }
        }
        let facets = Arc::new(facets);
        let mut cache = self.drape_cache();
        if cache.covers.len() > 4 {
            cache.covers.clear();
        }
        cache.covers.insert(cover_key, Arc::clone(&facets));
        Some((cover_key, facets))
    }

    fn shell_key(ring: &[[f64; 2]], thickness: f64, clearance: f64, cover: u64) -> u64 {
        let mut h = std::collections::hash_map::DefaultHasher::new();
        cover.hash(&mut h);
        thickness.to_bits().hash(&mut h);
        clearance.to_bits().hash(&mut h);
        for p in ring {
            p[0].to_bits().hash(&mut h);
            p[1].to_bits().hash(&mut h);
        }
        h.finish()
    }

    fn shell_inputs(&self, element: &Element) -> Option<(Vec<[f64; 2]>, f64, f64, u64)> {
        if !self.site_wants_drape(element) {
            return None;
        }
        let ring = Self::plan_ring(element)?;
        let params = self
            .registry
            .eval_params(&element.component_id, &element.params)
            .ok()?;
        let thickness = params
            .number("thickness")
            .unwrap_or(0.05)
            .max(DRAPE_MIN_THICKNESS);
        let clearance = Self::clearance_for(params.text("surface_kind").unwrap_or("lawn"));
        let (cover, _) = self.terrain_cover(element)?;
        Some((ring, thickness, clearance, cover))
    }

    /// The draped crust, or `None` when the surface is flat or misses every
    /// terrain (the caller keeps the plain extrusion / shaped slab).
    pub(crate) fn draped_site_mesh(&self, element: &Element) -> Option<TriangleMesh> {
        let (ring, thickness, clearance, cover) = self.shell_inputs(element)?;
        let key = Self::shell_key(&ring, thickness, clearance, cover);
        if let Some((k, mesh)) = self.drape_cache().shells.get(&element.id) {
            if *k == key {
                return Some(mesh.clone());
            }
        }
        let facets = self.terrain_cover(element)?.1;
        if facets.is_empty() {
            return None;
        }
        let patch: DrapedPatch = drape_polygon(&ring, &facets)?;
        let mesh = patch.crust(clearance, thickness);
        self.drape_cache()
            .shells
            .insert(element.id, (key, mesh.clone()));
        Some(mesh)
    }

    /// True when the mesh just built is a draped crust (so the exact kernel
    /// must not restitch every terrain facet into its own face).
    pub(crate) fn took_draped_mesh(&self, element: &Element) -> bool {
        let Some((ring, thickness, clearance, cover)) = self.shell_inputs(element) else {
            return false;
        };
        let key = Self::shell_key(&ring, thickness, clearance, cover);
        self.drape_cache()
            .shells
            .get(&element.id)
            .is_some_and(|(k, _)| *k == key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::param::ParamValue;
    use crate::placement::PlacementKind;
    use crate::ParamMap;
    use crate::Project;
    use glam::Vec3;

    fn poly(pts: &[(f32, f32)]) -> crate::placement::Placement {
        let v: Vec<Vec3> = pts.iter().map(|&(x, z)| Vec3::new(x, 0.0, z)).collect();
        PlacementKind::Polyline
            .build(&v, 0.0, &apex_geometry::Frame::horizontal(0.0))
            .unwrap()
    }

    /// Highest top-face height at plan `(x, z)`.
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
                    // North edge (z = 10) up 2 m. y = 0.2 * z.
                    z: vec![0.0, 0.0, 2.0, 2.0],
                    points: vec![],
                    creases: vec![],
                },
            )
            .unwrap();
        id
    }

    #[test]
    fn lawn_drapes_on_a_slope_and_paving_stays_flat() {
        let mut project = Project::new();
        sloped(&mut project);
        let lawn = project
            .create_element(
                "apex.site_surface",
                poly(&[(2.0, 2.0), (8.0, 2.0), (8.0, 8.0), (2.0, 8.0)]),
                ParamMap::new()
                    .with("thickness", ParamValue::Length(0.05))
                    .with("surface_kind", ParamValue::Text("lawn".into())),
            )
            .unwrap();
        let lawn_el = project.document().get_element(lawn).unwrap();
        assert_eq!(lawn_el.params.text("placement_mode"), Some("draped"));
        let mesh = project.document().get_mesh(lawn).unwrap();
        let centre = top_at(mesh, 5.0, 5.0).expect("centre");
        let south = top_at(mesh, 5.0, 2.0).expect("south");
        // Terrain y = 0.2*z, crust = clearance + thickness.
        let expect = 0.2 * 5.0 + DRAPE_CLEARANCE + 0.05;
        assert!(
            (centre as f64 - expect).abs() < 2e-2,
            "centre {centre} vs {expect}"
        );
        assert!(
            centre > south + 0.4,
            "draped lawn rises with the slope ({south} → {centre})"
        );

        let drive = project
            .create_element(
                "apex.site_surface",
                poly(&[(2.0, 2.0), (4.0, 2.0), (4.0, 4.0), (2.0, 4.0)]),
                ParamMap::new()
                    .with("thickness", ParamValue::Length(0.1))
                    .with("surface_kind", ParamValue::Text("driveway".into())),
            )
            .unwrap();
        let drive_el = project.document().get_element(drive).unwrap();
        assert_eq!(drive_el.params.text("placement_mode"), Some("flat"));
        let dmesh = project.document().get_mesh(drive).unwrap();
        let mut ys = Vec::new();
        for p in dmesh.positions.chunks(3) {
            ys.push(p[1]);
        }
        ys.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let span = ys.last().unwrap() - ys.first().unwrap();
        assert!(
            (span - 0.1).abs() < 1e-2,
            "flat driveway thickness span {span}"
        );
        let d_centre = top_at(dmesh, 3.0, 3.0).unwrap();
        assert!(
            (d_centre as f64 - expect).abs() > 0.2,
            "flat paving does not follow the slope centre"
        );
    }

    #[test]
    fn an_interior_terrain_point_redrapes_the_lawn() {
        let mut project = Project::new();
        let terrain = project
            .create_element(
                "apex.terrain",
                poly(&[(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)]),
                ParamMap::new().with("smooth", ParamValue::Bool(false)),
            )
            .unwrap();
        let lawn = project
            .create_element(
                "apex.site_surface",
                poly(&[(2.0, 2.0), (8.0, 2.0), (8.0, 8.0), (2.0, 8.0)]),
                ParamMap::new().with("surface_kind", ParamValue::Text("path".into())),
            )
            .unwrap();
        let before = top_at(project.document().get_mesh(lawn).unwrap(), 5.0, 5.0).unwrap();
        project
            .set_slab_shape(
                terrain,
                &crate::SlabShape {
                    z: vec![0.0, 0.0, 0.0, 0.0],
                    points: vec![[5.0, 5.0, 1.5]],
                    creases: vec![],
                },
            )
            .unwrap();
        let after = top_at(project.document().get_mesh(lawn).unwrap(), 5.0, 5.0).unwrap();
        // Path default thickness is 0.05; the crust sits on a lawn (extra lift).
        let expect = 1.5 + DRAPE_CLEARANCE + PATH_ON_LAWN + 0.05;
        assert!(
            (after as f64 - expect).abs() < 3e-2,
            "peak {after} vs {expect} (was {before})"
        );
        assert!(
            after > before + 1.0,
            "editing the terrain re-drapes the path ({before} → {after})"
        );
        // Outline only: no edge crosses the interior of the square.
        let mesh = project.document().get_mesh(lawn).unwrap();
        for e in mesh.edges.chunks(6) {
            let vertical = (e[0] - e[3]).abs() < 1e-3 && (e[2] - e[5]).abs() < 1e-3;
            if vertical {
                continue;
            }
            let (mx, mz) = ((e[0] + e[3]) * 0.5, (e[2] + e[5]) * 0.5);
            let on = (mx - 2.0).abs() < 0.05
                || (mx - 8.0).abs() < 0.05
                || (mz - 2.0).abs() < 0.05
                || (mz - 8.0).abs() < 0.05;
            assert!(on, "plan edge left the outline at {mx},{mz}");
        }
    }

    #[test]
    fn an_unrelated_edit_does_not_rebuild_the_draped_mesh() {
        let mut project = Project::new();
        sloped(&mut project);
        let lawn = project
            .create_element(
                "apex.site_surface",
                poly(&[(2.0, 2.0), (8.0, 2.0), (8.0, 8.0), (2.0, 8.0)]),
                ParamMap::new().with("surface_kind", ParamValue::Text("lawn".into())),
            )
            .unwrap();
        let before = project.document().get_mesh(lawn).unwrap().positions.clone();
        let wall = project
            .create_element(
                "apex.wall",
                crate::placement::Placement::line(
                    Vec3::new(0.0, 0.0, 12.0),
                    Vec3::new(4.0, 0.0, 12.0),
                ),
                ParamMap::new(),
            )
            .unwrap();
        project
            .update_element(
                wall,
                Some(ParamMap::new().with("height", ParamValue::Length(4.0))),
                None,
                true,
            )
            .unwrap();
        let after = &project.document().get_mesh(lawn).unwrap().positions;
        assert_eq!(before, *after, "a wall edit must not re-drape the lawn");
    }

    #[test]
    fn a_lawn_with_no_terrain_stays_a_flat_extrusion() {
        let mut project = Project::new();
        let lawn = project
            .create_element(
                "apex.site_surface",
                poly(&[(0.0, 0.0), (4.0, 0.0), (4.0, 3.0), (0.0, 3.0)]),
                ParamMap::new().with("thickness", ParamValue::Length(0.05)),
            )
            .unwrap();
        let mesh = project.document().get_mesh(lawn).unwrap();
        let (lo, hi) = mesh.aabb().unwrap();
        assert!((hi[1] - lo[1] - 0.05).abs() < 1e-3);
        assert!(hi[1].abs() < 1e-2 || (hi[1] - 0.05).abs() < 1e-2);
    }
}
