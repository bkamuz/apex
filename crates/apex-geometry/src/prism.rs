//! Extrusion-aware solid booleans.
//!
//! Every architectural host Apex builds today — straight and polyline walls,
//! beams, slabs, and the voids cut into them (doors, windows, slab and stair
//! openings) — is a *vertical prism*: a plan region swept between two
//! elevations. A [`LayeredSolid`] is a stack of such prisms: sorted elevations
//! and one plan [`Region`] per band between consecutive elevations. That class
//! is closed under union, subtraction and intersection, so booleans reduce to
//! exact 2D polygon booleans per band (via `i_overlay`), and the result is
//! meshed watertight: side walls per band, horizontal caps only where adjacent
//! bands differ (the XOR), and every ring edge subdivided at every vertex of
//! its level so no T-junctions are left.
//!
//! Plan coordinates are `[x, z]`, elevations are world `y`.

use i_overlay::core::fill_rule::FillRule;
use i_overlay::core::overlay_rule::OverlayRule;
use i_overlay::float::single::SingleFloatOverlay;
use spade::{ConstrainedDelaunayTriangulation, Triangulation};

use crate::mesh::TriangleMesh;

/// A closed plan loop `[x, z]`, without the repeated first point.
pub type Ring = Vec<[f64; 2]>;
/// A plan region: shapes, each an outer ring (CCW) followed by holes (CW).
pub type Region = Vec<Vec<Ring>>;

/// Grid every coordinate snaps to (metres). Keeps results of separate
/// overlays welding exactly.
const GRID: f64 = 1e-5;
/// Point-on-segment tolerance for edge subdivision.
const ON_EDGE: f64 = 3e-5;
/// Bands closer than this in elevation are merged.
const LEVEL_EPS: f64 = 1e-6;
/// Regions differing by less than this area are equal.
const AREA_EPS: f64 = 1e-9;

/// Boolean operation selector.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BooleanOp {
    Union,
    Subtract,
    Intersect,
}

fn snap(v: f64) -> f64 {
    (v / GRID).round() * GRID
}

fn ring_area(ring: &[[f64; 2]]) -> f64 {
    let n = ring.len();
    let mut s = 0.0;
    for i in 0..n {
        let a = ring[i];
        let b = ring[(i + 1) % n];
        s += a[0] * b[1] - b[0] * a[1];
    }
    s * 0.5
}

/// Signed area of a region (holes subtract).
pub fn region_area(region: &Region) -> f64 {
    region
        .iter()
        .flat_map(|shape| shape.iter())
        .map(|ring| ring_area(ring))
        .sum()
}

fn clean_ring(ring: &[[f64; 2]], outer: bool) -> Option<Ring> {
    let mut out: Ring = Vec::with_capacity(ring.len());
    for p in ring {
        let q = [snap(p[0]), snap(p[1])];
        if out.last() != Some(&q) {
            out.push(q);
        }
    }
    while out.len() > 1 && out.first() == out.last() {
        out.pop();
    }
    if out.len() < 3 {
        return None;
    }
    let area = ring_area(&out);
    if area.abs() < AREA_EPS {
        return None;
    }
    if (area > 0.0) != outer {
        out.reverse();
    }
    Some(out)
}

/// Snap, orient (outer CCW, holes CW) and drop degenerate rings.
pub fn clean_region(shapes: Vec<Vec<Vec<[f64; 2]>>>) -> Region {
    let mut out = Region::new();
    for shape in shapes {
        let mut rings = shape.into_iter();
        let Some(outer) = rings.next().and_then(|r| clean_ring(&r, true)) else {
            continue;
        };
        let mut cleaned = vec![outer];
        cleaned.extend(rings.filter_map(|r| clean_ring(&r, false)));
        out.push(cleaned);
    }
    out
}

fn region_op(a: &Region, b: &Region, op: OverlayRule) -> Region {
    let a_empty = a.is_empty();
    let b_empty = b.is_empty();
    match op {
        OverlayRule::Union | OverlayRule::Xor if a_empty => return b.clone(),
        OverlayRule::Union | OverlayRule::Xor | OverlayRule::Difference if b_empty => {
            return a.clone()
        }
        OverlayRule::Intersect | OverlayRule::Difference if a_empty => return Region::new(),
        OverlayRule::Intersect if b_empty => return Region::new(),
        _ => {}
    }
    clean_region(a.overlay(b, op, FillRule::NonZero))
}

/// Plan union of two regions.
pub fn region_union(a: &Region, b: &Region) -> Region {
    region_op(a, b, OverlayRule::Union)
}

/// Plan difference `a − b`.
pub fn region_subtract(a: &Region, b: &Region) -> Region {
    region_op(a, b, OverlayRule::Difference)
}

/// Plan intersection.
pub fn region_intersect(a: &Region, b: &Region) -> Region {
    region_op(a, b, OverlayRule::Intersect)
}

/// A region from one simple polygon (any orientation).
pub fn polygon_region(points: &[[f64; 2]]) -> Region {
    clean_region(vec![vec![points.to_vec()]])
}

fn regions_equal(a: &Region, b: &Region) -> bool {
    if a.is_empty() && b.is_empty() {
        return true;
    }
    let x = region_op(a, b, OverlayRule::Xor);
    region_area(&x).abs() < 1e-8 && x.iter().all(|s| ring_area(&s[0]).abs() < 1e-8)
}

fn point_in_ring(ring: &[[f64; 2]], p: [f64; 2]) -> bool {
    let mut inside = false;
    let n = ring.len();
    let mut j = n - 1;
    for i in 0..n {
        let (a, b) = (ring[i], ring[j]);
        if (a[1] > p[1]) != (b[1] > p[1]) {
            let x = a[0] + (p[1] - a[1]) / (b[1] - a[1]) * (b[0] - a[0]);
            if p[0] < x {
                inside = !inside;
            }
        }
        j = i;
    }
    inside
}

/// Strict point-in-region test (even-odd over all rings).
pub fn point_in_region(region: &Region, p: [f64; 2]) -> bool {
    region
        .iter()
        .flat_map(|s| s.iter())
        .filter(|ring| point_in_ring(ring, p))
        .count()
        % 2
        == 1
}

/// A stack of vertical prisms: `bands[i]` spans `levels[i]..levels[i + 1]`.
#[derive(Debug, Clone, Default)]
pub struct LayeredSolid {
    levels: Vec<f64>,
    bands: Vec<Region>,
}

impl LayeredSolid {
    pub fn empty() -> Self {
        Self::default()
    }

    /// `region` extruded from `y0` to `y1`.
    pub fn prism(region: Region, y0: f64, y1: f64) -> Self {
        let (lo, hi) = if y0 <= y1 { (y0, y1) } else { (y1, y0) };
        if hi - lo < LEVEL_EPS || region.is_empty() {
            return Self::empty();
        }
        Self {
            levels: vec![lo, hi],
            bands: vec![region],
        }
    }

    /// A simple polygon extruded from `y0` to `y1`.
    pub fn polygon_prism(points: &[[f64; 2]], y0: f64, y1: f64) -> Self {
        Self::prism(polygon_region(points), y0, y1)
    }

    pub fn is_empty(&self) -> bool {
        self.bands.iter().all(|b| b.is_empty())
    }

    pub fn levels(&self) -> &[f64] {
        &self.levels
    }

    pub fn bands(&self) -> &[Region] {
        &self.bands
    }

    /// Elevation range, or `None` when empty.
    pub fn y_range(&self) -> Option<(f64, f64)> {
        if self.is_empty() {
            return None;
        }
        Some((self.levels[0], *self.levels.last().unwrap()))
    }

    /// Region of the band strictly containing `y`.
    pub fn region_at(&self, y: f64) -> Option<&Region> {
        if self.levels.len() < 2 {
            return None;
        }
        let k = self.levels.windows(2).position(|w| y > w[0] && y < w[1])?;
        Some(&self.bands[k])
    }

    /// Plan union of every band.
    pub fn footprint(&self) -> Region {
        self.bands
            .iter()
            .fold(Region::new(), |acc, b| region_union(&acc, b))
    }

    /// Strict containment of a world point `[x, y, z]`.
    pub fn contains(&self, p: [f64; 3]) -> bool {
        self.region_at(p[1])
            .is_some_and(|r| point_in_region(r, [p[0], p[2]]))
    }

    pub fn volume(&self) -> f64 {
        self.bands
            .iter()
            .enumerate()
            .map(|(i, b)| region_area(b) * (self.levels[i + 1] - self.levels[i]))
            .sum()
    }

    pub fn union(&self, other: &Self) -> Self {
        self.boolean(other, BooleanOp::Union)
    }

    pub fn subtract(&self, other: &Self) -> Self {
        self.boolean(other, BooleanOp::Subtract)
    }

    pub fn intersect(&self, other: &Self) -> Self {
        self.boolean(other, BooleanOp::Intersect)
    }

    /// Exact boolean of two layered solids.
    pub fn boolean(&self, other: &Self, op: BooleanOp) -> Self {
        let mut levels: Vec<f64> = self.levels.iter().chain(&other.levels).copied().collect();
        levels.sort_by(|a, b| a.partial_cmp(b).unwrap());
        levels.dedup_by(|a, b| (*a - *b).abs() < LEVEL_EPS);
        if levels.len() < 2 {
            return Self::empty();
        }
        let rule = match op {
            BooleanOp::Union => OverlayRule::Union,
            BooleanOp::Subtract => OverlayRule::Difference,
            BooleanOp::Intersect => OverlayRule::Intersect,
        };
        let empty = Region::new();
        let bands = levels
            .windows(2)
            .map(|w| {
                let mid = 0.5 * (w[0] + w[1]);
                let a = self.region_at(mid).unwrap_or(&empty);
                let b = other.region_at(mid).unwrap_or(&empty);
                region_op(a, b, rule)
            })
            .collect();
        let mut out = Self { levels, bands };
        out.normalize();
        out
    }

    /// Union of many solids.
    pub fn union_all<'a>(solids: impl IntoIterator<Item = &'a LayeredSolid>) -> Self {
        solids
            .into_iter()
            .fold(Self::empty(), |acc, s| acc.union(s))
    }

    fn normalize(&mut self) {
        // Merge equal neighbours.
        let mut levels = vec![self.levels[0]];
        let mut bands: Vec<Region> = Vec::new();
        for (i, band) in self.bands.iter().enumerate() {
            if let Some(last) = bands.last() {
                if regions_equal(last, band) {
                    *levels.last_mut().unwrap() = self.levels[i + 1];
                    continue;
                }
            }
            bands.push(band.clone());
            levels.push(self.levels[i + 1]);
        }
        // Strip empty bands at both ends.
        while bands.first().is_some_and(|b| b.is_empty()) {
            bands.remove(0);
            levels.remove(0);
        }
        while bands.last().is_some_and(|b| b.is_empty()) {
            bands.pop();
            levels.pop();
        }
        if bands.is_empty() {
            levels.clear();
        }
        self.levels = levels;
        self.bands = bands;
    }

    /// Recover a layered solid from a mesh that is one vertical prism (every
    /// face horizontal or vertical, every vertex on the bottom or top plane).
    /// The plan region is the union of the top-facing triangles.
    pub fn from_vertical_prism_mesh(mesh: &TriangleMesh) -> Option<Self> {
        if mesh.indices.is_empty() {
            return None;
        }
        let p = |i: u32| {
            let i = i as usize * 3;
            [
                mesh.positions[i] as f64,
                mesh.positions[i + 1] as f64,
                mesh.positions[i + 2] as f64,
            ]
        };
        let (mut y0, mut y1) = (f64::MAX, f64::MIN);
        for v in mesh.positions.chunks(3) {
            y0 = y0.min(v[1] as f64);
            y1 = y1.max(v[1] as f64);
        }
        if y1 - y0 < 1e-4 {
            return None;
        }
        let tol = 1e-4;
        let mut top: Vec<Vec<[f64; 2]>> = Vec::new();
        for tri in mesh.indices.chunks(3) {
            let [a, b, c] = [p(tri[0]), p(tri[1]), p(tri[2])];
            for v in [a, b, c] {
                if (v[1] - y0).abs() > tol && (v[1] - y1).abs() > tol {
                    return None;
                }
            }
            let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
            let w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
            let n = [
                u[1] * w[2] - u[2] * w[1],
                u[2] * w[0] - u[0] * w[2],
                u[0] * w[1] - u[1] * w[0],
            ];
            let len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
            if len < 1e-12 {
                continue;
            }
            let ny = n[1] / len;
            if ny.abs() > 1e-3 && ny.abs() < 0.999 {
                return None;
            }
            if ny.abs() >= 0.999 && (a[1] - y1).abs() < tol {
                let mut t = vec![[a[0], a[2]], [b[0], b[2]], [c[0], c[2]]];
                if ring_area(&t) < 0.0 {
                    t.reverse();
                }
                top.push(t);
            }
        }
        if top.is_empty() {
            return None;
        }
        let empty: Vec<Vec<[f64; 2]>> = Vec::new();
        let region = clean_region(top.overlay(&empty, OverlayRule::Union, FillRule::NonZero));
        if region.is_empty() {
            return None;
        }
        Some(Self::prism(region, y0, y1))
    }

    /// Watertight triangle mesh with feature edges.
    pub fn to_mesh(&self) -> TriangleMesh {
        self.mesh_impl(None)
    }

    /// Mesh of `self` as one piece of a larger `whole` (e.g. a wall inside its
    /// joined cluster): faces buried inside `whole` are skipped and feature
    /// edges come from `whole`, so neighbouring pieces read as one mass with
    /// no internal lines and no coincident faces.
    pub fn to_mesh_within(&self, whole: &LayeredSolid) -> TriangleMesh {
        self.mesh_impl(Some(whole))
    }

    fn mesh_impl(&self, whole: Option<&LayeredSolid>) -> TriangleMesh {
        let mut mesh = TriangleMesh::default();
        if self.is_empty() {
            return mesh;
        }
        // A piece is split at every level and contour vertex of the whole so
        // buried and exposed parts of one face are kept or dropped separately.
        let rebanded;
        let this = match whole {
            Some(w) => {
                rebanded = self.rebanded(w.levels());
                &rebanded
            }
            None => self,
        };
        let n = this.levels.len();
        let empty = Region::new();
        // Caps and the vertex set of every level.
        let mut caps: Vec<(Region, Region)> = Vec::with_capacity(n);
        let mut level_points: Vec<Vec<[f64; 2]>> = Vec::with_capacity(n);
        for k in 0..n {
            let below = if k > 0 { &this.bands[k - 1] } else { &empty };
            let above = if k + 1 < n { &this.bands[k] } else { &empty };
            let up = region_subtract(below, above);
            let down = region_subtract(above, below);
            let mut pts: Vec<[f64; 2]> = Vec::new();
            for r in [below, above, &up, &down] {
                for ring in r.iter().flat_map(|s| s.iter()) {
                    pts.extend_from_slice(ring);
                }
            }
            if let Some(w) = whole {
                let y = this.levels[k];
                for yy in [y - 1e-4, y + 1e-4] {
                    if let Some(r) = w.region_at(yy) {
                        for ring in r.iter().flat_map(|s| s.iter()) {
                            pts.extend_from_slice(ring);
                        }
                    }
                }
            }
            pts.sort_by(|a, b| a.partial_cmp(b).unwrap());
            pts.dedup();
            caps.push((up, down));
            level_points.push(pts);
        }

        // Within a cluster, side strips split at breakpoints from either
        // neighbouring level and those splits run on up through every band
        // the edge spans. Give every level the same breakpoint set so caps
        // and side strips share vertices (no T-junction left open).
        if whole.is_some() {
            let mut all: Vec<[f64; 2]> = level_points.iter().flatten().copied().collect();
            all.sort_by(|a, b| a.partial_cmp(b).unwrap());
            all.dedup();
            for pts in &mut level_points {
                pts.clone_from(&all);
            }
        }

        let keep = |centroid: [f64; 3], normal: [f64; 3]| -> bool {
            let Some(whole) = whole else {
                return true;
            };
            let probe = [
                centroid[0] + normal[0] * 1e-4,
                centroid[1] + normal[1] * 1e-4,
                centroid[2] + normal[2] * 1e-4,
            ];
            !whole.contains(probe)
        };

        // Side walls.
        for k in 0..n - 1 {
            let (yb, yt) = (this.levels[k], this.levels[k + 1]);
            for ring in this.bands[k].iter().flat_map(|s| s.iter()) {
                let m = ring.len();
                for i in 0..m {
                    let (p, q) = (ring[i], ring[(i + 1) % m]);
                    let d = [q[0] - p[0], q[1] - p[1]];
                    let len = (d[0] * d[0] + d[1] * d[1]).sqrt();
                    if len < 1e-9 {
                        continue;
                    }
                    let normal = [d[1] / len, 0.0, -d[0] / len];
                    let bottom = points_on_segment(&level_points[k], p, q);
                    let top = points_on_segment(&level_points[k + 1], p, q);
                    // Split at every breakpoint of either chain.
                    let mut cuts: Vec<f64> =
                        bottom.iter().chain(top.iter()).map(|(t, _)| *t).collect();
                    if whole.is_none() {
                        cuts = vec![0.0, 1.0];
                    }
                    cuts.sort_by(|a, b| a.partial_cmp(b).unwrap());
                    cuts.dedup_by(|a, b| (*a - *b).abs() < 1e-12);
                    for w in cuts.windows(2) {
                        let (ta, tb) = (w[0], w[1]);
                        let tm = 0.5 * (ta + tb);
                        let mid = [p[0] + d[0] * tm, 0.5 * (yb + yt), p[1] + d[1] * tm];
                        if !keep(mid, normal) {
                            continue;
                        }
                        // Each chain clipped to [ta, tb]; a breakpoint that only
                        // the other chain carries gets an interpolated point so
                        // both sides of the strip always reach its ends.
                        let at = |t: f64| (t, [p[0] + d[0] * t, p[1] + d[1] * t]);
                        let within = |c: &[(f64, [f64; 2])]| -> Vec<(f64, [f64; 2])> {
                            let mut v: Vec<(f64, [f64; 2])> = c
                                .iter()
                                .filter(|(t, _)| *t > ta + 1e-12 && *t < tb - 1e-12)
                                .copied()
                                .collect();
                            let end = |t: f64| {
                                c.iter()
                                    .copied()
                                    .find(|(u, _)| (u - t).abs() <= 1e-12)
                                    .unwrap_or(at(t))
                            };
                            v.insert(0, end(ta));
                            v.push(end(tb));
                            v
                        };
                        let (bs, ts) = (within(&bottom), within(&top));
                        zipper(&mut mesh, &bs, yb, &ts, yt, normal);
                    }
                }
            }
        }

        // Caps.
        for (k, (up, down)) in caps.iter().enumerate() {
            let y = this.levels[k];
            for (region, ny) in [(up, 1.0), (down, -1.0)] {
                for shape in region {
                    let rings: Vec<Ring> = shape
                        .iter()
                        .map(|ring| subdivide_ring(ring, &level_points[k]))
                        .collect();
                    for [a, b, c] in triangulate_shape(&rings) {
                        let centroid = [(a[0] + b[0] + c[0]) / 3.0, y, (a[1] + b[1] + c[1]) / 3.0];
                        if !keep(centroid, [0.0, ny, 0.0]) {
                            continue;
                        }
                        push_oriented(
                            &mut mesh,
                            [a[0], y, a[1]],
                            [b[0], y, b[1]],
                            [c[0], y, c[1]],
                            [0.0, ny, 0.0],
                        );
                    }
                }
            }
        }

        // Feature edges.
        match whole {
            None => self.push_feature_edges(&mut mesh, &caps, None),
            Some(whole) => {
                let mut whole_caps = Vec::new();
                for k in 0..whole.levels.len() {
                    let below = if k > 0 { &whole.bands[k - 1] } else { &empty };
                    let above = if k + 1 < whole.levels.len() {
                        &whole.bands[k]
                    } else {
                        &empty
                    };
                    whole_caps.push((region_subtract(below, above), region_subtract(above, below)));
                }
                whole.push_feature_edges(&mut mesh, &whole_caps, Some(self));
            }
        }
        mesh
    }

    /// Same solid with extra (redundant) level breaks, without merging.
    fn rebanded(&self, extra: &[f64]) -> Self {
        let mut levels: Vec<f64> = self
            .levels
            .iter()
            .copied()
            .chain(extra.iter().copied().filter(|y| {
                self.y_range()
                    .is_some_and(|(a, b)| *y > a + LEVEL_EPS && *y < b - LEVEL_EPS)
            }))
            .collect();
        levels.sort_by(|a, b| a.partial_cmp(b).unwrap());
        levels.dedup_by(|a, b| (*a - *b).abs() < LEVEL_EPS);
        let empty = Region::new();
        let bands = levels
            .windows(2)
            .map(|w| {
                self.region_at(0.5 * (w[0] + w[1]))
                    .unwrap_or(&empty)
                    .clone()
            })
            .collect();
        Self { levels, bands }
    }

    /// Crease lines: cap outlines at each level and vertical corners per band.
    /// With `near`, only edges touching that solid are kept.
    fn push_feature_edges(
        &self,
        mesh: &mut TriangleMesh,
        caps: &[(Region, Region)],
        near: Option<&LayeredSolid>,
    ) {
        let touches = |m: [f64; 3]| -> bool {
            let Some(s) = near else {
                return true;
            };
            let r = 3e-4;
            for dy in [-r, r] {
                for (dx, dz) in [
                    (r, 0.0),
                    (-r, 0.0),
                    (0.0, r),
                    (0.0, -r),
                    (r, r),
                    (-r, -r),
                    (r, -r),
                    (-r, r),
                ] {
                    if s.contains([m[0] + dx, m[1] + dy, m[2] + dz]) {
                        return true;
                    }
                }
            }
            false
        };
        for (k, (up, down)) in caps.iter().enumerate() {
            let y = self.levels[k];
            // A boundary shared by the up and down caps is one crease.
            let mut seen: Vec<([i64; 2], [i64; 2])> = Vec::new();
            for region in [up, down] {
                for ring in region.iter().flat_map(|s| s.iter()) {
                    let m = ring.len();
                    for i in 0..m {
                        let (p, q) = (ring[i], ring[(i + 1) % m]);
                        let key = edge_key(p, q);
                        if seen.contains(&key) {
                            continue;
                        }
                        seen.push(key);
                        let mid = [0.5 * (p[0] + q[0]), y, 0.5 * (p[1] + q[1])];
                        if touches(mid) {
                            mesh.push_edge(
                                [p[0] as f32, y as f32, p[1] as f32],
                                [q[0] as f32, y as f32, q[1] as f32],
                            );
                        }
                    }
                }
            }
        }
        for k in 0..self.bands.len() {
            let (yb, yt) = (self.levels[k], self.levels[k + 1]);
            for ring in self.bands[k].iter().flat_map(|s| s.iter()) {
                let m = ring.len();
                for i in 0..m {
                    let (u, v, w) = (ring[(i + m - 1) % m], ring[i], ring[(i + 1) % m]);
                    let a = [v[0] - u[0], v[1] - u[1]];
                    let b = [w[0] - v[0], w[1] - v[1]];
                    let la = (a[0] * a[0] + a[1] * a[1]).sqrt();
                    let lb = (b[0] * b[0] + b[1] * b[1]).sqrt();
                    if la < 1e-9 || lb < 1e-9 {
                        continue;
                    }
                    let cross = (a[0] * b[1] - a[1] * b[0]) / (la * lb);
                    if cross.abs() < 1e-3 {
                        continue;
                    }
                    let mid = [v[0], 0.5 * (yb + yt), v[1]];
                    if touches(mid) {
                        mesh.push_edge(
                            [v[0] as f32, yb as f32, v[1] as f32],
                            [v[0] as f32, yt as f32, v[1] as f32],
                        );
                    }
                }
            }
        }
    }
}

fn edge_key(p: [f64; 2], q: [f64; 2]) -> ([i64; 2], [i64; 2]) {
    let k = |v: [f64; 2]| [(v[0] / GRID).round() as i64, (v[1] / GRID).round() as i64];
    let (a, b) = (k(p), k(q));
    if a <= b {
        (a, b)
    } else {
        (b, a)
    }
}

/// Points of `pool` on segment `p→q` (endpoints included), sorted along it.
fn points_on_segment(pool: &[[f64; 2]], p: [f64; 2], q: [f64; 2]) -> Vec<(f64, [f64; 2])> {
    let d = [q[0] - p[0], q[1] - p[1]];
    let len2 = d[0] * d[0] + d[1] * d[1];
    let len = len2.sqrt();
    let mut out = vec![(0.0, p), (1.0, q)];
    for &v in pool {
        if v == p || v == q {
            continue;
        }
        let w = [v[0] - p[0], v[1] - p[1]];
        let t = (w[0] * d[0] + w[1] * d[1]) / len2;
        if t * len <= ON_EDGE || (1.0 - t) * len <= ON_EDGE {
            continue;
        }
        let dist = (w[0] * d[1] - w[1] * d[0]).abs() / len;
        if dist <= ON_EDGE {
            out.push((t, v));
        }
    }
    out.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
    out
}

fn subdivide_ring(ring: &[[f64; 2]], pool: &[[f64; 2]]) -> Ring {
    let m = ring.len();
    let mut out = Ring::new();
    for i in 0..m {
        let seg = points_on_segment(pool, ring[i], ring[(i + 1) % m]);
        out.extend(seg[..seg.len() - 1].iter().map(|(_, v)| *v));
    }
    out
}

fn push_oriented(mesh: &mut TriangleMesh, a: [f64; 3], b: [f64; 3], c: [f64; 3], n: [f64; 3]) {
    let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    let w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let cr = [
        u[1] * w[2] - u[2] * w[1],
        u[2] * w[0] - u[0] * w[2],
        u[0] * w[1] - u[1] * w[0],
    ];
    let dot = cr[0] * n[0] + cr[1] * n[1] + cr[2] * n[2];
    let f = |v: [f64; 3]| [v[0] as f32, v[1] as f32, v[2] as f32];
    let nf = f(n);
    if dot >= 0.0 {
        mesh.push_triangle(f(a), f(b), f(c), nf);
    } else {
        mesh.push_triangle(f(a), f(c), f(b), nf);
    }
}

/// Triangulate the vertical strip between two subdivided copies of one edge.
fn zipper(
    mesh: &mut TriangleMesh,
    bottom: &[(f64, [f64; 2])],
    yb: f64,
    top: &[(f64, [f64; 2])],
    yt: f64,
    normal: [f64; 3],
) {
    let b = |i: usize| [bottom[i].1[0], yb, bottom[i].1[1]];
    let t = |j: usize| [top[j].1[0], yt, top[j].1[1]];
    let (mut i, mut j) = (0usize, 0usize);
    let (m, n) = (bottom.len() - 1, top.len() - 1);
    while i < m || j < n {
        let advance_bottom = i < m && (j == n || bottom[i + 1].0 <= top[j + 1].0);
        if advance_bottom {
            push_oriented(mesh, b(i), b(i + 1), t(j), normal);
            i += 1;
        } else {
            push_oriented(mesh, b(i), t(j + 1), t(j), normal);
            j += 1;
        }
    }
}

/// Constrained Delaunay triangulation of one shape (outer + holes).
fn triangulate_shape(rings: &[Ring]) -> Vec<[[f64; 2]; 3]> {
    let mut points: Vec<[f64; 2]> = Vec::new();
    let mut index_of = std::collections::HashMap::<[i64; 2], usize>::new();
    let mut constraints = Vec::new();
    for ring in rings {
        let ids: Vec<usize> = ring
            .iter()
            .map(|v| {
                let key = [(v[0] / GRID).round() as i64, (v[1] / GRID).round() as i64];
                *index_of.entry(key).or_insert_with(|| {
                    points.push(*v);
                    points.len() - 1
                })
            })
            .collect();
        for i in 0..ids.len() {
            let (a, b) = (ids[i], ids[(i + 1) % ids.len()]);
            if a != b {
                constraints.push([a, b]);
            }
        }
    }
    let spade_points: Vec<spade::Point2<f64>> = points
        .iter()
        .map(|p| spade::Point2::new(p[0], p[1]))
        .collect();
    let cdt = match ConstrainedDelaunayTriangulation::<spade::Point2<f64>>::bulk_load_cdt(
        spade_points,
        constraints,
    ) {
        Ok(cdt) => cdt,
        Err(_) => return Vec::new(),
    };
    let mut out = Vec::new();
    for face in cdt.inner_faces() {
        let v = face.vertices();
        let tri = [v[0], v[1], v[2]].map(|h| {
            let p = h.position();
            [p.x, p.y]
        });
        let c = [
            (tri[0][0] + tri[1][0] + tri[2][0]) / 3.0,
            (tri[0][1] + tri[1][1] + tri[2][1]) / 3.0,
        ];
        let inside = rings.iter().filter(|r| point_in_ring(r, c)).count() % 2 == 1;
        if inside {
            out.push(tri);
        }
    }
    out
}

/// Every undirected edge used by exactly two triangles, in opposite
/// directions, after welding coincident vertices: a closed, consistently
/// oriented 2-manifold surface.
pub fn is_watertight(mesh: &TriangleMesh) -> bool {
    use std::collections::HashMap;
    let key = |i: u32| {
        let i = i as usize * 3;
        [
            (mesh.positions[i] as f64 * 1e4).round() as i64,
            (mesh.positions[i + 1] as f64 * 1e4).round() as i64,
            (mesh.positions[i + 2] as f64 * 1e4).round() as i64,
        ]
    };
    let mut directed: HashMap<([i64; 3], [i64; 3]), i32> = HashMap::new();
    for tri in mesh.indices.chunks(3) {
        let v = [key(tri[0]), key(tri[1]), key(tri[2])];
        if v[0] == v[1] || v[1] == v[2] || v[0] == v[2] {
            continue;
        }
        for e in 0..3 {
            *directed.entry((v[e], v[(e + 1) % 3])).or_insert(0) += 1;
        }
    }
    !directed.is_empty()
        && directed
            .iter()
            .all(|(&(a, b), &count)| count == 1 && directed.get(&(b, a)) == Some(&1))
}

/// True when the surface has no boundary: every edge is cancelled by an
/// opposite edge once T-junctions are split (a vertex of one face lying on an
/// edge of its neighbour). Unlike [`is_watertight`] this accepts conforming
/// joins (wall T-junctions) and solids built from several closed shells that
/// share faces (window frames, stair steps). The enclosed volume is well
/// defined either way.
pub fn is_closed(mesh: &TriangleMesh) -> bool {
    use std::collections::HashMap;
    const SCALE: f64 = 1e4;
    let mut ids: HashMap<[i64; 3], usize> = HashMap::new();
    let mut verts: Vec<[f64; 3]> = Vec::new();
    let mut weld = |i: u32| {
        let i = i as usize * 3;
        let p = [
            mesh.positions[i] as f64,
            mesh.positions[i + 1] as f64,
            mesh.positions[i + 2] as f64,
        ];
        let key = p.map(|c| (c * SCALE).round() as i64);
        *ids.entry(key).or_insert_with(|| {
            verts.push(p);
            verts.len() - 1
        })
    };
    let mut edges: Vec<(usize, usize)> = Vec::new();
    for tri in mesh.indices.chunks(3) {
        let v = [weld(tri[0]), weld(tri[1]), weld(tri[2])];
        if v[0] == v[1] || v[1] == v[2] || v[0] == v[2] {
            continue;
        }
        for e in 0..3 {
            edges.push((v[e], v[(e + 1) % 3]));
        }
    }
    if edges.is_empty() {
        return false;
    }
    let tol = 1.5 / SCALE;
    let mut balance: HashMap<(usize, usize), i32> = HashMap::new();
    for &(a, b) in &edges {
        let (pa, pb) = (verts[a], verts[b]);
        let d = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
        let len2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
        // Vertices strictly inside the segment, ordered along it.
        let mut cuts: Vec<(f64, usize)> = vec![(0.0, a), (1.0, b)];
        for (k, p) in verts.iter().enumerate() {
            if k == a || k == b {
                continue;
            }
            let w = [p[0] - pa[0], p[1] - pa[1], p[2] - pa[2]];
            let t = (w[0] * d[0] + w[1] * d[1] + w[2] * d[2]) / len2;
            if t <= 1e-9 || t >= 1.0 - 1e-9 {
                continue;
            }
            let off = [w[0] - t * d[0], w[1] - t * d[1], w[2] - t * d[2]];
            if off[0] * off[0] + off[1] * off[1] + off[2] * off[2] <= tol * tol {
                cuts.push((t, k));
            }
        }
        cuts.sort_by(|x, y| x.0.total_cmp(&y.0));
        for pair in cuts.windows(2) {
            let (u, v) = (pair[0].1, pair[1].1);
            if u == v {
                continue;
            }
            let (key, sign) = if u < v { ((u, v), 1) } else { ((v, u), -1) };
            *balance.entry(key).or_insert(0) += sign;
        }
    }
    balance.values().all(|&n| n == 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn closed_accepts_t_junctions_and_rejects_holes() {
        // Unit cube whose +Z face is split by a vertex on the bottom edge (T-junction).
        let mut m = TriangleMesh::default();
        let p: [[f32; 3]; 9] = [
            [0., 0., 0.],
            [1., 0., 0.],
            [1., 1., 0.],
            [0., 1., 0.],
            [0., 0., 1.],
            [1., 0., 1.],
            [1., 1., 1.],
            [0., 1., 1.],
            [0.5, 0., 1.],
        ];
        for v in p {
            m.positions.extend_from_slice(&v);
        }
        let faces: [[u32; 3]; 13] = [
            [0, 2, 1],
            [0, 3, 2], // -z
            [4, 8, 6],
            [8, 5, 6],
            [4, 6, 7], // +z, split at 8 (T on edge 4-5)
            [0, 1, 5],
            [0, 5, 4], // -y: edge 4-5 is not split here
            [3, 7, 6],
            [3, 6, 2], // +y
            [0, 4, 7],
            [0, 7, 3], // -x
            [1, 2, 6],
            [1, 6, 5], // +x
        ];
        for f in faces {
            m.indices.extend_from_slice(&f);
        }
        assert!(!is_watertight(&m), "strict check sees the T-junction");
        assert!(is_closed(&m));
        m.indices.truncate(m.indices.len() - 3);
        assert!(!is_closed(&m), "a missing triangle is a hole");
    }

    fn rect(x0: f64, z0: f64, x1: f64, z1: f64) -> Vec<[f64; 2]> {
        vec![[x0, z0], [x1, z0], [x1, z1], [x0, z1]]
    }

    fn boxy(x0: f64, z0: f64, x1: f64, z1: f64, y0: f64, y1: f64) -> LayeredSolid {
        LayeredSolid::polygon_prism(&rect(x0, z0, x1, z1), y0, y1)
    }

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-6
    }

    #[test]
    fn wall_minus_window_is_a_watertight_hole_with_reveals() {
        let wall = boxy(0.0, -0.1, 4.0, 0.1, 0.0, 3.0);
        let window = boxy(1.0, -0.6, 2.2, 0.6, 0.9, 2.1);
        let cut = wall.subtract(&window);
        assert!(close(cut.volume(), 4.0 * 0.2 * 3.0 - 1.2 * 0.2 * 1.2));
        assert_eq!(cut.levels(), &[0.0, 0.9, 2.1, 3.0]);
        let mesh = cut.to_mesh();
        assert!(is_watertight(&mesh));
        // Reveal faces: sill (up), head (down), and two jambs.
        let has_face = |n: [f32; 3], at: [f32; 3]| {
            mesh.positions
                .chunks(3)
                .zip(mesh.normals.chunks(3))
                .any(|(p, m)| {
                    (m[0] - n[0]).abs() < 1e-5
                        && (m[1] - n[1]).abs() < 1e-5
                        && (m[2] - n[2]).abs() < 1e-5
                        && (0..3).all(|i| at[i].is_nan() || (p[i] - at[i]).abs() < 1e-4)
                })
        };
        assert!(has_face([0.0, 1.0, 0.0], [f32::NAN, 0.9, f32::NAN]), "sill");
        assert!(
            has_face([0.0, -1.0, 0.0], [f32::NAN, 2.1, f32::NAN]),
            "head"
        );
        assert!(has_face([1.0, 0.0, 0.0], [1.0, f32::NAN, f32::NAN]), "jamb");
        assert!(
            has_face([-1.0, 0.0, 0.0], [2.2, f32::NAN, f32::NAN]),
            "jamb"
        );
    }

    #[test]
    fn door_from_floor_splits_the_footprint() {
        let wall = boxy(0.0, -0.1, 4.0, 0.1, 0.0, 3.0);
        let door = boxy(1.0, -0.6, 1.9, 0.6, -0.02, 2.1);
        let cut = wall.subtract(&door);
        assert_eq!(cut.region_at(1.0).unwrap().len(), 2);
        assert!(is_watertight(&cut.to_mesh()));
    }

    #[test]
    fn l_t_x_unions_are_one_watertight_mass() {
        let a = boxy(0.0, 0.0, 4.0, 0.2, 0.0, 3.0);
        let l = a.union(&boxy(0.0, 0.0, 0.2, 3.0, 0.0, 3.0));
        let t = a.union(&boxy(1.9, 0.2, 2.1, 3.0, 0.0, 3.0));
        let x = a.union(&boxy(1.9, -2.0, 2.1, 3.0, 0.0, 3.0));
        for (solid, vol) in [
            (&l, 4.0 * 0.2 * 3.0 + 0.2 * 2.8 * 3.0),
            (&t, 4.0 * 0.2 * 3.0 + 0.2 * 2.8 * 3.0),
            (&x, 4.0 * 0.2 * 3.0 + 0.2 * 4.8 * 3.0),
        ] {
            assert_eq!(solid.bands().len(), 1);
            assert_eq!(solid.bands()[0].len(), 1, "one merged outline");
            assert!(close(solid.volume(), vol));
            assert!(is_watertight(&solid.to_mesh()));
        }
    }

    #[test]
    fn different_heights_and_thicknesses_union_cleanly() {
        let thick = boxy(0.0, 0.0, 4.0, 0.4, 0.0, 3.0);
        let thin = boxy(1.9, 0.4, 2.0, 3.0, 0.0, 2.5);
        let u = thick.union(&thin);
        assert_eq!(u.levels(), &[0.0, 2.5, 3.0]);
        let mesh = u.to_mesh();
        assert!(is_watertight(&mesh));
        assert!(close(u.volume(), 4.0 * 0.4 * 3.0 + 0.1 * 2.6 * 2.5));
    }

    #[test]
    fn intersect_and_subtract_are_consistent() {
        let a = boxy(0.0, 0.0, 2.0, 2.0, 0.0, 2.0);
        let b = boxy(1.0, 1.0, 3.0, 3.0, 1.0, 3.0);
        let i = a.intersect(&b);
        assert!(close(i.volume(), 1.0));
        assert!(close(a.subtract(&b).volume() + i.volume(), a.volume()));
        assert!(close(
            a.union(&b).volume(),
            a.volume() + b.volume() - i.volume()
        ));
        for s in [i, a.subtract(&b), a.union(&b)] {
            assert!(is_watertight(&s.to_mesh()));
        }
    }

    #[test]
    fn diagonal_opening_through_rotated_wall() {
        let (c, s) = (
            std::f64::consts::FRAC_1_SQRT_2,
            std::f64::consts::FRAC_1_SQRT_2,
        );
        let rot = |pts: Vec<[f64; 2]>| -> Vec<[f64; 2]> {
            pts.into_iter()
                .map(|p| [p[0] * c - p[1] * s + 10.0, p[0] * s + p[1] * c + 1.0])
                .collect()
        };
        let wall = LayeredSolid::polygon_prism(&rot(rect(0.0, -0.1, 3.0, 0.1)), 0.0, 3.0);
        let win = LayeredSolid::polygon_prism(&rot(rect(1.0, -0.6, 2.0, 0.6)), 0.9, 2.1);
        let cut = wall.subtract(&win);
        assert!((cut.volume() - (3.0 * 0.2 * 3.0 - 0.2 * 1.2)).abs() < 1e-3);
        assert!(is_watertight(&cut.to_mesh()));
    }

    #[test]
    fn pieces_within_a_cluster_drop_internal_faces_and_lines() {
        let a = boxy(0.0, 0.0, 4.0, 0.2, 0.0, 3.0);
        let b = boxy(1.9, 0.2, 2.1, 3.0, 0.0, 3.0);
        let whole = a.union(&b);
        let ma = a.to_mesh_within(&whole);
        let mb = b.to_mesh_within(&whole);
        // No face of A lies on the contact line z = 0.2 between x 1.9..2.1.
        let buried = |m: &TriangleMesh| {
            m.indices.chunks(3).any(|t| {
                let c: Vec<f32> = (0..3)
                    .map(|k| {
                        t.iter()
                            .map(|&i| m.positions[i as usize * 3 + k])
                            .sum::<f32>()
                            / 3.0
                    })
                    .collect();
                (c[2] - 0.2).abs() < 1e-4 && c[0] > 1.9 && c[0] < 2.1
            })
        };
        assert!(!buried(&ma) && !buried(&mb));
        // No line along the contact segment either.
        let internal_line = |m: &TriangleMesh| {
            m.edges.chunks(6).any(|e| {
                (e[1] - e[4]).abs() < 1e-6
                    && (e[2] - 0.2).abs() < 1e-4
                    && (e[5] - 0.2).abs() < 1e-4
                    && e[0].min(e[3]) >= 1.9 - 1e-4
                    && e[0].max(e[3]) <= 2.1 + 1e-4
            })
        };
        assert!(!internal_line(&ma) && !internal_line(&mb));
        let mut both = ma.clone();
        both.append(&mb);
        assert!(!both.indices.is_empty());
    }

    #[test]
    fn recovers_prism_from_box_mesh() {
        let mesh = boxy(0.0, 0.0, 1.0, 2.0, 0.5, 1.5).to_mesh();
        let back = LayeredSolid::from_vertical_prism_mesh(&mesh).unwrap();
        assert!(close(back.volume(), 2.0));
        assert_eq!(back.y_range(), Some((0.5, 1.5)));
    }
}

#[cfg(test)]
mod side_strip_tests {
    use super::*;

    fn mesh_area(m: &TriangleMesh) -> f64 {
        let p = |i: u32| {
            let i = i as usize * 3;
            [
                m.positions[i] as f64,
                m.positions[i + 1] as f64,
                m.positions[i + 2] as f64,
            ]
        };
        m.indices
            .chunks(3)
            .map(|t| {
                let (a, b, c) = (p(t[0]), p(t[1]), p(t[2]));
                let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
                let w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
                let n = [
                    u[1] * w[2] - u[2] * w[1],
                    u[2] * w[0] - u[0] * w[2],
                    u[0] * w[1] - u[1] * w[0],
                ];
                0.5 * (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt()
            })
            .sum()
    }

    /// A wall with a window: the band under the sill has no breakpoints on
    /// its bottom chain, only on its top one (the window jambs). Meshing it
    /// inside a cluster must still emit the full face below the sill.
    #[test]
    fn face_below_window_sill_survives_meshing_within_cluster() {
        let wall = LayeredSolid::polygon_prism(
            &[[0.0, -0.1], [8.0, -0.1], [8.0, 0.1], [0.0, 0.1]],
            0.0,
            3.0,
        );
        let window = LayeredSolid::polygon_prism(
            &[[3.4, -0.6], [4.6, -0.6], [4.6, 0.6], [3.4, 0.6]],
            0.88,
            2.32,
        );
        let piece = wall.subtract(&window);
        let alone = mesh_area(&piece.to_mesh());
        let within = mesh_area(&piece.to_mesh_within(&piece));
        assert!(
            (alone - within).abs() < 1e-3,
            "alone {alone} within {within}"
        );
    }
}
