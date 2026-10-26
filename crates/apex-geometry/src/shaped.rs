//! Shaped surfaces (Revit "Modify Sub Elements"): a closed plan boundary
//! whose vertices, extra interior points and crease lines each carry their
//! own height. The top surface is the piecewise-linear surface through those
//! points, triangulated with a constrained Delaunay triangulation in plan
//! (creases are constraint edges, so the surface folds exactly along them).
//!
//! Solids built from a surface have a constant *vertical* thickness: every
//! bottom vertex sits straight below its top vertex. For a surface whose
//! faces all share one slope (a roof) a vertical drop of `t / cos(pitch)`
//! gives a constant thickness `t` normal to every face, and the faces meet
//! at ridges and hips with no gap or overlap.

use std::collections::HashMap;

use spade::{ConstrainedDelaunayTriangulation, Triangulation};

use crate::{GeometryError, TriangleMesh};

/// Points are `[x, y, z]` with `y` up; the surface is a height field over XZ.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ShapedSurface {
    /// Closed boundary (no repeated last point), either winding.
    pub boundary: Vec<[f64; 3]>,
    /// Extra points strictly inside the boundary.
    pub interior: Vec<[f64; 3]>,
    /// Crease lines between two points: indices into `boundary` followed by
    /// `interior` (index `boundary.len() + k` is interior point `k`).
    pub creases: Vec<[usize; 2]>,
}

/// How the underside of a solid is formed.
#[derive(Debug, Clone, Copy)]
pub enum Underside {
    /// Each bottom vertex is this far below its top vertex.
    Drop(f64),
    /// A flat bottom at this height.
    Flat(f64),
}

/// A triangulated surface: points and plan-CCW triangles (normal +Y).
#[derive(Debug, Clone)]
pub struct SurfaceMesh {
    pub points: Vec<[f64; 3]>,
    pub triangles: Vec<[usize; 3]>,
    /// Boundary as indices into `points`, oriented like the triangles.
    pub boundary: Vec<usize>,
}

const GRID: f64 = 1e-6;

fn key(x: f64, z: f64) -> (i64, i64) {
    ((x / GRID).round() as i64, (z / GRID).round() as i64)
}

fn cross2(o: [f64; 2], a: [f64; 2], b: [f64; 2]) -> f64 {
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
}

/// Proper crossing (shared endpoints do not count).
fn segments_cross(a: [f64; 2], b: [f64; 2], c: [f64; 2], d: [f64; 2]) -> bool {
    let eq = |p: [f64; 2], q: [f64; 2]| (p[0] - q[0]).abs() < 1e-9 && (p[1] - q[1]).abs() < 1e-9;
    if eq(a, c) || eq(a, d) || eq(b, c) || eq(b, d) {
        return false;
    }
    let (d1, d2) = (cross2(a, b, c), cross2(a, b, d));
    let (d3, d4) = (cross2(c, d, a), cross2(c, d, b));
    d1 * d2 < 0.0 && d3 * d4 < 0.0
}

pub(crate) fn point_in_polygon(poly: &[[f64; 2]], p: [f64; 2]) -> bool {
    let mut inside = false;
    let n = poly.len();
    for i in 0..n {
        let (a, b) = (poly[i], poly[(i + 1) % n]);
        if (a[1] > p[1]) != (b[1] > p[1]) {
            let x = a[0] + (p[1] - a[1]) / (b[1] - a[1]) * (b[0] - a[0]);
            if p[0] < x {
                inside = !inside;
            }
        }
    }
    inside
}

fn seg_dist(p: [f64; 2], a: [f64; 2], b: [f64; 2]) -> f64 {
    let d = [b[0] - a[0], b[1] - a[1]];
    let l2 = d[0] * d[0] + d[1] * d[1];
    let t = if l2 < 1e-18 {
        0.0
    } else {
        (((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / l2).clamp(0.0, 1.0)
    };
    ((p[0] - a[0] - d[0] * t).powi(2) + (p[1] - a[1] - d[1] * t).powi(2)).sqrt()
}

impl ShapedSurface {
    /// A flat surface at the boundary's own heights.
    pub fn new(boundary: Vec<[f64; 3]>) -> Self {
        Self {
            boundary,
            ..Self::default()
        }
    }

    fn all_points(&self) -> Vec<[f64; 3]> {
        self.boundary
            .iter()
            .chain(self.interior.iter())
            .copied()
            .collect()
    }

    fn plan(&self) -> Vec<[f64; 2]> {
        self.boundary.iter().map(|p| [p[0], p[2]]).collect()
    }

    /// Interior points that can be used (inside, off the boundary).
    pub fn usable_interior(&self, k: usize) -> bool {
        let poly = self.plan();
        let Some(p) = self.interior.get(k) else {
            return false;
        };
        let q = [p[0], p[2]];
        point_in_polygon(&poly, q)
            && (0..poly.len()).all(|i| seg_dist(q, poly[i], poly[(i + 1) % poly.len()]) > 1e-4)
    }

    /// Creases that can be honoured: valid indices, distinct ends, inside
    /// the boundary, and not crossing the boundary or an earlier crease.
    pub fn usable_creases(&self) -> Vec<[usize; 2]> {
        let pts = self.all_points();
        let nb = self.boundary.len();
        let poly = self.plan();
        let p2 = |i: usize| [pts[i][0], pts[i][2]];
        let ok_point = |i: usize| i < nb || (i < pts.len() && self.usable_interior(i - nb));
        let mut out: Vec<[usize; 2]> = Vec::new();
        for &[a, b] in &self.creases {
            if a == b || !ok_point(a) || !ok_point(b) {
                continue;
            }
            let (pa, pb) = (p2(a), p2(b));
            if (pa[0] - pb[0]).abs() < 1e-9 && (pa[1] - pb[1]).abs() < 1e-9 {
                continue;
            }
            let mid = [(pa[0] + pb[0]) * 0.5, (pa[1] + pb[1]) * 0.5];
            if !point_in_polygon(&poly, mid) {
                continue;
            }
            let crosses_boundary =
                (0..nb).any(|i| segments_cross(pa, pb, poly[i], poly[(i + 1) % nb]));
            let crosses_crease = out
                .iter()
                .any(|&[c, d]| segments_cross(pa, pb, p2(c), p2(d)));
            if !crosses_boundary
                && !crosses_crease
                && !out.contains(&[a, b])
                && !out.contains(&[b, a])
            {
                out.push([a, b]);
            }
        }
        out
    }

    /// Triangulate the surface in plan.
    pub fn triangulate(&self) -> Result<SurfaceMesh, GeometryError> {
        let nb = self.boundary.len();
        if nb < 3 {
            return Err(GeometryError::Surface(
                "shaped surface needs at least three boundary points".into(),
            ));
        }
        let src = self.all_points();
        let mut points: Vec<[f64; 3]> = Vec::new();
        let mut index_of: HashMap<(i64, i64), usize> = HashMap::new();
        let mut remap = vec![usize::MAX; src.len()];
        for (i, p) in src.iter().enumerate() {
            if i >= nb && !self.usable_interior(i - nb) {
                continue;
            }
            let id = *index_of.entry(key(p[0], p[2])).or_insert_with(|| {
                points.push(*p);
                points.len() - 1
            });
            remap[i] = id;
        }
        let mut boundary: Vec<usize> = Vec::new();
        for &id in &remap[..nb] {
            if boundary.last() != Some(&id) {
                boundary.push(id);
            }
        }
        if boundary.len() > 1 && boundary.first() == boundary.last() {
            boundary.pop();
        }
        if boundary.len() < 3 {
            return Err(GeometryError::Surface("degenerate boundary".into()));
        }
        let mut constraints: Vec<[usize; 2]> = (0..boundary.len())
            .map(|i| [boundary[i], boundary[(i + 1) % boundary.len()]])
            .collect();
        for [a, b] in self.usable_creases() {
            let (a, b) = (remap[a], remap[b]);
            if a != b && a != usize::MAX && b != usize::MAX {
                constraints.push([a, b]);
            }
        }
        let cdt = ConstrainedDelaunayTriangulation::<spade::Point2<f64>>::bulk_load_cdt(
            points
                .iter()
                .map(|p| spade::Point2::new(p[0], p[2]))
                .collect(),
            constraints,
        )
        .map_err(|e| GeometryError::Surface(format!("triangulation failed: {e:?}")))?;
        let poly: Vec<[f64; 2]> = boundary
            .iter()
            .map(|&i| [points[i][0], points[i][2]])
            .collect();
        let mut triangles = Vec::new();
        for face in cdt.inner_faces() {
            let v = face.vertices();
            let mut ids = [0usize; 3];
            for (k, h) in v.iter().enumerate() {
                let p = h.position();
                let Some(&id) = index_of.get(&key(p.x, p.y)) else {
                    return Err(GeometryError::Surface(
                        "triangulation added a vertex".into(),
                    ));
                };
                ids[k] = id;
            }
            let q = ids.map(|i| [points[i][0], points[i][2]]);
            let c = [
                (q[0][0] + q[1][0] + q[2][0]) / 3.0,
                (q[0][1] + q[1][1] + q[2][1]) / 3.0,
            ];
            if !point_in_polygon(&poly, c) {
                continue;
            }
            // Plan-CCW seen from +Y: (b-a)×(c-a) has positive y.
            let y = (q[1][1] - q[0][1]) * (q[2][0] - q[0][0])
                - (q[1][0] - q[0][0]) * (q[2][1] - q[0][1]);
            if y.abs() < 1e-14 {
                continue;
            }
            triangles.push(if y > 0.0 {
                ids
            } else {
                [ids[0], ids[2], ids[1]]
            });
        }
        if triangles.is_empty() {
            return Err(GeometryError::Surface("empty surface".into()));
        }
        // Orient the boundary like the triangles' own boundary edges.
        let directed: std::collections::HashSet<(usize, usize)> = triangles
            .iter()
            .flat_map(|t| [(t[0], t[1]), (t[1], t[2]), (t[2], t[0])])
            .collect();
        if !directed.contains(&(boundary[0], boundary[1])) {
            boundary.reverse();
        }
        Ok(SurfaceMesh {
            points,
            triangles,
            boundary,
        })
    }

    /// Surface height above plan point (x, z), `None` outside.
    pub fn height_at(&self, x: f64, z: f64) -> Option<f64> {
        let s = self.triangulate().ok()?;
        s.height_at(x, z)
    }

    /// True when every point shares one height.
    pub fn is_flat(&self) -> bool {
        let mut ys = self
            .boundary
            .iter()
            .chain(self.interior.iter())
            .map(|p| p[1]);
        let Some(first) = ys.next() else {
            return true;
        };
        ys.all(|y| (y - first).abs() < 1e-9)
    }

    /// Closed solid between this surface and `under`.
    pub fn solid(&self, under: Underside) -> Result<TriangleMesh, GeometryError> {
        Ok(self.triangulate()?.solid(under))
    }
}

impl SurfaceMesh {
    pub fn height_at(&self, x: f64, z: f64) -> Option<f64> {
        for t in &self.triangles {
            let [a, b, c] = t.map(|i| self.points[i]);
            let det = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]);
            if det.abs() < 1e-14 {
                continue;
            }
            let l1 = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / det;
            let l2 = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / det;
            let l3 = 1.0 - l1 - l2;
            if l1 >= -1e-9 && l2 >= -1e-9 && l3 >= -1e-9 {
                return Some(l1 * a[1] + l2 * b[1] + l3 * c[1]);
            }
        }
        None
    }

    /// Closed, consistently oriented solid: top surface, underside, and one
    /// side quad per boundary edge. Feature edges are where faces bend.
    pub fn solid(&self, under: Underside) -> TriangleMesh {
        let n = self.points.len();
        let top = |i: usize| self.points[i];
        let bot = |i: usize| {
            let p = self.points[i];
            match under {
                Underside::Drop(d) => [p[0], p[1] - d, p[2]],
                Underside::Flat(y) => [p[0], y, p[2]],
            }
        };
        // Face list: (vertex positions, polygon id for feature edges).
        let mut faces: Vec<[[f64; 3]; 3]> = Vec::new();
        for t in &self.triangles {
            faces.push([top(t[0]), top(t[1]), top(t[2])]);
        }
        for t in &self.triangles {
            faces.push([bot(t[0]), bot(t[2]), bot(t[1])]);
        }
        let m = self.boundary.len();
        for k in 0..m {
            let (i, j) = (self.boundary[k], self.boundary[(k + 1) % m]);
            let (ti, tj, bi, bj) = (top(i), top(j), bot(i), bot(j));
            // Quad tj → ti → bi → bj (opposite to the top's i → j).
            let tall_i = (ti[1] - bi[1]).abs() > 1e-9;
            let tall_j = (tj[1] - bj[1]).abs() > 1e-9;
            if tall_i {
                faces.push([tj, ti, bi]);
            }
            if tall_j {
                faces.push([tj, bi, bj]);
            }
        }
        let _ = n;
        let mut mesh = TriangleMesh::empty();
        let f = |p: [f64; 3]| [p[0] as f32, p[1] as f32, p[2] as f32];
        let normal = |t: &[[f64; 3]; 3]| {
            let u = [t[1][0] - t[0][0], t[1][1] - t[0][1], t[1][2] - t[0][2]];
            let v = [t[2][0] - t[0][0], t[2][1] - t[0][1], t[2][2] - t[0][2]];
            let c = [
                u[1] * v[2] - u[2] * v[1],
                u[2] * v[0] - u[0] * v[2],
                u[0] * v[1] - u[1] * v[0],
            ];
            let l = (c[0] * c[0] + c[1] * c[1] + c[2] * c[2]).sqrt().max(1e-30);
            [c[0] / l, c[1] / l, c[2] / l]
        };
        let normals: Vec<[f64; 3]> = faces.iter().map(normal).collect();
        for (t, nrm) in faces.iter().zip(&normals) {
            mesh.push_triangle(f(t[0]), f(t[1]), f(t[2]), f(*nrm));
        }
        // Feature edges: undirected edges whose two faces bend > ~1°.
        let pk = |p: [f64; 3]| {
            [
                (p[0] * 1e5).round() as i64,
                (p[1] * 1e5).round() as i64,
                (p[2] * 1e5).round() as i64,
            ]
        };
        type Key = ([i64; 3], [i64; 3]);
        let mut by_edge: std::collections::BTreeMap<Key, (usize, [[f64; 3]; 2])> =
            Default::default();
        let mut pairs: Vec<(usize, usize, [[f64; 3]; 2])> = Vec::new();
        for (fi, t) in faces.iter().enumerate() {
            for e in 0..3 {
                let (a, b) = (t[e], t[(e + 1) % 3]);
                let (ka, kb) = (pk(a), pk(b));
                let k = if ka < kb { (ka, kb) } else { (kb, ka) };
                if let Some((other, seg)) = by_edge.remove(&k) {
                    pairs.push((other, fi, seg));
                } else {
                    by_edge.insert(k, (fi, [a, b]));
                }
            }
        }
        let cos_lim = 0.9998_f64;
        for (a, b, seg) in pairs {
            let (na, nb) = (normals[a], normals[b]);
            if na[0] * nb[0] + na[1] * nb[1] + na[2] * nb[2] < cos_lim {
                mesh.push_edge(f(seg[0]), f(seg[1]));
            }
        }
        for (_, (_, seg)) in by_edge {
            mesh.push_edge(f(seg[0]), f(seg[1]));
        }
        mesh
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{is_watertight, mesh_volume};

    fn square(y: [f64; 4]) -> ShapedSurface {
        ShapedSurface::new(vec![
            [0.0, y[0], 0.0],
            [4.0, y[1], 0.0],
            [4.0, y[2], 4.0],
            [0.0, y[3], 4.0],
        ])
    }

    #[test]
    fn flat_surface_is_a_closed_box() {
        let m = square([1.0; 4]).solid(Underside::Drop(0.2)).unwrap();
        assert!(is_watertight(&m));
        assert!((mesh_volume(&m) - 16.0 * 0.2).abs() < 1e-4);
        assert_eq!(m.edge_count(), 12);
    }

    #[test]
    fn ramp_keeps_vertical_thickness_and_heights() {
        let s = square([0.0, 1.0, 1.0, 0.0]);
        let m = s.solid(Underside::Drop(0.25)).unwrap();
        assert!(is_watertight(&m));
        assert!((mesh_volume(&m) - 16.0 * 0.25).abs() < 1e-4);
        assert!((s.height_at(2.0, 1.0).unwrap() - 0.5).abs() < 1e-9);
        assert!((s.height_at(3.0, 3.0).unwrap() - 0.75).abs() < 1e-9);
        assert!(s.height_at(5.0, 1.0).is_none());
    }

    #[test]
    fn interior_point_and_creases_make_a_pyramid() {
        let mut s = square([0.0; 4]);
        s.interior.push([2.0, 2.0, 2.0]);
        s.creases = vec![[0, 4], [1, 4], [2, 4], [3, 4]];
        let m = s.solid(Underside::Drop(0.1)).unwrap();
        assert!(is_watertight(&m));
        assert!((s.height_at(2.0, 2.0).unwrap() - 2.0).abs() < 1e-9);
        assert!((s.height_at(1.0, 2.0).unwrap() - 1.0).abs() < 1e-9);
        assert!((mesh_volume(&m) - 1.6).abs() < 1e-4);
        // Down to a flat base: volume of the pyramid plus the base slab.
        let below = s.solid(Underside::Flat(-1.0)).unwrap();
        assert!(is_watertight(&below));
        assert!((mesh_volume(&below) - (16.0 + 16.0 * 2.0 / 3.0)).abs() < 1e-4);
    }

    #[test]
    fn crease_decides_the_fold() {
        // Opposite corners raised: without a crease the diagonal is free;
        // a crease 0–2 forces a valley along that diagonal.
        let mut s = square([0.0, 1.0, 0.0, 1.0]);
        s.creases = vec![[0, 2]];
        assert!((s.height_at(2.0, 2.0).unwrap() - 0.0).abs() < 1e-9);
        s.creases = vec![[1, 3]];
        assert!((s.height_at(2.0, 2.0).unwrap() - 1.0).abs() < 1e-9);
        assert!(is_watertight(&s.solid(Underside::Drop(0.2)).unwrap()));
    }

    #[test]
    fn bad_points_and_crossing_creases_are_ignored() {
        let mut s = square([0.0; 4]);
        s.interior = vec![[9.0, 1.0, 9.0], [1.0, 1.0, 1.0], [3.0, 1.0, 3.0]];
        s.creases = vec![[0, 2], [1, 3], [4, 5], [5, 5]];
        assert_eq!(s.usable_creases(), vec![[0, 2]]);
        assert!(is_watertight(&s.solid(Underside::Drop(0.2)).unwrap()));
    }

    #[test]
    fn concave_boundary_stays_watertight() {
        let s = ShapedSurface::new(vec![
            [0.0, 0.0, 0.0],
            [6.0, 0.5, 0.0],
            [6.0, 0.5, 6.0],
            [3.0, 1.0, 6.0],
            [3.0, 1.0, 3.0],
            [0.0, 0.0, 3.0],
        ]);
        let m = s.solid(Underside::Drop(0.3)).unwrap();
        assert!(is_watertight(&m));
        assert!((mesh_volume(&m) - 27.0 * 0.3).abs() < 1e-4);
    }
}
