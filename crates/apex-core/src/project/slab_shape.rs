//! Slab shape editing (Revit's "Modify Sub Elements").
//!
//! A slab (or flat roof) stores its shape in the `shape` text param as JSON:
//!
//! ```json
//! { "z": [0, 0, 0.3, 0.3], "points": [[x, z, dz]], "creases": [[a, b]] }
//! ```
//!
//! * `z[i]` — vertical offset of boundary vertex `i` (missing = 0);
//! * `points` — extra interior points at plan (x, z) with their own offset;
//! * `creases` — split lines between two points: boundary indices first,
//!   then interior points (`boundary.len() + k`).
//!
//! The top surface goes through every point, folding along creases
//! ([`ShapedSurface`]). Thickness is constant and **vertical**: the underside
//! is the top surface lowered by the thickness, so a ramp keeps the same
//! vertical depth everywhere and joins flat neighbours flush. The shaped body
//! is one closed solid; openings and stair wells are mesh-boolean
//! subtractions. Edits go through the param, so they are ordinary undoable
//! element updates.

use apex_geometry::{BooleanOp, LayeredSolid, ShapedSurface, TriangleMesh, Underside};
use serde::{Deserialize, Serialize};

use crate::element::{Element, ElementId};
use crate::param::{ParamMap, ParamValue};
use crate::registry::{RegistryError, SLAB_SHAPE};

use super::Project;

const SHAPEABLE: [&str; 2] = ["apex.slab", "apex.roof"];

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SlabShape {
    #[serde(default)]
    pub z: Vec<f64>,
    #[serde(default)]
    pub points: Vec<[f64; 3]>,
    #[serde(default)]
    pub creases: Vec<[usize; 2]>,
}

impl SlabShape {
    pub fn parse(text: &str) -> Self {
        if text.trim().is_empty() {
            return Self::default();
        }
        serde_json::from_str(text).unwrap_or_default()
    }

    pub fn to_text(&self) -> String {
        if self.is_flat() {
            return String::new();
        }
        serde_json::to_string(self).unwrap_or_default()
    }

    /// No offsets anywhere: the plain extruded slab.
    pub fn is_flat(&self) -> bool {
        self.z.iter().all(|v| v.abs() < 1e-9)
            && self.points.iter().all(|p| p[2].abs() < 1e-9)
            && self.creases.is_empty()
    }
}

/// One editable point for the UI: top-surface position and its offset.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ShapeHandle {
    /// "vertex" (boundary) or "point" (interior).
    pub kind: String,
    /// Index within its kind.
    pub index: usize,
    /// Index in the crease numbering (boundary first, then points).
    pub crease_index: usize,
    pub position: [f32; 3],
    pub offset: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ShapeInfo {
    pub shape: SlabShape,
    pub handles: Vec<ShapeHandle>,
    /// Crease segments on the top surface (usable ones only).
    pub creases: Vec<[[f32; 3]; 2]>,
    pub thickness: f64,
}

impl Project {
    pub(crate) fn is_shapeable(&self, element: &Element) -> bool {
        SHAPEABLE.contains(&element.component_id.as_str())
    }

    pub fn slab_shape(&self, element: &Element) -> Option<SlabShape> {
        if !self.is_shapeable(element) {
            return None;
        }
        let params = self
            .registry
            .eval_params(&element.component_id, &element.params)
            .ok()?;
        Some(SlabShape::parse(params.text(SLAB_SHAPE).unwrap_or("")))
    }

    /// Flat top height and thickness of the slab as extruded.
    fn flat_top(&self, element: &Element) -> Option<(f64, f64)> {
        let level_id = self
            .document
            .effective_level_id(element.id)
            .unwrap_or(element.level_id);
        let mesh = self
            .registry
            .build_element_mesh(
                element,
                self.work_plane(level_id),
                self.document.references(),
            )
            .ok()?;
        let (lo, hi) = mesh.aabb()?;
        Some((hi[1] as f64, (hi[1] - lo[1]) as f64))
    }

    /// The shaped top surface and thickness, `None` for flat slabs.
    pub(crate) fn shaped_surface(&self, element: &Element) -> Option<(ShapedSurface, f64)> {
        let shape = self.slab_shape(element)?;
        if shape.is_flat() {
            return None;
        }
        self.surface_for(element, &shape)
    }

    pub(crate) fn surface_for(
        &self,
        element: &Element,
        shape: &SlabShape,
    ) -> Option<(ShapedSurface, f64)> {
        let (top, thickness) = self.flat_top(element)?;
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
        let boundary = anchors
            .iter()
            .enumerate()
            .map(|(i, p)| {
                let dz = shape.z.get(i).copied().unwrap_or(0.0);
                [p.x as f64, top + dz, p.z as f64]
            })
            .collect();
        let interior = shape
            .points
            .iter()
            .map(|p| [p[0], top + p[2], p[1]])
            .collect();
        Some((
            ShapedSurface {
                boundary,
                interior,
                creases: shape.creases.clone(),
            },
            thickness,
        ))
    }

    /// Closed shaped body minus openings and stair wells.
    pub(crate) fn shaped_slab_mesh(&self, element: &Element) -> Option<TriangleMesh> {
        let (surface, thickness) = self.shaped_surface(element)?;
        let mut mesh = surface.solid(Underside::Drop(thickness)).ok()?;
        let (lo, hi) = mesh.aabb()?;
        let voids = self.void_solids(element);
        if voids.is_empty() {
            return Some(mesh);
        }
        // Clamp voids (stair wells are effectively infinite) to the slab.
        let (y0, y1) = (lo[1] as f64 - 0.5, hi[1] as f64 + 0.5);
        let bound = [
            [lo[0] as f64 - 1.0, lo[2] as f64 - 1.0],
            [hi[0] as f64 + 1.0, lo[2] as f64 - 1.0],
            [hi[0] as f64 + 1.0, hi[2] as f64 + 1.0],
            [lo[0] as f64 - 1.0, hi[2] as f64 + 1.0],
        ];
        let clamp = LayeredSolid::polygon_prism(&bound, y0, y1);
        let mut all = LayeredSolid::empty();
        for v in &voids {
            all = all.union(&v.intersect(&clamp));
        }
        if all.is_empty() {
            return Some(mesh);
        }
        if let Ok(cut) = crate::kroute::kbool(&mesh, &all.to_mesh(), BooleanOp::Subtract) {
            mesh = cut;
        }
        Some(mesh)
    }

    /// Editable points of a slab for the shape-edit UI.
    pub fn slab_shape_info(&self, id: ElementId) -> Option<ShapeInfo> {
        let element = self.document.get_element(id)?;
        let shape = self.slab_shape(element)?;
        let (surface, thickness) = self.surface_for(element, &shape)?;
        let nb = surface.boundary.len();
        let f = |p: [f64; 3]| [p[0] as f32, p[1] as f32, p[2] as f32];
        let mut handles: Vec<ShapeHandle> = surface
            .boundary
            .iter()
            .enumerate()
            .map(|(i, p)| ShapeHandle {
                kind: "vertex".into(),
                index: i,
                crease_index: i,
                position: f(*p),
                offset: shape.z.get(i).copied().unwrap_or(0.0),
            })
            .collect();
        for (k, p) in surface.interior.iter().enumerate() {
            handles.push(ShapeHandle {
                kind: "point".into(),
                index: k,
                crease_index: nb + k,
                position: f(*p),
                offset: shape.points[k][2],
            });
        }
        let all: Vec<[f64; 3]> = surface
            .boundary
            .iter()
            .chain(surface.interior.iter())
            .copied()
            .collect();
        let creases = surface
            .usable_creases()
            .into_iter()
            .map(|[a, b]| [f(all[a]), f(all[b])])
            .collect();
        Some(ShapeInfo {
            shape,
            handles,
            creases,
            thickness,
        })
    }

    /// Replace a slab's shape (one undo step).
    pub fn set_slab_shape(
        &mut self,
        id: ElementId,
        shape: &SlabShape,
    ) -> Result<(), RegistryError> {
        let element = self
            .document
            .get_element(id)
            .ok_or_else(|| RegistryError::Unknown(id.to_string()))?;
        if !self.is_shapeable(element) {
            return Err(RegistryError::Document(format!(
                "{} has no editable shape",
                element.component_id
            )));
        }
        let mut shape = shape.clone();
        let nb = element.placement.anchors().len();
        shape.z.truncate(nb);
        let np = nb + shape.points.len();
        shape.creases.retain(|[a, b]| a != b && *a < np && *b < np);
        self.update_element(
            id,
            Some(ParamMap::new().with(SLAB_SHAPE, ParamValue::Text(shape.to_text()))),
            None,
            true,
        )
    }

    /// Height of the slab's top surface at plan (x, z).
    pub fn slab_top_at(&self, id: ElementId, x: f64, z: f64) -> Option<f64> {
        let element = self.document.get_element(id)?;
        let shape = self.slab_shape(element)?;
        let (surface, _) = self.surface_for(element, &shape)?;
        surface.height_at(x, z)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::placement::{Placement, PlacementKind};
    use apex_geometry::{is_watertight, mesh_volume};
    use glam::Vec3;

    fn poly(pts: &[(f32, f32)]) -> Placement {
        let v: Vec<Vec3> = pts.iter().map(|&(x, z)| Vec3::new(x, 0.0, z)).collect();
        PlacementKind::Polyline
            .build(&v, 0.0, &apex_geometry::Frame::horizontal(0.0))
            .unwrap()
    }

    fn slab(p: &mut Project) -> ElementId {
        p.create_element(
            "apex.slab",
            poly(&[(0.0, 0.0), (6.0, 0.0), (6.0, 4.0), (0.0, 4.0)]),
            ParamMap::new().with("thickness", ParamValue::Length(0.2)),
        )
        .unwrap()
    }

    fn mesh(p: &Project, id: ElementId) -> TriangleMesh {
        p.document().get_mesh(id).unwrap().clone()
    }

    #[test]
    fn ramp_is_watertight_with_exact_heights_and_undo() {
        let mut p = Project::new();
        let id = slab(&mut p);
        let flat = mesh_volume(&mesh(&p, id));
        assert!((flat - 6.0 * 4.0 * 0.2).abs() < 1e-3);
        let shape = SlabShape {
            z: vec![0.0, 0.6, 0.6, 0.0],
            ..Default::default()
        };
        p.set_slab_shape(id, &shape).unwrap();
        let m = mesh(&p, id);
        assert!(is_watertight(&m));
        // Vertical thickness is constant, so the volume is unchanged.
        assert!((mesh_volume(&m) - flat).abs() < 1e-3);
        let top = p.slab_top_at(id, 3.0, 2.0).unwrap();
        assert!((top - (0.2 + 0.3)).abs() < 1e-4, "{top}");
        let (_, hi) = m.aabb().unwrap();
        assert!((hi[1] - 0.8).abs() < 1e-4);
        p.undo().unwrap();
        assert!((mesh_volume(&mesh(&p, id)) - flat).abs() < 1e-3);
        assert!(p
            .slab_shape(p.document().get_element(id).unwrap())
            .unwrap()
            .is_flat());
        p.redo().unwrap();
        assert!((mesh(&p, id).aabb().unwrap().1[1] - 0.8).abs() < 1e-4);
    }

    #[test]
    fn interior_point_with_creases_lifts_the_middle() {
        let mut p = Project::new();
        let id = slab(&mut p);
        let shape = SlabShape {
            z: vec![],
            points: vec![[3.0, 2.0, 0.5]],
            creases: vec![[0, 4], [1, 4], [2, 4], [3, 4]],
        };
        p.set_slab_shape(id, &shape).unwrap();
        assert!(is_watertight(&mesh(&p, id)));
        assert!((p.slab_top_at(id, 3.0, 2.0).unwrap() - 0.7).abs() < 1e-4);
        assert!((p.slab_top_at(id, 0.0, 0.0).unwrap() - 0.2).abs() < 1e-4);
        let info = p.slab_shape_info(id).unwrap();
        assert_eq!(info.handles.len(), 5);
        assert_eq!(info.creases.len(), 4);
        // Reset.
        p.set_slab_shape(id, &SlabShape::default()).unwrap();
        assert!((mesh(&p, id).aabb().unwrap().1[1] - 0.2).abs() < 1e-4);
    }

    #[test]
    fn opening_cuts_a_shaped_slab() {
        let mut p = Project::new();
        let id = slab(&mut p);
        p.set_slab_shape(
            id,
            &SlabShape {
                z: vec![0.0, 0.6, 0.6, 0.0],
                ..Default::default()
            },
        )
        .unwrap();
        p.create_element_with_parent(
            "apex.slab_opening",
            poly(&[(2.0, 1.0), (3.0, 1.0), (3.0, 2.0), (2.0, 2.0)]),
            ParamMap::new().with("depth", ParamValue::Length(2.0)),
            Some(id),
        )
        .unwrap();
        let m = mesh(&p, id);
        assert!(is_watertight(&m));
        let v = mesh_volume(&m);
        assert!((v - (24.0 - 1.0) * 0.2).abs() < 1e-3, "{v}");
    }
}
