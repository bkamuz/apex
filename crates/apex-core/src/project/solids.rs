//! Real solid booleans and wall-join clusters on top of
//! [`apex_geometry::LayeredSolid`].
//!
//! * Hosts whose swept/extruded mesh is a vertical prism (straight and
//!   polyline walls, beams, slabs) are rebuilt as layered solids and their
//!   openings — doors, windows, slab openings and stair wells — are exact
//!   subtractions with reveal faces.
//! * Joinable elements that touch form a cluster: L corners are mitred along
//!   the line through the inner and outer face intersections (exact for any
//!   angle and for different thicknesses), every overlap is owned by one wall
//!   (thicker first), and each wall is meshed as a piece of its cluster's
//!   union, so the cluster reads as one mass: no buried faces, no z-fighting,
//!   no internal lines, in 3D and in the plan cut.

use apex_geometry::{
    point_in_region, polygon_region, region_area, region_intersect, LayeredSolid, Region,
    TriangleMesh, JOIN_SNAP,
};
use glam::Vec3;

use crate::component::GeometryRecipe;
use crate::element::{Element, ElementId};
use crate::path_join::{end_join_allowed, joinable_segment, profile_half_width};
use crate::placement::PlacementKind;

use super::{project_onto_curve_xz, Project};

const STAIR: &str = "apex.stair";
const SLAB: &str = "apex.slab";

fn xz(v: Vec3) -> [f64; 2] {
    [v.x as f64, v.z as f64]
}

/// Intersection of lines `p + t·d` and `q + s·e` in plan.
fn line_hit(p: [f64; 2], d: [f64; 2], q: [f64; 2], e: [f64; 2]) -> Option<[f64; 2]> {
    let den = d[0] * e[1] - d[1] * e[0];
    if den.abs() < 1e-9 {
        return None;
    }
    let w = [q[0] - p[0], q[1] - p[1]];
    let t = (w[0] * e[1] - w[1] * e[0]) / den;
    Some([p[0] + d[0] * t, p[1] + d[1] * t])
}

fn seg_dist(p: [f64; 2], a: [f64; 2], b: [f64; 2]) -> f64 {
    let d = [b[0] - a[0], b[1] - a[1]];
    let l2 = d[0] * d[0] + d[1] * d[1];
    let t = if l2 < 1e-18 {
        0.0
    } else {
        (((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / l2).clamp(0.0, 1.0)
    };
    let q = [a[0] + d[0] * t, a[1] + d[1] * t];
    ((p[0] - q[0]).powi(2) + (p[1] - q[1]).powi(2)).sqrt()
}

/// Plan distance from `p` to a region (0 inside).
pub(crate) fn region_distance(region: &Region, p: [f64; 2]) -> f64 {
    if point_in_region(region, p) {
        return 0.0;
    }
    region
        .iter()
        .flat_map(|s| s.iter())
        .flat_map(|ring| (0..ring.len()).map(move |i| (ring[i], ring[(i + 1) % ring.len()])))
        .map(|(a, b)| seg_dist(p, a, b))
        .fold(f64::MAX, f64::min)
}

/// Overlapping or sharing boundary in plan.
pub(crate) fn regions_touch(a: &Region, b: &Region) -> bool {
    if a.is_empty() || b.is_empty() {
        return false;
    }
    if region_area(&region_intersect(a, b)) > 1e-8 {
        return true;
    }
    let near = |x: &Region, y: &Region| {
        x.iter()
            .flat_map(|s| s.iter())
            .flatten()
            .any(|p| region_distance(y, *p) < 1e-4)
    };
    near(a, b) || near(b, a)
}

/// One mitred corner at an end of a joinable element.
struct Corner {
    at_start: bool,
    /// Generous extension so the mitre line, not the square end, bounds it.
    extension: f32,
    /// Half-plane (big quad) on this element's side of the mitre line.
    keep: Region,
}

impl Project {
    pub(crate) fn joinable(&self, element: &Element) -> bool {
        self.registry
            .get(&element.component_id)
            .is_some_and(|d| d.joinable)
    }

    /// Joinable peers on the same level whose plan bounds come near `element`.
    pub(crate) fn join_candidates(&self, element: &Element) -> Vec<ElementId> {
        if !self.joinable(element) {
            return Vec::new();
        }
        let Some((lo, hi)) = self.plan_bounds(element) else {
            return Vec::new();
        };
        let level = self.document.effective_level_id(element.id);
        self.document
            .elements()
            .filter(|o| o.id != element.id && o.component_id == element.component_id)
            .filter(|o| self.document.effective_level_id(o.id) == level)
            .filter(|o| {
                self.plan_bounds(o).is_some_and(|(a, b)| {
                    a[0] <= hi[0] && b[0] >= lo[0] && a[1] <= hi[1] && b[1] >= lo[1]
                })
            })
            .map(|o| o.id)
            .collect()
    }

    /// Centerline bounds grown by a generous join margin.
    fn plan_bounds(&self, element: &Element) -> Option<([f64; 2], [f64; 2])> {
        let curve = element.placement.curve()?;
        let hw = profile_half_width(&self.registry, element).unwrap_or(0.1) as f64;
        let pts = element.placement.anchors();
        let mut pts: Vec<Vec3> = pts;
        pts.push(curve.start());
        pts.push(curve.end());
        let m = 4.0 * hw + 0.6;
        let mut lo = [f64::MAX; 2];
        let mut hi = [f64::MIN; 2];
        for p in pts {
            lo[0] = lo[0].min(p.x as f64 - m);
            lo[1] = lo[1].min(p.z as f64 - m);
            hi[0] = hi[0].max(p.x as f64 + m);
            hi[1] = hi[1].max(p.z as f64 + m);
        }
        Some((lo, hi))
    }

    /// Mitred corners at this element's ends (end-to-end joins).
    fn corners(&self, element: &Element) -> Vec<Corner> {
        let Some(seg) = joinable_segment(&self.registry, element) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for at_start in [true, false] {
            if !end_join_allowed(&self.registry, element, at_start) {
                continue;
            }
            let c = if at_start {
                seg.curve.start()
            } else {
                seg.curve.end()
            };
            let Some(out_a) = apex_geometry::outward_dir(&seg.curve, at_start) else {
                continue;
            };
            for peer_id in self.join_candidates(element) {
                let Some(peer) = self.document.get_element(peer_id) else {
                    continue;
                };
                let Some(pseg) = joinable_segment(&self.registry, peer) else {
                    continue;
                };
                for peer_start in [true, false] {
                    let pc = if peer_start {
                        pseg.curve.start()
                    } else {
                        pseg.curve.end()
                    };
                    if apex_geometry::plan_distance(c, pc) > JOIN_SNAP
                        || !end_join_allowed(&self.registry, peer, peer_start)
                    {
                        continue;
                    }
                    let Some(out_b) = apex_geometry::outward_dir(&pseg.curve, peer_start) else {
                        continue;
                    };
                    let Some(theta) = apex_geometry::angle_between(out_a, out_b) else {
                        continue;
                    };
                    if theta < 0.15 || std::f32::consts::PI - theta < 0.15 {
                        continue;
                    }
                    if let Some(corner) =
                        mitre(c, out_a, seg.half_width, out_b, pseg.half_width, at_start)
                    {
                        out.push(corner);
                    }
                }
            }
        }
        out
    }

    /// The element's own solid before cluster partitioning: its prism, mitred
    /// at corners, minus every hosted opening. `None` when not a prism.
    pub(crate) fn own_solid(&self, element: &Element) -> Option<LayeredSolid> {
        self.own_solid_at(element, true)
    }

    /// `extend`: walls attached to a roof are built up to the roof ridge
    /// (clipped later in [`Self::solid_mesh`]).
    fn own_solid_at(&self, element: &Element, extend: bool) -> Option<LayeredSolid> {
        let def = self.registry.get(&element.component_id)?;
        if def.host_cut.is_some() {
            return None;
        }
        if self.shaped_surface(element).is_some() {
            // Not a vertical prism: built by `shaped_slab_mesh` instead.
            return None;
        }
        let joinable = def.joinable;
        let voids = self.void_solids(element);
        if !joinable && voids.is_empty() && !self.wall_attaches_top(element) {
            return None;
        }
        if !matches!(
            def.recipe,
            GeometryRecipe::Sweep { .. } | GeometryRecipe::Extrude { .. }
        ) {
            return None;
        }
        let corners = if joinable {
            self.corners(element)
        } else {
            Vec::new()
        };
        let mut base = element.clone();
        if joinable {
            // Ends are derived live from the corners (stored path-join
            // extensions go stale when a neighbour moves away). Tees need
            // none: the stub's body already reaches the host.
            base.join_start = 0.0;
            base.join_end = 0.0;
            for c in &corners {
                if c.at_start {
                    base.join_start = base.join_start.max(c.extension);
                } else {
                    base.join_end = base.join_end.max(c.extension);
                }
            }
        }
        let level_id = self
            .document
            .effective_level_id(element.id)
            .unwrap_or(element.level_id);
        let mesh = self
            .registry
            .build_element_mesh(&base, self.work_plane(level_id), self.document.references())
            .ok()?;
        let mut solid = LayeredSolid::from_vertical_prism_mesh(&mesh)?;
        if extend {
            if let Some((y0, y1)) = solid.y_range() {
                let (base_to, top_to) = self.attached_extent(element, &solid);
                let down = base_to.map_or(0.0, |b| (y0 - b).max(0.0));
                let up = top_to.map_or(0.0, |t| (t - y1).max(0.0));
                if down > 1e-4 || up > 1e-4 {
                    let mut tall = base.clone();
                    let h = self
                        .registry
                        .eval_params(&element.component_id, &element.params)
                        .ok()
                        .and_then(|p| p.number("height"))
                        .unwrap_or(y1 - y0);
                    tall.params
                        .set("height", crate::param::ParamValue::Length(h + up + down));
                    if down > 1e-4 {
                        tall.placement =
                            tall.placement
                                .translated(glam::Vec3::new(0.0, -(down as f32), 0.0));
                    }
                    if let Ok(m) = self.registry.build_element_mesh(
                        &tall,
                        self.work_plane(level_id),
                        self.document.references(),
                    ) {
                        if let Some(s) = LayeredSolid::from_vertical_prism_mesh(&m) {
                            solid = s;
                        }
                    }
                }
            }
        }
        for c in &corners {
            let (y0, y1) = solid.y_range()?;
            solid = solid.intersect(&LayeredSolid::prism(c.keep.clone(), y0 - 1.0, y1 + 1.0));
        }
        for v in &voids {
            solid = solid.subtract(v);
        }
        Some(solid)
    }

    /// Exact void solids of everything that cuts `host`: hosted doors,
    /// windows and slab openings, plus stair wells for slabs at a stair top.
    pub(crate) fn void_solids(&self, host: &Element) -> Vec<LayeredSolid> {
        let Some(host_def) = self.registry.get(&host.component_id) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for child_id in self.document.children_of(host.id) {
            let Some(child) = self.document.get_element(child_id) else {
                continue;
            };
            let Some(def) = self.registry.get(&child.component_id) else {
                continue;
            };
            let Some(cut) = &def.host_cut else {
                continue;
            };
            if !cut.host_categories.iter().any(|c| c == &host_def.category) {
                continue;
            }
            let Ok(params) = def.resolve_params(&child.params) else {
                continue;
            };
            if def.placement == PlacementKind::Polyline {
                let anchors = child.placement.anchors();
                if anchors.len() < 3 {
                    continue;
                }
                let depth = params.number("depth").unwrap_or(0.5);
                let poly: Vec<[f64; 2]> = anchors.iter().map(|p| xz(*p)).collect();
                let y0 = anchors.iter().map(|p| p.y).fold(f32::MAX, f32::min) as f64;
                let y1 = anchors.iter().map(|p| p.y).fold(f32::MIN, f32::max) as f64;
                out.push(LayeredSolid::polygon_prism(
                    &poly,
                    y0 - 0.05,
                    y1 + depth + 0.05,
                ));
                continue;
            }
            let origin = child.placement.origin();
            let width = params.number("width").unwrap_or(0.9);
            let height = params.number("height").unwrap_or(2.1);
            let sill = params.number("sill").unwrap_or(0.0);
            let (center, u) = match host.placement.curve().and_then(|curve| {
                let dir = crate::path_join::host_tangent_at(curve, origin)?;
                let u = Vec3::new(dir.x, 0.0, dir.z).try_normalize()?;
                Some((project_onto_curve_xz(curve, origin).unwrap_or(origin), u))
            }) {
                Some(found) => found,
                None => {
                    let yaw = self.hosted_opening_yaw(child).unwrap_or(0.0);
                    (origin, Vec3::new(yaw.cos(), 0.0, -yaw.sin()))
                }
            };
            let n = Vec3::new(-u.z, 0.0, u.x);
            let (hu, hn) = (width as f32 * 0.5, 0.6_f32);
            let poly: Vec<[f64; 2]> = [(-hu, -hn), (hu, -hn), (hu, hn), (-hu, hn)]
                .iter()
                .map(|(a, b)| xz(center + u * *a + n * *b))
                .collect();
            let y = origin.y as f64 + sill;
            out.push(LayeredSolid::polygon_prism(
                &poly,
                y - 0.02,
                y + height + 0.02,
            ));
        }
        if host.component_id == SLAB {
            out.extend(self.stair_wells_for_slab(host));
        }
        out
    }

    /// Stair footprints for every stair whose top lands on this slab's level.
    fn stair_wells_for_slab(&self, slab: &Element) -> Vec<LayeredSolid> {
        let Some(elevation) = self
            .document
            .effective_level_id(slab.id)
            .and_then(|l| self.document.get_level(l))
            .map(|l| l.elevation)
        else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for stair in self.document.elements().filter(|e| e.component_id == STAIR) {
            let Some(footprint) = self.stair_footprint(stair) else {
                continue;
            };
            if (footprint.1 - elevation).abs() >= 0.05 {
                continue;
            }
            let poly: Vec<[f64; 2]> = footprint.0.iter().map(|p| xz(*p)).collect();
            out.push(LayeredSolid::polygon_prism(&poly, -1.0e4, 1.0e4));
        }
        out
    }

    /// Plan rectangle and top elevation of a stair run.
    pub(crate) fn stair_footprint(&self, stair: &Element) -> Option<([Vec3; 4], f32)> {
        let params = self
            .registry
            .persistable_params(&stair.component_id, &stair.params)
            .ok()?;
        let height = params.number("height").unwrap_or(0.0) as f32;
        let width = params.number("width").unwrap_or(1.0) as f32;
        let anchors = stair.placement.anchors();
        let [a, b, ..] = anchors.as_slice() else {
            return None;
        };
        if height <= 1e-3 {
            return None;
        }
        let dir = Vec3::new(b.x - a.x, 0.0, b.z - a.z).normalize_or_zero();
        let side = Vec3::new(-dir.z, 0.0, dir.x) * (width * 0.5);
        Some(([*a - side, *b - side, *b + side, *a + side], a.y + height))
    }

    /// Final mesh for prism hosts and joinable elements, or `None` to fall
    /// back to the plain recipe mesh.
    pub(crate) fn solid_mesh(&self, element: &Element) -> Option<TriangleMesh> {
        let (piece, whole) = self.solid_piece(element)?;
        if let Some(clipped) = self.roof_clipped(element, &piece) {
            return Some(clipped);
        }
        // An attached wall never clusters (see `solid_piece`): when its
        // roof clip yields nothing it still renders its whole closed piece.
        Some(match whole.filter(|_| !self.wall_attaches_top(element)) {
            Some(whole) => piece.to_mesh_within(&whole),
            None => piece.to_mesh(),
        })
    }

    /// This element's own closed solid (its join-cluster share with every
    /// face, including the ones shared with peers). Boolean operands need it:
    /// the render mesh drops faces inside the cluster and is open there.
    pub(crate) fn closed_solid_mesh(&self, element: &Element) -> Option<TriangleMesh> {
        if let Some(mesh) = self.shaped_slab_mesh(element) {
            return Some(mesh);
        }
        let (piece, _) = self.solid_piece(element)?;
        if let Some(clipped) = self.roof_clipped(element, &piece) {
            return Some(clipped);
        }
        Some(piece.to_mesh())
    }

    /// [`Self::closed_solid_mesh`] as a boolean-kernel operand: a join can
    /// pinch the piece at one plan vertex, which the kernel rejects.
    pub(crate) fn closed_operand_mesh(&self, element: &Element) -> Option<TriangleMesh> {
        if let Some(mesh) = self.shaped_slab_mesh(element) {
            return Some(mesh);
        }
        let (piece, _) = self.solid_piece(element)?;
        if let Some(clipped) = self.roof_clipped(element, &piece) {
            return Some(clipped);
        }
        Some(super::roof_attach::unpinch(&piece).to_mesh())
    }

    /// An attached wall's piece clipped to the roofs above it.
    fn roof_clipped(&self, element: &Element, piece: &LayeredSolid) -> Option<TriangleMesh> {
        if !self.wall_attaches_top(element) {
            return None;
        }
        let own = self.own_solid_at(element, false)?.y_range()?;
        self.clip_to_roofs(element, piece, own)
    }

    /// Drops edge segments buried inside joinable solids (walls): a slab
    /// edge running under a wall, or seam lines left at wall joins. A
    /// segment is buried when its midpoint, nudged a little up and in every
    /// plan direction, stays inside some solid; edges on a solid's own
    /// boundary always have one nudge outside and survive.
    pub fn hide_buried_edges(&self, edges: &[f32]) -> Vec<f32> {
        let solids: Vec<(LayeredSolid, [f64; 4], (f64, f64))> = self
            .document
            .elements()
            .filter(|e| self.joinable(e))
            .filter_map(|e| {
                let (piece, whole) = self.solid_piece(e)?;
                let solid = whole.unwrap_or(piece);
                let yr = solid.y_range()?;
                let fp = solid.footprint();
                let mut b = [f64::MAX, f64::MAX, f64::MIN, f64::MIN];
                for p in fp.iter().flatten().flatten() {
                    b = [
                        b[0].min(p[0]),
                        b[1].min(p[1]),
                        b[2].max(p[0]),
                        b[3].max(p[1]),
                    ];
                }
                Some((solid, b, yr))
            })
            .collect();
        if solids.is_empty() {
            return edges.to_vec();
        }
        const D: f64 = 0.01;
        let inside = |p: [f64; 3]| {
            solids.iter().any(|(s, b, yr)| {
                p[0] > b[0]
                    && p[0] < b[2]
                    && p[2] > b[1]
                    && p[2] < b[3]
                    && p[1] > yr.0
                    && p[1] < yr.1
                    && s.contains(p)
            })
        };
        let mut out = Vec::with_capacity(edges.len());
        for seg in edges.as_chunks::<6>().0 {
            let m = [
                (seg[0] as f64 + seg[3] as f64) * 0.5,
                (seg[1] as f64 + seg[4] as f64) * 0.5 + 0.005,
                (seg[2] as f64 + seg[5] as f64) * 0.5,
            ];
            let buried = (seg[1] - seg[4]).abs() < 1e-4
                && [[D, 0.0], [-D, 0.0], [0.0, D], [0.0, -D]]
                    .iter()
                    .all(|o| inside([m[0] + o[0], m[1], m[2] + o[1]]));
            if !buried {
                out.extend_from_slice(seg);
            }
        }
        out
    }

    /// The plan region this element owns at height `y` (world), after joins
    /// and openings. Pieces of one cluster tile it without overlap, so their
    /// fills never double up or spill.
    pub fn plan_cut_region(&self, element: &Element, y: f32) -> Option<Region> {
        let (piece, _) = self.solid_piece(element)?;
        piece.region_at(y as f64).cloned()
    }

    /// This element's share of its join cluster plus the cluster's whole
    /// solid (None when it joins nothing).
    fn solid_piece(&self, element: &Element) -> Option<(LayeredSolid, Option<LayeredSolid>)> {
        let own = self.own_solid(element)?;
        if !self.joinable(element) {
            return Some((own, None));
        }
        let hw = profile_half_width(&self.registry, element).unwrap_or(0.0);
        let mine = own.footprint();
        let mut piece = own.clone();
        let mut whole = own.clone();
        let mut clustered = false;
        let mut outside = Vec::new();
        for peer_id in self.join_candidates(element) {
            let Some(peer) = self.document.get_element(peer_id) else {
                continue;
            };
            let Some(theirs) = self.own_solid(peer) else {
                continue;
            };
            let their_fp = theirs.footprint();
            if !regions_touch(&mine, &their_fp) {
                continue;
            }
            // Thicker walls own the overlap; ties go by content (stable across runs).
            let phw = profile_half_width(&self.registry, peer).unwrap_or(0.0);
            // Equal widths: a wall running through the joint (tee stem's
            // host, an L's own corner) beats one that ends against it, then
            // content order decides. Never the random id, so the result is
            // the same on every run.
            let peer_wins = phw > hw + 1e-5
                || ((phw - hw).abs() <= 1e-5
                    && (self.ends_against(peer, &mine, phw), peer.order_key())
                        < (
                            self.ends_against(element, &their_fp, hw),
                            element.order_key(),
                        ));
            if peer_wins {
                piece = piece.subtract(&theirs);
            }
            // A peer consumed by a boolean renders through the boolean's
            // own closed solid, not as a cluster piece: faces shared with
            // it must stay or the seam is left open.
            // Likewise a wall attached to a roof renders its own closed,
            // clipped piece.
            let peer_in_boolean =
                !self.boolean_consumers(peer_id).is_empty() || self.wall_attaches_top(peer);
            let me_in_boolean =
                !self.boolean_consumers(element.id).is_empty() || self.wall_attaches_top(element);
            if !peer_in_boolean
                && !me_in_boolean
                && self.ends_allow_cluster(element, &their_fp, hw)
                && self.ends_allow_cluster(peer, &mine, phw)
            {
                whole = whole.union(&theirs);
                clustered = true;
            } else if peer_wins {
                // Not clustered but it still trims this piece: the trimmed
                // end must stay a face of the cluster solid, or it is left
                // open against the peer.
                outside.push(theirs);
            }
        }
        for o in &outside {
            whole = whole.subtract(o);
        }
        Some((piece, clustered.then_some(whole)))
    }

    /// True when one of the element's path ends touches `other`.
    fn ends_against(&self, element: &Element, other: &Region, hw: f32) -> bool {
        let Some(curve) = element.placement.curve() else {
            return false;
        };
        if curve.is_closed() {
            return false;
        }
        [curve.start(), curve.end()]
            .into_iter()
            .any(|p| region_distance(other, xz(p)) <= hw as f64 + JOIN_SNAP as f64)
    }

    /// False when the contact with `other` sits at an end where joining is
    /// switched off.
    fn ends_allow_cluster(&self, element: &Element, other: &Region, hw: f32) -> bool {
        let Some(curve) = element.placement.curve() else {
            return true;
        };
        for at_start in [true, false] {
            if end_join_allowed(&self.registry, element, at_start) {
                continue;
            }
            let p = if at_start { curve.start() } else { curve.end() };
            if region_distance(other, xz(p)) <= hw as f64 + JOIN_SNAP as f64 {
                return false;
            }
        }
        true
    }

    /// Rebuild meshes of `ids` in place (no history, no cascade).
    pub(crate) fn refresh_meshes(&mut self, ids: impl IntoIterator<Item = ElementId>) {
        let mut seen = std::collections::BTreeSet::new();
        for id in ids {
            if !seen.insert(id) {
                continue;
            }
            let Some(element) = self.document.get_element(id).cloned() else {
                continue;
            };
            if let Ok(mesh) = self.build_element_mesh_with_cuts(&element) {
                self.document.update_element(element, mesh);
            }
        }
    }

    /// Elements whose solids depend on `element`: join neighbours, and every
    /// slab when it is a stair.
    pub(crate) fn solid_dependents(&self, element: &Element) -> Vec<ElementId> {
        let mut out = self.join_candidates(element);
        out.extend(self.boolean_dependents(element));
        out.extend(self.roof_dependents(element));
        if element.component_id == STAIR {
            out.extend(
                self.document
                    .elements()
                    .filter(|e| e.component_id == SLAB)
                    .map(|e| e.id),
            );
        }
        out
    }
}

/// Mitre at corner `c` between this element (outward `out_a`, half width
/// `hwa`) and a peer (outward `out_b`, half width `hwb`).
fn mitre(c: Vec3, out_a: Vec3, hwa: f32, out_b: Vec3, hwb: f32, at_start: bool) -> Option<Corner> {
    let a = [-(out_a.x as f64), -(out_a.z as f64)];
    let b = [-(out_b.x as f64), -(out_b.z as f64)];
    let la = (a[0] * a[0] + a[1] * a[1]).sqrt();
    let lb = (b[0] * b[0] + b[1] * b[1]).sqrt();
    if la < 1e-9 || lb < 1e-9 {
        return None;
    }
    let a = [a[0] / la, a[1] / la];
    let b = [b[0] / lb, b[1] / lb];
    let na = [-a[1], a[0]];
    let nb = [-b[1], b[0]];
    let sa = if na[0] * b[0] + na[1] * b[1] >= 0.0 {
        1.0
    } else {
        -1.0
    };
    let sb = if nb[0] * a[0] + nb[1] * a[1] >= 0.0 {
        1.0
    } else {
        -1.0
    };
    let (hwa, hwb) = (hwa as f64, hwb as f64);
    let c2 = xz(c);
    let off = |p: [f64; 2], n: [f64; 2], s: f64| [p[0] + n[0] * s, p[1] + n[1] * s];
    let inner = line_hit(off(c2, na, sa * hwa), a, off(c2, nb, sb * hwb), b)?;
    let outer = line_hit(off(c2, na, -sa * hwa), a, off(c2, nb, -sb * hwb), b)?;
    let e = [outer[0] - inner[0], outer[1] - inner[1]];
    let le = (e[0] * e[0] + e[1] * e[1]).sqrt();
    if le < 1e-9 {
        return None;
    }
    let e = [e[0] / le, e[1] / le];
    let mut m = [-e[1], e[0]];
    // Point the half-plane into this element's body.
    if m[0] * a[0] + m[1] * a[1] < 0.0 {
        m = [-m[0], -m[1]];
    }
    let r = 1.0e3;
    let keep = polygon_region(&[
        [inner[0] - e[0] * r, inner[1] - e[1] * r],
        [outer[0] + e[0] * r, outer[1] + e[1] * r],
        [
            outer[0] + e[0] * r + m[0] * r,
            outer[1] + e[1] * r + m[1] * r,
        ],
        [
            inner[0] - e[0] * r + m[0] * r,
            inner[1] - e[1] * r + m[1] * r,
        ],
    ]);
    let reach = [inner, outer]
        .iter()
        .map(|p| ((p[0] - c2[0]) * -a[0] + (p[1] - c2[1]) * -a[1]).max(0.0))
        .fold(0.0, f64::max);
    Some(Corner {
        at_start,
        extension: (reach + 0.05).min(20.0 * hwa.max(hwb)) as f32,
        keep,
    })
}

#[cfg(test)]
mod tests {
    use super::super::*;
    use crate::param::{ParamMap, ParamValue};
    use apex_geometry::is_watertight;
    use glam::Vec3;

    fn thick_profile(project: &mut Project) {
        let mut p = project.registry.profile("apex.wall.rect").unwrap().clone();
        p.id = "test.wall.thick".into();
        p.type_values = ParamMap::new().with("thickness", ParamValue::Length(0.4));
        project.register_profile(p).unwrap();
    }

    fn wall(project: &mut Project, a: [f32; 2], b: [f32; 2], thick: bool) -> ElementId {
        let mut params = ParamMap::new();
        if thick {
            params = params.with("profile", ParamValue::ProfileRef("test.wall.thick".into()));
        }
        project
            .create_element(
                "apex.wall",
                Placement::line(Vec3::new(a[0], 0.0, a[1]), Vec3::new(b[0], 0.0, b[1])),
                params,
            )
            .unwrap()
    }

    fn merged(project: &Project, ids: &[ElementId]) -> TriangleMesh {
        let mut out = TriangleMesh::default();
        for id in ids {
            let m = project.document().get_mesh(*id).unwrap();
            let base = (out.positions.len() / 3) as u32;
            out.positions.extend_from_slice(&m.positions);
            out.indices.extend(m.indices.iter().map(|i| i + base));
        }
        out
    }

    /// Axis-aligned wall rectangles as (min x, min z, max x, max z).
    fn inside(rects: &[[f32; 4]], x: f32, z: f32) -> bool {
        rects
            .iter()
            .any(|r| x > r[0] && x < r[2] && z > r[1] && z < r[3])
    }

    /// No side face with solid wall on both sides (a buried join face).
    fn no_buried_faces(mesh: &TriangleMesh, rects: &[[f32; 4]]) -> bool {
        mesh.indices.chunks(3).all(|t| {
            let p = |k: usize| {
                let i = t[k] as usize * 3;
                Vec3::new(
                    mesh.positions[i],
                    mesh.positions[i + 1],
                    mesh.positions[i + 2],
                )
            };
            let n = (p(1) - p(0)).cross(p(2) - p(0));
            if n.length() < 1e-9 || n.normalize().y.abs() > 0.5 {
                return true;
            }
            let n = n.normalize() * 0.01;
            let c = (p(0) + p(1) + p(2)) / 3.0;
            let bad = inside(rects, c.x + n.x, c.z + n.z) && inside(rects, c.x - n.x, c.z - n.z);
            if bad {
                eprintln!("buried {:?} {:?} {:?}", p(0), p(1), p(2));
            }
            !bad
        })
    }

    fn rect(a: [f32; 2], b: [f32; 2], t: f32) -> [f32; 4] {
        // Inflated across the wall only, so free end caps read as outside.
        let h = t / 2.0;
        let (hx, hz) = if a[1] == b[1] { (0.0, h) } else { (h, 0.0) };
        [
            a[0].min(b[0]) - hx,
            a[1].min(b[1]) - hz,
            a[0].max(b[0]) + hx,
            a[1].max(b[1]) + hz,
        ]
    }

    fn check(cases: &[([f32; 2], [f32; 2], bool)]) {
        let mut project = Project::new();
        thick_profile(&mut project);
        let ids: Vec<_> = cases
            .iter()
            .map(|(a, b, t)| wall(&mut project, *a, *b, *t))
            .collect();
        let rects: Vec<_> = cases
            .iter()
            .map(|(a, b, t)| rect(*a, *b, if *t { 0.4 } else { 0.2 }))
            .collect();
        let mesh = merged(&project, &ids);
        if !is_watertight(&mesh) {
            for id in &ids {
                eprintln!(
                    "piece watertight {}",
                    is_watertight(project.document().get_mesh(*id).unwrap())
                );
            }
            let k = |i: u32| {
                let i = i as usize * 3;
                [0, 1, 2].map(|j| (mesh.positions[i + j] * 1e4).round() as i64)
            };
            let mut d = std::collections::HashMap::new();
            for t in mesh.indices.chunks(3) {
                for e in 0..3 {
                    *d.entry((k(t[e]), k(t[(e + 1) % 3]))).or_insert(0) += 1;
                }
            }
            for (&(a, b), &c) in &d {
                if c != 1 || d.get(&(b, a)) != Some(&1) {
                    eprintln!("bad {a:?}->{b:?} x{c}");
                }
            }
        }
        assert!(is_watertight(&mesh), "one closed mass, no overlaps");
        assert!(no_buried_faces(&mesh, &rects), "no faces inside the join");
    }

    #[test]
    fn l_join_is_one_clean_mass() {
        check(&[
            ([0.0, 0.0], [5.0, 0.0], false),
            ([5.0, 0.0], [5.0, 4.0], false),
        ]);
        check(&[
            ([0.0, 0.0], [5.0, 0.0], true),
            ([5.0, 0.0], [5.0, 4.0], false),
        ]);
    }

    #[test]
    fn t_join_is_one_clean_mass() {
        check(&[
            ([0.0, 0.0], [6.0, 0.0], false),
            ([3.0, 0.0], [3.0, 4.0], false),
        ]);
        check(&[
            ([0.0, 0.0], [6.0, 0.0], true),
            ([3.0, 0.0], [3.0, 4.0], false),
        ]);
        check(&[
            ([0.0, 0.0], [6.0, 0.0], false),
            ([3.0, 0.0], [3.0, 4.0], true),
        ]);
    }

    #[test]
    fn x_join_is_one_clean_mass() {
        check(&[
            ([0.0, 0.0], [6.0, 0.0], false),
            ([3.0, -3.0], [3.0, 3.0], false),
        ]);
    }

    #[test]
    fn x_join_plan_edges_have_no_ticks() {
        let mut project = Project::new();
        let cases = [([0.0, 0.0], [6.0, 0.0]), ([3.0, -3.0], [3.0, 3.0])];
        let ids: Vec<_> = cases
            .iter()
            .map(|(a, b)| wall(&mut project, *a, *b, false))
            .collect();
        let rects: Vec<_> = cases.iter().map(|(a, b)| rect(*a, *b, 0.2)).collect();
        for id in ids {
            let m = project.document().get_mesh(id).unwrap();
            for e in m.edges.chunks(6) {
                let (a, b) = (Vec3::new(e[0], e[1], e[2]), Vec3::new(e[3], e[4], e[5]));
                let mid = (a + b) * 0.5;
                if (a.y - b.y).abs() > 1e-4 {
                    continue;
                }
                // A plan edge whose midpoint is buried inside the mass is a tick.
                let d = (b - a).normalize_or_zero();
                let n = Vec3::new(-d.z, 0.0, d.x) * 0.01;
                let buried = inside(&rects, mid.x + n.x, mid.z + n.z)
                    && inside(&rects, mid.x - n.x, mid.z - n.z);
                assert!(!buried, "tick edge {a:?} -> {b:?}");
            }
        }
    }

    #[test]
    fn joins_follow_moves_and_undo() {
        let mut project = Project::new();
        let a = wall(&mut project, [0.0, 0.0], [5.0, 0.0], false);
        let alone = project.document().get_mesh(a).unwrap().clone();
        let b = wall(&mut project, [5.0, 0.0], [5.0, 4.0], false);
        let joined = project.document().get_mesh(a).unwrap().clone();
        assert_ne!(alone.positions, joined.positions, "a re-mitred");
        project
            .update_element(
                b,
                None,
                Some(Placement::line(
                    Vec3::new(9.0, 0.0, 3.0),
                    Vec3::new(9.0, 0.0, 6.0),
                )),
                true,
            )
            .unwrap();
        assert_eq!(
            project.document().get_mesh(a).unwrap().positions,
            alone.positions
        );
        project.undo().unwrap();
        assert!(is_watertight(&merged(&project, &[a, b])));
    }

    #[test]
    fn disallowed_end_does_not_join() {
        let mut project = Project::new();
        let a = project
            .create_element(
                "apex.wall",
                Placement::line(Vec3::ZERO, Vec3::new(5.0, 0.0, 0.0)),
                ParamMap::new().with("allow_join_end", ParamValue::Bool(false)),
            )
            .unwrap();
        let b = wall(&mut project, [5.0, 0.0], [5.0, 4.0], false);
        // A butt end keeps its seam face at the contact.
        let mesh = project.document().get_mesh(a).unwrap();
        let seam = mesh.indices.chunks(3).any(|t| {
            t.iter().all(|&i| {
                let x = mesh.positions[i as usize * 3];
                (4.88..5.02).contains(&x)
            })
        });
        let _ = b;
        assert!(seam, "walls stay separate bodies with a seam");
    }

    #[test]
    fn door_is_a_real_hole_with_reveals() {
        let mut project = Project::new();
        let w = wall(&mut project, [0.0, 0.0], [5.0, 0.0], false);
        let door = project
            .create_element_with_parent(
                "apex.door",
                Placement::point(Vec3::new(2.5, 0.0, 0.0)),
                ParamMap::new()
                    .with("width", ParamValue::Length(1.0))
                    .with("height", ParamValue::Length(2.0)),
                Some(w),
            )
            .unwrap();
        let mesh = project.document().get_mesh(w).unwrap().clone();
        assert!(is_watertight(&mesh), "host stays closed with the hole");
        // Jamb reveals: vertical faces across the wall thickness near x=2.0/3.0.
        let jamb = |x0: f32| {
            mesh.indices.chunks(3).any(|t| {
                t.iter().all(|&i| {
                    let p = &mesh.positions[i as usize * 3..i as usize * 3 + 3];
                    (p[0] - x0).abs() < 0.05 && p[1] < 2.2
                })
            })
        };
        assert!(jamb(2.0) && jamb(3.0), "jamb reveal faces");
        // Moving the door moves the hole.
        project
            .update_element(
                door,
                None,
                Some(Placement::point(Vec3::new(1.0, 0.0, 0.0))),
                true,
            )
            .unwrap();
        let moved = project.document().get_mesh(w).unwrap();
        assert!(is_watertight(moved));
        assert_ne!(moved.positions, mesh.positions);
    }
}
