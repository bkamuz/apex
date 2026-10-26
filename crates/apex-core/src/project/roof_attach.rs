//! Walls whose top is attached to a roof (Revit's "Attach Top/Base").
//!
//! An attached wall is built tall enough to reach the highest roof underside
//! above it, then clipped with a real mesh boolean to the space under every
//! roof whose plan footprint covers it. Outside a roof footprint the wall keeps
//! its own height. Gable ends close exactly, and the clip follows roof edits
//! live because roofs list attached walls as solid dependents.

use apex_geometry::{
    mesh_boolean, polygon_region, BooleanOp, LayeredSolid, ShapedSurface, TriangleMesh, Underside,
};
#[cfg(test)]
use glam::Vec3;

use crate::builders::RoofShape;
use crate::element::{Element, ElementId};

use super::Project;

pub(crate) const PITCHED_ROOF: &str = "apex.roof.pitched";
pub(crate) const ATTACH_TOP: &str = "attach_top";
const WALL: &str = "apex.wall";
const FAR: f64 = 1.0e4;

/// The underside of a pitched (gable or hip) roof.
#[derive(Debug, Clone)]
pub(crate) struct RoofUnderside {
    pub surface: ShapedSurface,
    pub footprint: [[f64; 2]; 4],
    /// Underside height at the wall line and at the ridge.
    #[allow(dead_code)]
    pub eave_y: f32,
    pub ridge_y: f32,
}

impl RoofUnderside {
    /// Plan footprint corners (XZ), overhang included.
    pub fn footprint(&self) -> Vec<[f64; 2]> {
        self.footprint.to_vec()
    }

    /// Underside height above plan point `p` (None outside the footprint).
    #[cfg(test)]
    pub fn height_at(&self, p: Vec3) -> f32 {
        self.surface
            .height_at(p.x as f64, p.z as f64)
            .unwrap_or(f64::NAN) as f32
    }

    /// Closed solid of everything under the roof underside inside the
    /// footprint, from `y_low` up.
    pub fn below_mesh(&self, y_low: f32) -> Option<TriangleMesh> {
        self.surface.solid(Underside::Flat(y_low as f64)).ok()
    }
}

impl Project {
    pub(crate) fn wall_attaches_top(&self, element: &Element) -> bool {
        element.component_id == WALL
            && self
                .registry
                .eval_params(&element.component_id, &element.params)
                .ok()
                .and_then(|p| p.bool(ATTACH_TOP))
                .unwrap_or(false)
    }

    pub(crate) fn roof_underside(&self, roof: &Element) -> Option<RoofUnderside> {
        if roof.component_id != PITCHED_ROOF {
            return None;
        }
        let p = self
            .registry
            .eval_params(&roof.component_id, &roof.params)
            .ok()?;
        let anchors = roof.placement.anchors();
        let [a, b, ..] = anchors.as_slice() else {
            return None;
        };
        let shape = RoofShape::from_params(&p, *a, *b)?;
        let eave_y = (a.y as f64 + p.number("base_offset").unwrap_or(0.0)) as f32;
        Some(RoofUnderside {
            surface: shape.underside(),
            footprint: shape.footprint,
            eave_y,
            ridge_y: (shape.ridge_top - shape.drop) as f32,
        })
    }

    /// Roof undersides whose footprint overlaps `region`'s bounding area.
    fn roofs_over(&self, solid: &LayeredSolid) -> Vec<RoofUnderside> {
        let fp = solid.footprint();
        self.document
            .elements()
            .filter_map(|e| self.roof_underside(e))
            .filter(|r| {
                let roof = polygon_region(&r.footprint());
                !apex_geometry::region_intersect(&roof, &fp).is_empty()
            })
            .collect()
    }

    /// Height an attached wall must reach before clipping (None: no roof).
    pub(crate) fn attached_top(&self, element: &Element, solid: &LayeredSolid) -> Option<f64> {
        if !self.wall_attaches_top(element) {
            return None;
        }
        let roofs = self.roofs_over(solid);
        roofs
            .iter()
            .map(|r| r.ridge_y as f64 + 0.05)
            .reduce(f64::max)
    }

    /// Clip an attached wall's (extended) closed solid to the roofs above it.
    /// `own_top` is the wall's unextended top elevation.
    pub(crate) fn clip_to_roofs(&self, piece: &LayeredSolid, own_top: f64) -> Option<TriangleMesh> {
        let roofs = self.roofs_over(piece);
        if roofs.is_empty() {
            return None;
        }
        let (y0, _) = piece.y_range()?;
        let mut under = TriangleMesh::empty();
        let mut covered = LayeredSolid::empty();
        for r in &roofs {
            let m = r.below_mesh(y0 as f32 - 1.0)?;
            under = mesh_boolean(&under, &m, BooleanOp::Union).ok()?;
            covered = covered.union(&LayeredSolid::polygon_prism(&r.footprint(), -FAR, FAR));
        }
        let high = mesh_boolean(&piece.to_mesh(), &under, BooleanOp::Intersect).ok()?;
        // Outside every footprint the wall keeps its own height.
        let big = [[-FAR, -FAR], [FAR, -FAR], [FAR, FAR], [-FAR, FAR]];
        let low = piece
            .intersect(&LayeredSolid::polygon_prism(&big, -FAR, own_top))
            .subtract(&covered);
        if low.is_empty() {
            return Some(high);
        }
        mesh_boolean(&high, &low.to_mesh(), BooleanOp::Union).ok()
    }

    /// Attached walls that follow `roof`.
    pub(crate) fn roof_dependents(&self, roof: &Element) -> Vec<ElementId> {
        if roof.component_id != PITCHED_ROOF {
            return Vec::new();
        }
        self.document
            .elements()
            .filter(|e| self.wall_attaches_top(e))
            .map(|e| e.id)
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::param::{ParamMap, ParamValue};
    use crate::placement::Placement;
    use apex_geometry::{is_watertight, mesh_volume};

    fn roof(p: &mut Project, rise: f64) -> ElementId {
        p.create_element(
            PITCHED_ROOF,
            Placement::line(Vec3::new(-0.5, 0.0, 4.0), Vec3::new(10.5, 0.0, 4.0)),
            ParamMap::new()
                .with("width", ParamValue::Length(8.0))
                .with("rise", ParamValue::Length(rise))
                .with("thickness", ParamValue::Length(0.15))
                .with("base_offset", ParamValue::Length(3.0)),
        )
        .expect("roof")
    }

    fn gable(p: &mut Project, x: f32, attach: bool) -> ElementId {
        p.create_element(
            WALL,
            Placement::line(Vec3::new(x, 0.0, 0.0), Vec3::new(x, 0.0, 8.0)),
            ParamMap::new().with(ATTACH_TOP, ParamValue::Bool(attach)),
        )
        .expect("wall")
    }

    fn top_at(p: &Project, id: ElementId, z: f32) -> f32 {
        let m = p.document().get_mesh(id).expect("mesh");
        let mut best = f32::MIN;
        for v in m.positions.chunks(3) {
            if (v[2] - z).abs() < 0.02 {
                best = best.max(v[1]);
            }
        }
        if best == f32::MIN {
            // No vertex there (an unclipped box): its overall top.
            best = m.positions.chunks(3).map(|v| v[1]).fold(f32::MIN, f32::max);
        }
        best
    }

    fn expected_volume(r: &RoofUnderside) -> f64 {
        // 0.2 thick, 8 long: rectangle to the eave plus the gable triangle.
        0.2 * (8.0 * r.eave_y as f64 + 0.5 * 8.0 * (r.ridge_y - r.eave_y) as f64)
    }

    #[test]
    fn attached_gable_wall_fills_the_roof_triangle() {
        let mut p = Project::new();
        let r_id = roof(&mut p, 1.8);
        let w = gable(&mut p, 0.0, true);
        let r = p
            .roof_underside(p.document().get_element(r_id).unwrap())
            .unwrap();
        let mesh = p.document().get_mesh(w).unwrap();
        assert!(is_watertight(mesh));
        let v = mesh_volume(mesh);
        assert!((v - expected_volume(&r)).abs() < 2e-3, "{v}");
        assert!((top_at(&p, w, 4.0) - r.ridge_y).abs() < 1e-3);
        assert!((r.height_at(Vec3::new(0.0, 0.0, 4.0)) - r.ridge_y).abs() < 1e-6);
        assert!((top_at(&p, w, 0.0) - r.eave_y).abs() < 1e-3);
    }

    #[test]
    fn unattached_or_uncovered_walls_keep_their_height() {
        let mut p = Project::new();
        roof(&mut p, 1.8);
        let plain = gable(&mut p, 0.0, false);
        let far = gable(&mut p, 20.0, true);
        assert!((top_at(&p, plain, 4.0) - 3.0).abs() < 1e-4);
        assert!((top_at(&p, far, 4.0) - 3.0).abs() < 1e-4);
    }

    #[test]
    fn clip_follows_roof_edits_and_undo() {
        let mut p = Project::new();
        let r_id = roof(&mut p, 1.8);
        let w = gable(&mut p, 10.0, true);
        let before = top_at(&p, w, 4.0);
        p.update_element(
            r_id,
            Some(ParamMap::new().with("rise", ParamValue::Length(2.5))),
            None,
            true,
        )
        .unwrap();
        let after = top_at(&p, w, 4.0);
        assert!((after - before - 0.7).abs() < 0.02, "{before} -> {after}");
        p.undo().unwrap();
        assert!((top_at(&p, w, 4.0) - before).abs() < 1e-4);
        // Detaching restores the plain wall.
        p.update_element(
            w,
            Some(ParamMap::new().with(ATTACH_TOP, ParamValue::Bool(false))),
            None,
            true,
        )
        .unwrap();
        assert!((top_at(&p, w, 4.0) - 3.0).abs() < 1e-4);
    }

    #[test]
    fn attached_wall_joined_at_corners_stays_closed() {
        let mut p = Project::new();
        roof(&mut p, 1.8);
        let pts = [(0.0, 0.0), (10.0, 0.0), (10.0, 8.0), (0.0, 8.0)];
        let mut ids = Vec::new();
        for i in 0..4 {
            let (a, b) = (pts[i], pts[(i + 1) % 4]);
            let attach = i % 2 == 1; // the two gable ends
            ids.push(
                p.create_element(
                    WALL,
                    Placement::line(Vec3::new(a.0, 0.0, a.1), Vec3::new(b.0, 0.0, b.1)),
                    ParamMap::new().with(ATTACH_TOP, ParamValue::Bool(attach)),
                )
                .unwrap(),
            );
        }
        for id in [ids[1], ids[3]] {
            let m = p
                .closed_solid_mesh(p.document().get_element(id).unwrap())
                .unwrap();
            assert!(is_watertight(&m));
            assert!(top_at(&p, id, 4.0) > 4.5);
        }
        // Plan cut still works for clipped walls.
        let e = p.document().get_element(ids[1]).unwrap();
        assert!(p.plan_cut_region(e, 1.2).is_some());
    }
}
