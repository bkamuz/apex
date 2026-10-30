//! Walls whose top is attached to a roof (Revit's "Attach Top/Base").
//!
//! An attached wall is built tall enough to reach the highest roof underside
//! above it, then clipped with a real mesh boolean to the space under every
//! roof whose plan footprint covers it. Outside a roof footprint the wall keeps
//! its own height. Gable ends close exactly, and the clip follows roof edits
//! live because roofs list attached walls as solid dependents.

use apex_geometry::{
    polygon_region, BooleanOp, LayeredSolid, ShapedSurface, TriangleMesh, Underside,
};
#[cfg(test)]
use glam::Vec3;

use crate::builders::RoofShape;
use crate::element::{Element, ElementId};

use super::Project;

pub(crate) const PITCHED_ROOF: &str = "apex.roof.pitched";
pub(crate) const FLAT_ROOF: &str = "apex.roof";
pub(crate) const ATTACH_TOP: &str = "attach_top";
pub(crate) const ATTACH_BASE: &str = "attach_base";
pub(crate) const ATTACH_TOP_TO: &str = "attach_top_to";
pub(crate) const ATTACH_BASE_TO: &str = "attach_base_to";
const WALL: &str = "apex.wall";
/// Elements whose top/base can attach.
pub(crate) const ATTACHABLE: [&str; 2] = [WALL, "apex.column"];
/// Elements that can be attach targets besides pitched roofs.
const SURFACE_TARGETS: [&str; 2] = ["apex.slab", FLAT_ROOF];

/// The underside of a pitched (gable or hip) roof.
#[derive(Debug, Clone)]
pub(crate) struct RoofUnderside {
    pub surface: ShapedSurface,
    pub footprint: [[f64; 2]; 4],
    /// Underside height at the wall line and at the ridge.
    #[allow(dead_code)]
    pub eave_y: f32,
    #[allow(dead_code)]
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
}

/// Which face of a wall/column is attached.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttachEnd {
    Top,
    Base,
}

/// One attach target as seen from an attached element: the surface it meets
/// (a roof/slab underside for the top, a slab top for the base) and the plan
/// footprint that surface covers.
#[derive(Debug, Clone)]
pub(crate) struct AttachSurface {
    pub surface: ShapedSurface,
    pub footprint: Vec<[f64; 2]>,
    pub y_min: f64,
    pub y_max: f64,
}

fn surface_range(s: &ShapedSurface) -> (f64, f64) {
    let mut lo = f64::MAX;
    let mut hi = f64::MIN;
    for p in s.boundary.iter().chain(s.interior.iter()) {
        lo = lo.min(p[1]);
        hi = hi.max(p[1]);
    }
    (lo, hi)
}

fn parse_ids(text: &str) -> Vec<ElementId> {
    text.split(|c: char| c == ',' || c.is_whitespace())
        .filter(|t| !t.is_empty())
        .filter_map(|t| t.parse().ok())
        .collect()
}

impl Project {
    pub(crate) fn attach_flag(&self, element: &Element, end: AttachEnd) -> bool {
        if !ATTACHABLE.contains(&element.component_id.as_str()) {
            return false;
        }
        let key = match end {
            AttachEnd::Top => ATTACH_TOP,
            AttachEnd::Base => ATTACH_BASE,
        };
        self.registry
            .eval_params(&element.component_id, &element.params)
            .ok()
            .and_then(|p| p.bool(key))
            .unwrap_or(false)
    }

    pub(crate) fn wall_attaches_top(&self, element: &Element) -> bool {
        self.attach_flag(element, AttachEnd::Top) || self.attach_flag(element, AttachEnd::Base)
    }

    /// Explicit target ids for `end` (empty: automatic).
    pub(crate) fn attach_target_ids(&self, element: &Element, end: AttachEnd) -> Vec<ElementId> {
        let key = match end {
            AttachEnd::Top => ATTACH_TOP_TO,
            AttachEnd::Base => ATTACH_BASE_TO,
        };
        self.registry
            .eval_params(&element.component_id, &element.params)
            .ok()
            .and_then(|p| p.text(key).map(parse_ids))
            .unwrap_or_default()
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

    /// The surface of `target` an attached `end` meets, if it can be one.
    pub(crate) fn attach_surface(&self, target: &Element, end: AttachEnd) -> Option<AttachSurface> {
        let (surface, footprint) = if target.component_id == PITCHED_ROOF {
            let r = self.roof_underside(target)?;
            match end {
                AttachEnd::Top => (r.surface.clone(), r.footprint()),
                AttachEnd::Base => {
                    // Its top: the underside lifted by the slab thickness.
                    let p = self
                        .registry
                        .eval_params(&target.component_id, &target.params)
                        .ok()?;
                    let t = p.number("thickness").unwrap_or(0.0);
                    let mut s = r.surface.clone();
                    for q in s.boundary.iter_mut().chain(s.interior.iter_mut()) {
                        q[1] += t;
                    }
                    (s, r.footprint())
                }
            }
        } else if SURFACE_TARGETS.contains(&target.component_id.as_str()) {
            let shape = self.slab_shape(target)?;
            let (mut s, thickness) = self.surface_for(target, &shape)?;
            if end == AttachEnd::Top {
                for q in s.boundary.iter_mut().chain(s.interior.iter_mut()) {
                    q[1] -= thickness;
                }
            }
            let fp = s.boundary.iter().map(|q| [q[0], q[2]]).collect();
            (s, fp)
        } else {
            return None;
        };
        let (y_min, y_max) = surface_range(&surface);
        Some(AttachSurface {
            surface,
            footprint,
            y_min,
            y_max,
        })
    }

    /// Target surfaces for `end` whose footprint overlaps `solid`.
    fn attach_surfaces(
        &self,
        element: &Element,
        solid: &LayeredSolid,
        end: AttachEnd,
    ) -> Vec<AttachSurface> {
        if !self.attach_flag(element, end) {
            return Vec::new();
        }
        let ids = self.attach_target_ids(element, end);
        let fp = solid.footprint();
        let overlaps = |s: &AttachSurface| {
            !apex_geometry::region_intersect(&polygon_region(&s.footprint), &fp).is_empty()
        };
        if !ids.is_empty() {
            return ids
                .iter()
                .filter(|id| **id != element.id)
                .filter_map(|id| self.document.get_element(*id))
                .filter_map(|t| self.attach_surface(t, end))
                .filter(overlaps)
                .collect();
        }
        if end == AttachEnd::Base {
            // Automatic base: none (pick a target explicitly).
            return Vec::new();
        }
        // Automatic top: every roof above it.
        self.document
            .elements()
            .filter(|e| e.component_id == PITCHED_ROOF || e.component_id == FLAT_ROOF)
            .filter_map(|e| self.attach_surface(e, end))
            .filter(overlaps)
            .collect()
    }

    /// Elevation range an attached element must be built to before
    /// clipping: (lowest base, highest top), each `None` when that end does
    /// not move.
    pub(crate) fn attached_extent(
        &self,
        element: &Element,
        solid: &LayeredSolid,
    ) -> (Option<f64>, Option<f64>) {
        let top = self
            .attach_surfaces(element, solid, AttachEnd::Top)
            .iter()
            .map(|s| s.y_max + 0.05)
            .reduce(f64::max);
        let base = self
            .attach_surfaces(element, solid, AttachEnd::Base)
            .iter()
            .map(|s| s.y_min - 0.05)
            .reduce(f64::min);
        (base, top)
    }

    /// What clipping `element` removes, unbounded in plan: the exact prism
    /// part (above its own top / below its own base outside every target
    /// footprint) and the true-surface cutters (above each top target's
    /// underside, below each base target's top). `None` when it attaches
    /// to nothing.
    pub(crate) fn attach_cuts(
        &self,
        element: &Element,
        piece: &LayeredSolid,
        own: (f64, f64),
    ) -> Option<(LayeredSolid, Vec<TriangleMesh>)> {
        let tops = self.attach_surfaces(element, piece, AttachEnd::Top);
        let bases = self.attach_surfaces(element, piece, AttachEnd::Base);
        if tops.is_empty() && bases.is_empty() {
            return None;
        }
        let (y0, y1) = piece.y_range()?;
        let (lo, hi) = (y0 - 2.0, y1 + 2.0);
        let mut bb = [f64::MAX, f64::MAX, f64::MIN, f64::MIN];
        for q in piece.footprint().iter().flatten().flatten() {
            bb = [
                bb[0].min(q[0]),
                bb[1].min(q[1]),
                bb[2].max(q[0]),
                bb[3].max(q[1]),
            ];
        }
        let big = [
            [bb[0] - 5.0, bb[1] - 5.0],
            [bb[2] + 5.0, bb[1] - 5.0],
            [bb[2] + 5.0, bb[3] + 5.0],
            [bb[0] - 5.0, bb[3] + 5.0],
        ];
        let mut exact = LayeredSolid::empty();
        if !tops.is_empty() && y1 > own.1 + 1e-6 {
            let mut covered = LayeredSolid::empty();
            for s in &tops {
                covered = covered.union(&LayeredSolid::polygon_prism(&s.footprint, lo, hi));
            }
            exact = exact.union(&LayeredSolid::polygon_prism(&big, own.1, hi).subtract(&covered));
        }
        if !bases.is_empty() && y0 < own.0 - 1e-6 {
            let mut covered = LayeredSolid::empty();
            for s in &bases {
                covered = covered.union(&LayeredSolid::polygon_prism(&s.footprint, lo, hi));
            }
            exact = exact.union(&LayeredSolid::polygon_prism(&big, lo, own.0).subtract(&covered));
        }
        let mut cutters = Vec::new();
        for s in &tops {
            let below = s.surface.solid(Underside::Flat(lo - 1.0)).ok()?;
            let column = LayeredSolid::polygon_prism(&s.footprint, lo, hi + 1.0).to_mesh();
            cutters.push(crate::kroute::kbool(&column, &below, BooleanOp::Subtract).ok()?);
        }
        for s in &bases {
            cutters.push(s.surface.solid(Underside::Flat(lo)).ok()?);
        }
        Some((exact, cutters))
    }

    /// Clip an attached element's (extended) closed solid to its targets.
    /// `own` is the unextended elevation range. Under several top targets
    /// the lowest underside wins; outside every footprint the element keeps
    /// its own top and base.
    pub(crate) fn clip_to_roofs(
        &self,
        element: &Element,
        piece: &LayeredSolid,
        own: (f64, f64),
    ) -> Option<TriangleMesh> {
        let tops = self.attach_surfaces(element, piece, AttachEnd::Top);
        let bases = self.attach_surfaces(element, piece, AttachEnd::Base);
        if tops.is_empty() && bases.is_empty() {
            return None;
        }
        let (y0, y1) = piece.y_range()?;
        let (lo, hi) = (y0 - 2.0, y1 + 2.0);
        // Plan bounds of the piece, padded: a modest "everything" box keeps
        // the exact prism booleans well conditioned.
        let mut bb = [f64::MAX, f64::MAX, f64::MIN, f64::MIN];
        for q in piece.footprint().iter().flatten().flatten() {
            bb = [
                bb[0].min(q[0]),
                bb[1].min(q[1]),
                bb[2].max(q[0]),
                bb[3].max(q[1]),
            ];
        }
        let big = [
            [bb[0] - 5.0, bb[1] - 5.0],
            [bb[2] + 5.0, bb[1] - 5.0],
            [bb[2] + 5.0, bb[3] + 5.0],
            [bb[0] - 5.0, bb[3] + 5.0],
        ];
        // Exact prism part first: outside the target footprints the
        // element keeps its own top and base.
        let mut keep = piece.clone();
        if !tops.is_empty() && y1 > own.1 + 1e-6 {
            let mut covered = LayeredSolid::empty();
            for s in &tops {
                covered = covered.union(&LayeredSolid::polygon_prism(&s.footprint, lo, hi));
            }
            keep = keep.subtract(&LayeredSolid::polygon_prism(&big, own.1, hi).subtract(&covered));
        }
        if !bases.is_empty() && y0 < own.0 - 1e-6 {
            let mut covered = LayeredSolid::empty();
            for s in &bases {
                covered = covered.union(&LayeredSolid::polygon_prism(&s.footprint, lo, hi));
            }
            keep = keep.subtract(&LayeredSolid::polygon_prism(&big, lo, own.0).subtract(&covered));
        }
        if keep.is_empty() {
            return None;
        }
        // Then the true surfaces: everything above each top underside and
        // below each base top, inside that target's footprint.
        // One subtraction per target keeps every boolean free of coplanar
        // overlaps between targets.
        // Re-normalise the bands: a join-cluster share can carry regions that
        // touch along an edge, which the mesh kernel rejects as non-manifold.
        let keep = LayeredSolid::empty().union(&keep);
        // A join can leave the piece touching itself at one plan vertex
        // (e.g. a tee wall cutting through an L's corner); the mesh kernel
        // rejects that pinch, so open it by a hair.
        let keep = unpinch(&keep);
        let keep_own = unpinch(piece);
        let aboves = || -> Option<Vec<TriangleMesh>> {
            tops.iter()
                .map(|s| {
                    let below = s.surface.solid(Underside::Flat(lo - 1.0)).ok()?;
                    let column = LayeredSolid::polygon_prism(&s.footprint, lo, hi + 1.0).to_mesh();
                    crate::kroute::kbool(&column, &below, BooleanOp::Subtract).ok()
                })
                .collect()
        };
        let belows = || -> Option<Vec<TriangleMesh>> {
            bases
                .iter()
                .map(|s| s.surface.solid(Underside::Flat(lo)).ok())
                .collect()
        };
        let cutters = || -> Option<Vec<TriangleMesh>> {
            let mut all = aboves()?;
            all.extend(belows()?);
            Some(all)
        };
        // One subtraction per target keeps every boolean free of coplanar
        // overlaps between targets...
        let sequential = || -> Option<TriangleMesh> {
            let mut mesh = keep.to_mesh();
            for c in cutters()?.iter() {
                mesh = crate::kroute::kbool(&mesh, c, BooleanOp::Subtract).ok()?;
            }
            Some(mesh)
        };
        // ...but a cut result can weld into a pinched (non-manifold) mesh
        // the next cut rejects; then union the cutters (simple roof/slab
        // solids) and subtract once.
        let combined = || -> Option<TriangleMesh> {
            let mut cut = TriangleMesh::empty();
            for c in cutters()? {
                cut = crate::kroute::kbool(&cut, &c, BooleanOp::Union).ok()?;
            }
            crate::kroute::kbool(&keep.to_mesh(), &cut, BooleanOp::Subtract).ok()
        };
        // The kernel can also return a surface that no longer closes once
        // its vertices are rounded to f32; never keep such a result.
        let closed = |m: TriangleMesh| apex_geometry::is_closed(&m).then_some(m);
        let cut = || {
            sequential()
                .and_then(closed)
                .or_else(|| combined().and_then(closed))
        };
        // A kernel failure must never leave the build-time extension
        // standing: fall back to the element's own unattached extent.
        Some(cut().unwrap_or_else(|| {
            keep_own
                .subtract(&LayeredSolid::polygon_prism(&big, own.1, hi))
                .subtract(&LayeredSolid::polygon_prism(&big, lo, own.0))
                .to_mesh()
        }))
    }

    /// Attach (`targets: Some`) or detach (`None`) the `end` of every
    /// element in `ids`, as one undo step. Empty targets = automatic (top:
    /// every roof above). Fails without changing anything when an id is not
    /// a wall/column or a target cannot be attached to.
    pub fn set_attach(
        &mut self,
        ids: &[ElementId],
        end: AttachEnd,
        targets: Option<&[ElementId]>,
    ) -> Result<(), String> {
        if ids.is_empty() {
            return Err("no elements to attach".into());
        }
        for id in ids {
            let e = self
                .document
                .get_element(*id)
                .ok_or_else(|| format!("no element {id}"))?;
            if !ATTACHABLE.contains(&e.component_id.as_str()) {
                return Err(format!(
                    "{id} is a {}: only walls and columns attach",
                    e.component_id
                ));
            }
        }
        if let Some(ts) = targets {
            if ts.is_empty() && end == AttachEnd::Base {
                return Err("attach_base needs at least one target slab/roof".into());
            }
            for t in ts {
                let e = self
                    .document
                    .get_element(*t)
                    .ok_or_else(|| format!("no target {t}"))?;
                if ids.contains(t) || self.attach_surface(e, end).is_none() {
                    return Err(format!(
                        "{t} ({}) is not a roof or slab that can be attached to",
                        e.component_id
                    ));
                }
            }
        }
        let (flag, list) = match end {
            AttachEnd::Top => (ATTACH_TOP, ATTACH_TOP_TO),
            AttachEnd::Base => (ATTACH_BASE, ATTACH_BASE_TO),
        };
        let text = targets
            .map(|ts| {
                ts.iter()
                    .map(|t| t.to_string())
                    .collect::<Vec<_>>()
                    .join(",")
            })
            .unwrap_or_default();
        let patch = crate::param::ParamMap::new()
            .with(flag, crate::param::ParamValue::Bool(targets.is_some()))
            .with(list, crate::param::ParamValue::Text(text));
        self.begin_undo_group();
        for id in ids {
            if let Err(err) = self.update_element(*id, Some(patch.clone()), None, false) {
                self.abort_undo_group();
                return Err(err.to_string());
            }
        }
        self.commit_undo_group();
        Ok(())
    }

    /// Attached elements that follow `target` (a roof or slab).
    pub(crate) fn roof_dependents(&self, target: &Element) -> Vec<ElementId> {
        let auto_top = target.component_id == PITCHED_ROOF || target.component_id == FLAT_ROOF;
        if !auto_top && !SURFACE_TARGETS.contains(&target.component_id.as_str()) {
            return Vec::new();
        }
        self.document
            .elements()
            .filter(|e| e.id != target.id)
            .filter(|e| {
                [AttachEnd::Top, AttachEnd::Base].iter().any(|end| {
                    if !self.attach_flag(e, *end) {
                        return false;
                    }
                    let ids = self.attach_target_ids(e, *end);
                    if ids.is_empty() {
                        *end == AttachEnd::Top && auto_top
                    } else {
                        ids.contains(&target.id)
                    }
                })
            })
            .map(|e| e.id)
            .collect::<Vec<_>>()
            .into_iter()
            // Joined neighbours render a share of the clipped cluster.
            .flat_map(|id| match self.document.get_element(id) {
                Some(e) if self.in_attached_cluster(e) => self.join_cluster(e),
                _ => vec![id],
            })
            .collect()
    }
}

/// `solid` minus a 0.2 mm column at every plan vertex shared by two rings
/// (or twice by one ring) of one band, so its mesh is a manifold the boolean kernel accepts.
pub(crate) fn unpinch(solid: &LayeredSolid) -> LayeredSolid {
    const H: f64 = 1e-3;
    let mut seen = std::collections::HashMap::<[i64; 2], usize>::new();
    let mut pinches: Vec<[f64; 2]> = Vec::new();
    for band in solid.bands() {
        for shape in band {
            seen.clear();
            for (r, ring) in shape.iter().enumerate() {
                for p in ring {
                    let key = [(p[0] * 1e5).round() as i64, (p[1] * 1e5).round() as i64];
                    if seen.insert(key, r).is_some() {
                        pinches.push(*p);
                    }
                }
            }
        }
    }
    let Some((lo, hi)) = solid.y_range() else {
        return solid.clone();
    };
    pinches.iter().fold(solid.clone(), |s, p| {
        let sq = [
            [p[0] - H, p[1] - H],
            [p[0] + H, p[1] - H],
            [p[0] + H, p[1] + H],
            [p[0] - H, p[1] + H],
        ];
        s.subtract(&LayeredSolid::polygon_prism(&sq, lo - 1.0, hi + 1.0))
    })
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

    fn wall_to(p: &mut Project, a: (f32, f32), b: (f32, f32), params: ParamMap) -> ElementId {
        p.create_element(
            WALL,
            Placement::line(Vec3::new(a.0, 0.0, a.1), Vec3::new(b.0, 0.0, b.1)),
            params,
        )
        .expect("wall")
    }

    fn hip_roof(p: &mut Project) -> ElementId {
        let id = roof(p, 1.8);
        p.update_element(
            id,
            Some(ParamMap::new().with("roof_type", ParamValue::Choice("hip".into()))),
            None,
            true,
        )
        .unwrap();
        id
    }

    fn slab(p: &mut Project, y: f32, pts: &[(f32, f32)]) -> ElementId {
        let pts: Vec<Vec3> = pts.iter().map(|q| Vec3::new(q.0, 0.0, q.1)).collect();
        let ground = p.document().active_level_id().expect("level");
        if y.abs() > 1e-6 {
            let l = p.add_level("Ceiling", y);
            p.set_active_level(l).unwrap();
        }
        let id = p
            .create_element(
                "apex.slab",
                p.placement_from_points("apex.slab", &pts, 0.0)
                    .expect("placement"),
                ParamMap::new(),
            )
            .expect("slab");
        p.set_active_level(ground).unwrap();
        id
    }

    #[test]
    fn hip_end_wall_follows_the_hip() {
        let mut p = Project::new();
        let r_id = hip_roof(&mut p);
        let w = gable(&mut p, 0.0, true);
        let r = p
            .roof_underside(p.document().get_element(r_id).unwrap())
            .unwrap();
        let m = p.document().get_mesh(w).unwrap().clone();
        let closed = p
            .closed_solid_mesh(p.document().get_element(w).unwrap())
            .unwrap();
        assert!(is_watertight(&closed));
        // Under a hip the end wall rises less than the full ridge.
        let mid = top_at(&p, w, 4.0);
        let expect = r.height_at(Vec3::new(0.1, 0.0, 4.0));
        assert!((mid - expect).abs() < 0.12, "{mid} vs {expect}");
        assert!(mid < r.ridge_y - 0.05);
        // Nothing pokes above the underside anywhere along the wall.
        for v in m.positions.chunks(3) {
            if let Some(h) = r.surface.height_at(v[0] as f64, v[2] as f64) {
                assert!(v[1] as f64 <= h + 0.11, "{v:?} above {h}");
            }
        }
    }

    #[test]
    fn wall_past_the_roof_footprint_keeps_its_height() {
        let mut p = Project::new();
        roof(&mut p, 1.8);
        // Runs from under the roof (z 0..8) out to z = 14.
        let w = wall_to(
            &mut p,
            (5.0, 2.0),
            (5.0, 14.0),
            ParamMap::new().with(ATTACH_TOP, ParamValue::Bool(true)),
        );
        let closed = p
            .closed_solid_mesh(p.document().get_element(w).unwrap())
            .unwrap();
        assert!(is_watertight(&closed));
        let m = p.document().get_mesh(w).unwrap();
        let past = m
            .positions
            .chunks(3)
            .filter(|v| v[2] > 8.5)
            .map(|v| v[1])
            .fold(f32::MIN, f32::max);
        assert!((past - 3.0).abs() < 1e-3, "{past}");
        assert!(top_at(&p, w, 4.0) > 4.5);
    }

    #[test]
    fn shaped_slab_and_lowest_of_several_targets() {
        let mut p = Project::new();
        let r_id = roof(&mut p, 1.8);
        // A ceiling slab at 2.6 over half the house, sloped up to 3.0.
        let s = slab(
            &mut p,
            2.6,
            &[(0.0, -1.0), (4.0, -1.0), (4.0, 9.0), (0.0, 9.0)],
        );
        let mut shape = p.slab_shape(p.document().get_element(s).unwrap()).unwrap();
        shape.z = vec![0.4, 0.0, 0.0, 0.4];
        p.set_slab_shape(s, &shape).unwrap();
        let w = wall_to(
            &mut p,
            (2.0, 4.0),
            (8.0, 4.0),
            ParamMap::new()
                .with(ATTACH_TOP, ParamValue::Bool(true))
                .with(ATTACH_TOP_TO, ParamValue::Text(format!("{r_id}, {s}"))),
        );
        let closed = p
            .closed_solid_mesh(p.document().get_element(w).unwrap())
            .unwrap();
        assert!(is_watertight(&closed));
        let m = p.document().get_mesh(w).unwrap();
        let top_x = |x: f32| {
            m.positions
                .chunks(3)
                .filter(|v| (v[0] - x).abs() < 0.02)
                .map(|v| v[1])
                .fold(f32::MIN, f32::max)
        };
        // Under the slab: its underside (top minus the 0.2 m thickness).
        let t = p.slab_top_at(s, 2.0, 4.0).unwrap() as f32;
        assert!(
            (top_x(2.0) - (t - 0.2)).abs() < 0.02,
            "{} vs {t}",
            top_x(2.0)
        );
        // Past the slab: the roof (above 4.5 mid-house).
        assert!(top_x(8.0) > 4.0, "{}", top_x(8.0));
        // Editing the slab moves the wall; undo restores it.
        let before = top_x(2.0);
        shape.z = vec![0.0, 0.0, 0.0, 0.0];
        p.set_slab_shape(s, &shape).unwrap();
        let m2 = p.document().get_mesh(w).unwrap();
        let after = m2
            .positions
            .chunks(3)
            .filter(|v| (v[0] - 2.0).abs() < 0.02)
            .map(|v| v[1])
            .fold(f32::MIN, f32::max);
        assert!((before - after).abs() > 0.05, "{before} {after}");
        p.undo().unwrap();
        let m3 = p.document().get_mesh(w).unwrap();
        let back = m3
            .positions
            .chunks(3)
            .filter(|v| (v[0] - 2.0).abs() < 0.02)
            .map(|v| v[1])
            .fold(f32::MIN, f32::max);
        assert!((back - before).abs() < 1e-3);
        // Deleting the target detaches gracefully.
        p.delete_element(s);
        assert!(top_x_of(&p, w, 2.0) > 4.0);
    }

    fn top_x_of(p: &Project, w: ElementId, x: f32) -> f32 {
        p.document()
            .get_mesh(w)
            .unwrap()
            .positions
            .chunks(3)
            .filter(|v| (v[0] - x).abs() < 0.02)
            .map(|v| v[1])
            .fold(f32::MIN, f32::max)
    }

    #[test]
    fn base_attaches_to_a_slab_top_and_columns_attach_too() {
        let mut p = Project::new();
        let s = slab(
            &mut p,
            0.0,
            &[(-1.0, -1.0), (11.0, -1.0), (11.0, 9.0), (-1.0, 9.0)],
        );
        let mut shape = p.slab_shape(p.document().get_element(s).unwrap()).unwrap();
        shape.z = vec![0.0, 0.6, 0.6, 0.0];
        p.set_slab_shape(s, &shape).unwrap();
        let w = wall_to(
            &mut p,
            (0.0, 4.0),
            (10.0, 4.0),
            ParamMap::new()
                .with(ATTACH_BASE, ParamValue::Bool(true))
                .with(ATTACH_BASE_TO, ParamValue::Text(s.to_string())),
        );
        let closed = p
            .closed_solid_mesh(p.document().get_element(w).unwrap())
            .unwrap();
        assert!(is_watertight(&closed));
        let m = p.document().get_mesh(w).unwrap();
        for v in m.positions.chunks(3) {
            let top = p.slab_top_at(s, v[0] as f64, v[2] as f64).unwrap();
            assert!(v[1] as f64 >= top - 1e-3, "{v:?} below slab {top}");
        }
        let r = roof(&mut p, 1.8);
        let c = p
            .create_element(
                "apex.column",
                Placement::point(Vec3::new(5.0, 0.0, 4.0)),
                ParamMap::new()
                    .with(ATTACH_TOP, ParamValue::Bool(true))
                    .with(ATTACH_TOP_TO, ParamValue::Text(r.to_string())),
            )
            .unwrap();
        let cm = p.document().get_mesh(c).unwrap();
        let top = cm
            .positions
            .chunks(3)
            .map(|v| v[1])
            .fold(f32::MIN, f32::max);
        assert!(top > 4.4, "column top {top}");
        assert!(is_watertight(
            &p.closed_solid_mesh(p.document().get_element(c).unwrap())
                .unwrap()
        ));
    }

    #[test]
    fn attach_commands_are_one_undo_step_and_keep_openings() {
        let mut p = Project::new();
        let r = hip_roof(&mut p);
        let w1 = gable(&mut p, 4.0, false);
        let w2 = gable(&mut p, 6.0, false);
        let win = p
            .create_element_with_parent(
                "apex.window",
                Placement::point(Vec3::new(4.0, 0.0, 4.0)),
                ParamMap::new().with("width", ParamValue::Length(1.0)),
                Some(w1),
            )
            .unwrap();
        let cmd = format!(r#"{{"op":"attach_top","ids":["{w1}","{w2}"],"targets":["{r}"]}}"#);
        p.execute_json(&cmd).expect("attach_top");
        assert!(top_at(&p, w1, 4.0) > 3.5);
        assert!(top_at(&p, w2, 4.0) > 3.5);
        let closed = p
            .closed_solid_mesh(p.document().get_element(w1).unwrap())
            .unwrap();
        assert!(is_watertight(&closed));
        // The window still cuts the attached wall.
        let full = 0.2 * 8.0 * 3.0;
        assert!(mesh_volume(&closed) > full);
        assert!(p.document().get_element(win).is_some());
        // Bad target refused without changes.
        let bad = format!(r#"{{"op":"attach_top","ids":["{w1}"],"targets":["{win}"]}}"#);
        assert!(p.execute_json(&bad).is_err());
        // One undo restores both walls.
        p.undo().unwrap();
        assert!((top_at(&p, w1, 4.0) - 3.0).abs() < 1e-3);
        assert!((top_at(&p, w2, 4.0) - 3.0).abs() < 1e-3);
        p.redo().unwrap();
        p.execute_json(&format!(r#"{{"op":"detach","ids":["{w1}"],"end":"top"}}"#))
            .unwrap();
        assert!((top_at(&p, w1, 4.0) - 3.0).abs() < 1e-3);
        assert!(top_at(&p, w2, 4.0) > 3.5);
    }
}
