//! Drape a plan polygon onto a terrain triangulation.
//!
//! The outline is clipped against each terrain facet, so the result follows
//! the triangulation (ridges and valleys inside the outline), not a single
//! plane through the boundary vertices. The crust is a thin vertical shell
//! lifted off the terrain. Drawn edges are the outline only: plan view stays
//! the 2D boundary, and the 3D view does not show every facet edge.

use std::collections::{HashMap, HashSet};

use crate::mesh::TriangleMesh;
use crate::prism::triangulate_shape;

/// One terrain facet, world coordinates, `y` up. Plan projection is XZ.
#[derive(Debug, Clone, Copy)]
pub struct TerrainFacet {
    pub p: [[f64; 3]; 3],
}

/// Plan triangulation of a polygon projected onto terrain facets.
#[derive(Debug, Clone)]
pub struct DrapedPatch {
    pub points: Vec<[f64; 3]>,
    pub triangles: Vec<[usize; 3]>,
}

const GRID: f64 = 1e-6;

fn snap(v: f64) -> f64 {
    (v / GRID).round() * GRID
}

fn key_xz(x: f64, z: f64) -> (i64, i64) {
    ((x / GRID).round() as i64, (z / GRID).round() as i64)
}

fn cross(a: [f64; 2], b: [f64; 2], p: [f64; 2]) -> f64 {
    (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])
}

fn signed_area(poly: &[[f64; 2]]) -> f64 {
    let n = poly.len();
    let mut s = 0.0;
    for i in 0..n {
        let a = poly[i];
        let b = poly[(i + 1) % n];
        s += a[0] * b[1] - b[0] * a[1];
    }
    s * 0.5
}

fn orient_ccw(mut tri: [[f64; 2]; 3]) -> [[f64; 2]; 3] {
    if cross(tri[0], tri[1], tri[2]) < 0.0 {
        tri.swap(1, 2);
    }
    tri
}

/// Height of `facet`'s plane at `(x, z)`. Points just outside the facet are
/// clamped onto it so a shared clip vertex still gets a height.
fn height_on(facet: &[[f64; 3]; 3], x: f64, z: f64) -> f64 {
    let [a, b, c] = *facet;
    let det = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]);
    if det.abs() < 1e-18 {
        return (a[1] + b[1] + c[1]) / 3.0;
    }
    let mut l1 = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / det;
    let mut l2 = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / det;
    let mut l3 = 1.0 - l1 - l2;
    l1 = l1.max(0.0);
    l2 = l2.max(0.0);
    l3 = l3.max(0.0);
    let s = l1 + l2 + l3;
    if s < 1e-18 {
        return (a[1] + b[1] + c[1]) / 3.0;
    }
    (l1 * a[1] + l2 * b[1] + l3 * c[1]) / s
}

fn contains(facet_xz: &[[f64; 2]; 3], x: f64, z: f64) -> bool {
    let p = [x, z];
    let e = 1e-8;
    cross(facet_xz[0], facet_xz[1], p) >= -e
        && cross(facet_xz[1], facet_xz[2], p) >= -e
        && cross(facet_xz[2], facet_xz[0], p) >= -e
}

fn bbox2(pts: &[[f64; 2]]) -> [f64; 4] {
    let mut bb = [
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    ];
    for p in pts {
        bb[0] = bb[0].min(p[0]);
        bb[1] = bb[1].min(p[1]);
        bb[2] = bb[2].max(p[0]);
        bb[3] = bb[3].max(p[1]);
    }
    bb
}

fn overlap(a: [f64; 4], b: [f64; 4]) -> bool {
    a[0] <= b[2] + 1e-8 && b[0] <= a[2] + 1e-8 && a[1] <= b[3] + 1e-8 && b[1] <= a[3] + 1e-8
}

/// Where the segment `a→b` crosses the infinite line through `c→d`.
///
/// Half-plane clipping cuts on the line, not the edge segment: the crossing
/// is often past the segment's endpoints when the terrain triangle is smaller
/// than the outline.
fn line_hit(a: [f64; 2], b: [f64; 2], c: [f64; 2], d: [f64; 2]) -> Option<[f64; 2]> {
    let r = [b[0] - a[0], b[1] - a[1]];
    let s = [d[0] - c[0], d[1] - c[1]];
    let den = r[0] * s[1] - r[1] * s[0];
    if den.abs() < 1e-18 {
        return None;
    }
    let qp = [c[0] - a[0], c[1] - a[1]];
    let t = (qp[0] * s[1] - qp[1] * s[0]) / den;
    if (-1e-9..=1.0 + 1e-9).contains(&t) {
        let t = t.clamp(0.0, 1.0);
        Some([a[0] + t * r[0], a[1] + t * r[1]])
    } else {
        None
    }
}

fn clip_half(poly: &[[f64; 2]], a: [f64; 2], b: [f64; 2]) -> Vec<[f64; 2]> {
    let mut out = Vec::new();
    if poly.is_empty() {
        return out;
    }
    let inside = |p: [f64; 2]| cross(a, b, p) >= -1e-10;
    let n = poly.len();
    for i in 0..n {
        let cur = poly[i];
        let prev = poly[(i + n - 1) % n];
        let cin = inside(cur);
        let pin = inside(prev);
        if cin {
            if !pin {
                if let Some(h) = line_hit(prev, cur, a, b) {
                    out.push(h);
                }
            }
            out.push(cur);
        } else if pin {
            if let Some(h) = line_hit(prev, cur, a, b) {
                out.push(h);
            }
        }
    }
    out
}

/// Clip a CCW convex polygon by a CCW triangle. The intersection is convex.
fn clip_triangle(subject: [[f64; 2]; 3], clip: [[f64; 2]; 3]) -> Vec<[f64; 2]> {
    let mut poly = subject.to_vec();
    for i in 0..3 {
        if poly.len() < 3 {
            return Vec::new();
        }
        poly = clip_half(&poly, clip[i], clip[(i + 1) % 3]);
    }
    if poly.len() >= 2 {
        let (f, l) = (poly[0], *poly.last().unwrap());
        if (f[0] - l[0]).abs() < 1e-9 && (f[1] - l[1]).abs() < 1e-9 {
            poly.pop();
        }
    }
    poly
}

struct Facet {
    p: [[f64; 3]; 3],
    xz: [[f64; 2]; 3],
    bb: [f64; 4],
}

struct Index {
    facets: Vec<Facet>,
    origin_x: f64,
    origin_z: f64,
    cell: f64,
    nx: usize,
    nz: usize,
    bins: Vec<Vec<u32>>,
}

impl Index {
    fn build(raw: &[TerrainFacet]) -> Self {
        let mut facets = Vec::with_capacity(raw.len());
        let mut bb = [
            f64::INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::NEG_INFINITY,
        ];
        for f in raw {
            let xz = orient_ccw([
                [f.p[0][0], f.p[0][2]],
                [f.p[1][0], f.p[1][2]],
                [f.p[2][0], f.p[2][2]],
            ]);
            // Keep `p` matched to the oriented plan triangle.
            let mut p = f.p;
            if cross(
                [f.p[0][0], f.p[0][2]],
                [f.p[1][0], f.p[1][2]],
                [f.p[2][0], f.p[2][2]],
            ) < 0.0
            {
                p.swap(1, 2);
            }
            let fbb = bbox2(&xz);
            if !fbb[0].is_finite() {
                continue;
            }
            bb[0] = bb[0].min(fbb[0]);
            bb[1] = bb[1].min(fbb[1]);
            bb[2] = bb[2].max(fbb[2]);
            bb[3] = bb[3].max(fbb[3]);
            facets.push(Facet { p, xz, bb: fbb });
        }
        let cell = 4.0;
        let (nx, nz) = if facets.is_empty() || !bb[0].is_finite() {
            (1, 1)
        } else {
            (
                ((bb[2] - bb[0]) / cell).ceil() as usize + 1,
                ((bb[3] - bb[1]) / cell).ceil() as usize + 1,
            )
        };
        let nx = nx.clamp(1, 256);
        let nz = nz.clamp(1, 256);
        let mut bins = vec![Vec::new(); nx * nz];
        let ox = if bb[0].is_finite() { bb[0] } else { 0.0 };
        let oz = if bb[1].is_finite() { bb[1] } else { 0.0 };
        let cell_of = |x: f64, z: f64| -> (usize, usize) {
            let i = ((x - ox) / cell).floor() as isize;
            let j = ((z - oz) / cell).floor() as isize;
            (
                i.clamp(0, nx as isize - 1) as usize,
                j.clamp(0, nz as isize - 1) as usize,
            )
        };
        for (fi, f) in facets.iter().enumerate() {
            let (i0, j0) = cell_of(f.bb[0], f.bb[1]);
            let (i1, j1) = cell_of(f.bb[2], f.bb[3]);
            for j in j0..=j1 {
                for i in i0..=i1 {
                    bins[j * nx + i].push(fi as u32);
                }
            }
        }
        Self {
            facets,
            origin_x: ox,
            origin_z: oz,
            cell,
            nx,
            nz,
            bins,
        }
    }

    fn cell(&self, x: f64, z: f64) -> usize {
        let i = ((x - self.origin_x) / self.cell).floor() as isize;
        let j = ((z - self.origin_z) / self.cell).floor() as isize;
        let i = i.clamp(0, self.nx as isize - 1) as usize;
        let j = j.clamp(0, self.nz as isize - 1) as usize;
        j * self.nx + i
    }

    fn candidates(&self, bb: [f64; 4]) -> Vec<u32> {
        if self.facets.is_empty() {
            return Vec::new();
        }
        let (i0, j0) = {
            let i = ((bb[0] - self.origin_x) / self.cell).floor() as isize;
            let j = ((bb[1] - self.origin_z) / self.cell).floor() as isize;
            (
                i.clamp(0, self.nx as isize - 1) as usize,
                j.clamp(0, self.nz as isize - 1) as usize,
            )
        };
        let (i1, j1) = {
            let i = ((bb[2] - self.origin_x) / self.cell).floor() as isize;
            let j = ((bb[3] - self.origin_z) / self.cell).floor() as isize;
            (
                i.clamp(0, self.nx as isize - 1) as usize,
                j.clamp(0, self.nz as isize - 1) as usize,
            )
        };
        let mut out = Vec::new();
        let mut seen = HashSet::new();
        for j in j0..=j1 {
            for i in i0..=i1 {
                for &id in &self.bins[j * self.nx + i] {
                    if seen.insert(id) {
                        out.push(id);
                    }
                }
            }
        }
        out
    }

    /// Highest terrain at `(x, z)`, if any facet covers it.
    fn height_at(&self, x: f64, z: f64) -> Option<f64> {
        let c = self.cell(x, z);
        let (ci, cj) = (c % self.nx, c / self.nx);
        let mut best: Option<f64> = None;
        let mut seen = HashSet::new();
        for dj in -1isize..=1 {
            for di in -1isize..=1 {
                let i = ci as isize + di;
                let j = cj as isize + dj;
                if i < 0 || j < 0 || i >= self.nx as isize || j >= self.nz as isize {
                    continue;
                }
                for &id in &self.bins[j as usize * self.nx + i as usize] {
                    if !seen.insert(id) {
                        continue;
                    }
                    let f = &self.facets[id as usize];
                    if !contains(&f.xz, x, z) {
                        continue;
                    }
                    let y = height_on(&f.p, x, z);
                    best = Some(best.map_or(y, |b| b.max(y)));
                }
            }
        }
        best
    }
}

/// Project `polygon` (plan x, z, either winding, not closed) onto `facets`.
///
/// Each output triangle lies in one terrain facet, so interior ridges of the
/// triangulation show up in the surface. Where several facets overlap, the
/// highest wins. `None` when the polygon misses every facet.
pub fn drape_polygon(polygon: &[[f64; 2]], facets: &[TerrainFacet]) -> Option<DrapedPatch> {
    if polygon.len() < 3 || facets.is_empty() {
        return None;
    }
    let mut ring = polygon.to_vec();
    if ring.len() > 1 {
        let (f, l) = (ring[0], *ring.last().unwrap());
        if (f[0] - l[0]).abs() < 1e-6 && (f[1] - l[1]).abs() < 1e-6 {
            ring.pop();
        }
    }
    if ring.len() < 3 || signed_area(&ring).abs() < 1e-8 {
        return None;
    }
    let index = Index::build(facets);
    let poly_tris = triangulate_shape(&[ring]);
    if poly_tris.is_empty() {
        return None;
    }
    let mut points: Vec<[f64; 3]> = Vec::new();
    let mut weld: HashMap<(i64, i64), usize> = HashMap::new();
    let mut triangles: Vec<[usize; 3]> = Vec::new();
    let add = |weld: &mut HashMap<(i64, i64), usize>, points: &mut Vec<[f64; 3]>, p: [f64; 3]| {
        let p = [snap(p[0]), snap(p[1]), snap(p[2])];
        let k = key_xz(p[0], p[2]);
        if let Some(&i) = weld.get(&k) {
            if p[1] > points[i][1] {
                points[i][1] = p[1];
            }
            i
        } else {
            let i = points.len();
            points.push(p);
            weld.insert(k, i);
            i
        }
    };
    for tri in poly_tris {
        let subject = orient_ccw(tri);
        let sbb = bbox2(&subject);
        for id in index.candidates(sbb) {
            let facet = &index.facets[id as usize];
            if !overlap(sbb, facet.bb) {
                continue;
            }
            let clipped = clip_triangle(subject, facet.xz);
            if clipped.len() < 3 {
                continue;
            }
            let c = centroid(&clipped);
            let mine = height_on(&facet.p, c[0], c[1]);
            if let Some(best) = index.height_at(c[0], c[1]) {
                if mine + 1e-4 < best {
                    continue;
                }
            }
            let mut ids = Vec::with_capacity(clipped.len());
            for q in &clipped {
                let y = height_on(&facet.p, q[0], q[1]);
                ids.push(add(&mut weld, &mut points, [q[0], y, q[1]]));
            }
            ids.dedup();
            if ids.len() >= 2 && ids.first() == ids.last() {
                ids.pop();
            }
            if ids.len() < 3 {
                continue;
            }
            for i in 1..ids.len() - 1 {
                let t = [ids[0], ids[i], ids[i + 1]];
                if t[0] == t[1] || t[1] == t[2] || t[0] == t[2] {
                    continue;
                }
                let area = cross(
                    [points[t[0]][0], points[t[0]][2]],
                    [points[t[1]][0], points[t[1]][2]],
                    [points[t[2]][0], points[t[2]][2]],
                );
                if area.abs() < 1e-10 {
                    continue;
                }
                triangles.push(if area > 0.0 { t } else { [t[0], t[2], t[1]] });
            }
        }
    }
    if triangles.is_empty() {
        return None;
    }
    Some(DrapedPatch { points, triangles })
}

fn centroid(poly: &[[f64; 2]]) -> [f64; 2] {
    let n = poly.len() as f64;
    let mut s = [0.0, 0.0];
    for p in poly {
        s[0] += p[0];
        s[1] += p[1];
    }
    [s[0] / n, s[1] / n]
}

impl DrapedPatch {
    /// Terrain height at `(x, z)` on this patch, before the crust lift.
    pub fn height_at(&self, x: f64, z: f64) -> Option<f64> {
        for t in &self.triangles {
            let [a, b, c] = t.map(|i| self.points[i]);
            let xz = [[a[0], a[2]], [b[0], b[2]], [c[0], c[2]]];
            if contains(&xz, x, z) {
                return Some(height_on(&[a, b, c], x, z));
            }
        }
        None
    }

    /// Thin shell: bottom is `clearance` above the patch, top is another
    /// `thickness` above that. Edges are the outline (and vertical corners),
    /// never the interior triangulation.
    pub fn crust(&self, clearance: f64, thickness: f64) -> TriangleMesh {
        let thickness = thickness.max(1e-4);
        let clearance = clearance.max(0.0);
        let top = |i: usize| {
            let p = self.points[i];
            [p[0], p[1] + clearance + thickness, p[2]]
        };
        let bot = |i: usize| {
            let p = self.points[i];
            [p[0], p[1] + clearance, p[2]]
        };
        let normals = vertex_normals(&self.points, &self.triangles);
        let mut mesh = TriangleMesh::empty();
        let f = |p: [f64; 3]| [p[0] as f32, p[1] as f32, p[2] as f32];
        let nf = |p: [f64; 3]| [p[0] as f32, p[1] as f32, p[2] as f32];
        for t in &self.triangles {
            mesh.push_triangle_smooth(t.map(|i| f(top(i))), t.map(|i| nf(normals[i])));
        }
        let down = [0.0_f32, -1.0, 0.0];
        for t in &self.triangles {
            mesh.push_triangle(f(bot(t[0])), f(bot(t[2])), f(bot(t[1])), down);
        }
        for loop_ in boundary_loops(&self.triangles) {
            let m = loop_.len();
            for k in 0..m {
                let (i, j) = (loop_[k], loop_[(k + 1) % m]);
                let (ti, tj, bi, bj) = (top(i), top(j), bot(i), bot(j));
                let outward = side_normal(ti, tj);
                push_side(&mut mesh, tj, ti, bi, bj, outward);
                mesh.push_edge(f(ti), f(tj));
                let prev = loop_[(k + m - 1) % m];
                let turn = side_normal(top(prev), ti);
                let dot = turn[0] * outward[0] + turn[2] * outward[2];
                if dot < 0.999 {
                    mesh.push_edge(f(ti), f(bi));
                }
            }
        }
        mesh
    }
}

fn side_normal(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    let (dx, dz) = (b[0] - a[0], b[2] - a[2]);
    let l = (dx * dx + dz * dz).sqrt().max(1e-30);
    [-dz / l, 0.0, dx / l]
}

fn push_side(
    mesh: &mut TriangleMesh,
    tj: [f64; 3],
    ti: [f64; 3],
    bi: [f64; 3],
    bj: [f64; 3],
    nrm: [f64; 3],
) {
    let f = |p: [f64; 3]| [p[0] as f32, p[1] as f32, p[2] as f32];
    let n = [nrm[0] as f32, nrm[1] as f32, nrm[2] as f32];
    let emit = |mesh: &mut TriangleMesh, tri: [[f64; 3]; 3]| {
        let u = [
            tri[1][0] - tri[0][0],
            tri[1][1] - tri[0][1],
            tri[1][2] - tri[0][2],
        ];
        let v = [
            tri[2][0] - tri[0][0],
            tri[2][1] - tri[0][1],
            tri[2][2] - tri[0][2],
        ];
        let c = [
            u[1] * v[2] - u[2] * v[1],
            u[2] * v[0] - u[0] * v[2],
            u[0] * v[1] - u[1] * v[0],
        ];
        if c[0].abs() + c[1].abs() + c[2].abs() < 1e-16 {
            return;
        }
        let tri = if c[0] * nrm[0] + c[2] * nrm[2] < 0.0 {
            [tri[0], tri[2], tri[1]]
        } else {
            tri
        };
        mesh.push_triangle(f(tri[0]), f(tri[1]), f(tri[2]), n);
    };
    if (ti[1] - bi[1]).abs() > 1e-9 {
        emit(mesh, [tj, ti, bi]);
    }
    if (tj[1] - bj[1]).abs() > 1e-9 {
        emit(mesh, [tj, bi, bj]);
    }
}

fn vertex_normals(points: &[[f64; 3]], triangles: &[[usize; 3]]) -> Vec<[f64; 3]> {
    let mut acc = vec![[0.0; 3]; points.len()];
    for t in triangles {
        let [a, b, c] = t.map(|i| points[i]);
        let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        let v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        let n = [
            u[1] * v[2] - u[2] * v[1],
            u[2] * v[0] - u[0] * v[2],
            u[0] * v[1] - u[1] * v[0],
        ];
        for &i in t {
            acc[i][0] += n[0];
            acc[i][1] += n[1];
            acc[i][2] += n[2];
        }
    }
    acc.into_iter()
        .map(|n| {
            let l = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
            if l < 1e-12 {
                [0.0, 1.0, 0.0]
            } else {
                [n[0] / l, n[1] / l, n[2] / l]
            }
        })
        .collect()
}

fn boundary_loops(triangles: &[[usize; 3]]) -> Vec<Vec<usize>> {
    let mut uses: HashMap<(usize, usize), u32> = HashMap::new();
    for t in triangles {
        for i in 0..3 {
            let (a, b) = (t[i], t[(i + 1) % 3]);
            let k = if a < b { (a, b) } else { (b, a) };
            *uses.entry(k).or_insert(0) += 1;
        }
    }
    let mut next: HashMap<usize, usize> = HashMap::new();
    for t in triangles {
        for i in 0..3 {
            let (a, b) = (t[i], t[(i + 1) % 3]);
            let k = if a < b { (a, b) } else { (b, a) };
            if uses.get(&k).copied().unwrap_or(0) == 1 {
                next.insert(a, b);
            }
        }
    }
    let mut seen = HashSet::new();
    let mut loops = Vec::new();
    let starts: Vec<usize> = next.keys().copied().collect();
    for s in starts {
        if !seen.insert(s) {
            continue;
        }
        let mut loop_ = vec![s];
        let mut cur = s;
        for _ in 0..next.len() {
            let Some(&n) = next.get(&cur) else {
                break;
            };
            if n == s {
                break;
            }
            if !seen.insert(n) {
                break;
            }
            loop_.push(n);
            cur = n;
        }
        if loop_.len() >= 3 {
            loops.push(loop_);
        }
    }
    loops
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plane() -> Vec<TerrainFacet> {
        // y = 0.2 * z over the square [0,10] x [0,10].
        vec![
            TerrainFacet {
                p: [[0.0, 0.0, 0.0], [10.0, 0.0, 0.0], [10.0, 2.0, 10.0]],
            },
            TerrainFacet {
                p: [[0.0, 0.0, 0.0], [10.0, 2.0, 10.0], [0.0, 2.0, 10.0]],
            },
        ]
    }

    fn peak() -> Vec<TerrainFacet> {
        let c = [5.0, 1.5, 5.0];
        let corners = [
            [0.0, 0.0, 0.0],
            [10.0, 0.0, 0.0],
            [10.0, 0.0, 10.0],
            [0.0, 0.0, 10.0],
        ];
        (0..4)
            .map(|i| TerrainFacet {
                p: [corners[i], corners[(i + 1) % 4], c],
            })
            .collect()
    }

    fn plan_area(patch: &DrapedPatch) -> f64 {
        patch
            .triangles
            .iter()
            .map(|t| {
                let p = t.map(|i| patch.points[i]);
                0.5 * ((p[1][0] - p[0][0]) * (p[2][2] - p[0][2])
                    - (p[1][2] - p[0][2]) * (p[2][0] - p[0][0]))
                    .abs()
            })
            .sum()
    }

    #[test]
    fn a_rectangle_on_two_facets_keeps_both_halves() {
        let facets = vec![
            TerrainFacet {
                p: [[-10.0, 0.0, -12.0], [24.0, 0.0, -12.0], [24.0, 0.5, 20.0]],
            },
            TerrainFacet {
                p: [[-10.0, 0.0, -12.0], [24.0, 0.5, 20.0], [-10.0, 0.2, 20.0]],
            },
        ];
        let poly = [[0.0, 12.0], [20.0, 12.0], [20.0, 16.0], [0.0, 16.0]];
        let patch = drape_polygon(&poly, &facets).expect("drape");
        let expect = 20.0 * 4.0;
        let area = plan_area(&patch);
        assert!(
            (area - expect).abs() < 0.5,
            "covered {area}, polygon is {expect}"
        );
        assert!(patch.height_at(1.0, 15.5).is_some(), "north-west");
        assert!(patch.height_at(18.0, 12.5).is_some(), "south-east");
        assert!(patch.height_at(18.0, 15.5).is_some(), "north-east");
    }

    #[test]
    fn clipping_a_facet_keeps_a_point_both_shapes_contain() {
        let facet = orient_ccw([[24.0, 20.0], [16.0, 14.0], [18.0, 6.0]]);
        let subject = orient_ccw([[-0.25, 11.25], [19.8, 11.25], [19.8, 15.8]]);
        let q = [18.0, 12.5];
        assert!(contains(&facet, q[0], q[1]), "facet");
        assert!(contains(&subject, q[0], q[1]), "subject");
        let clipped = clip_triangle(subject, facet);
        assert!(
            clipped.len() >= 3 && contains_poly(&clipped, q[0], q[1]),
            "intersection dropped {q:?}: {clipped:?}"
        );
    }

    fn contains_poly(poly: &[[f64; 2]], x: f64, z: f64) -> bool {
        // Fan against the first vertex. Convex clip result.
        if poly.len() < 3 {
            return false;
        }
        for i in 1..poly.len() - 1 {
            let tri = orient_ccw([poly[0], poly[i], poly[i + 1]]);
            if contains(&tri, x, z) {
                return true;
            }
        }
        false
    }

    #[test]
    fn a_yard_rectangle_covers_the_control_tin() {
        let boundary = [
            [-10.0, 0.0, -12.0],
            [24.0, 0.0, -12.0],
            [24.0, 0.0, 20.0],
            [-10.0, 0.0, 20.0],
        ];
        let interior = [
            [2.0, 0.0, 4.0],
            [8.0, 0.0, 4.0],
            [12.0, 0.0, 6.0],
            [4.0, 0.0, 9.0],
            [-2.0, 0.55, 14.0],
            [8.0, 1.2, 15.5],
            [16.0, 0.75, 14.0],
            [8.0, 0.4, 18.2],
            [18.0, 0.04, 6.0],
            [2.0, 0.0, -6.0],
        ];
        let tin = crate::ShapedSurface {
            boundary: boundary.to_vec(),
            interior: interior.to_vec(),
            creases: vec![],
        }
        .triangulate()
        .expect("tin");
        let facets: Vec<TerrainFacet> = tin
            .triangles
            .iter()
            .map(|t| TerrainFacet {
                p: t.map(|i| tin.points[i]),
            })
            .collect();
        let mut tin_in = 0.0;
        for f in &facets {
            let c = [
                (f.p[0][0] + f.p[1][0] + f.p[2][0]) / 3.0,
                (f.p[0][2] + f.p[1][2] + f.p[2][2]) / 3.0,
            ];
            if (-0.25..=19.8).contains(&c[0]) && (11.25..=15.8).contains(&c[1]) {
                tin_in += 0.5
                    * ((f.p[1][0] - f.p[0][0]) * (f.p[2][2] - f.p[0][2])
                        - (f.p[1][2] - f.p[0][2]) * (f.p[2][0] - f.p[0][0]))
                        .abs();
            }
        }
        assert!(
            tin_in > 80.0,
            "control tin should cover the yard, got {tin_in}"
        );
        let poly = [[-0.25, 11.25], [19.8, 11.25], [19.8, 15.8], [-0.25, 15.8]];
        let patch = drape_polygon(&poly, &facets).expect("drape");
        let expect = 20.05 * 4.55;
        let area = plan_area(&patch);
        assert!(
            (area - expect).abs() / expect < 0.02,
            "covered {area}, polygon is {expect}"
        );
        assert!(
            patch.height_at(18.0, 12.5).is_some(),
            "south-east of the yard"
        );
        assert!(
            patch.height_at(2.0, 15.0).is_some(),
            "north-west of the yard"
        );

        let smooth = tin.smoothed(2);
        let sfacets: Vec<TerrainFacet> = smooth
            .triangles
            .iter()
            .map(|t| TerrainFacet {
                p: t.map(|i| smooth.points[i]),
            })
            .collect();
        let spatched = drape_polygon(&poly, &sfacets).expect("smoothed drape");
        let sarea = plan_area(&spatched);
        assert!(
            (sarea - expect).abs() / expect < 0.05,
            "smoothed surface covered {sarea}, polygon is {expect}"
        );
        let knoll = spatched.height_at(8.0, 15.2).expect("knoll");
        assert!(knoll > 0.6, "smoothed knoll height {knoll}");
    }

    #[test]
    fn a_slope_lifts_the_interior_not_only_the_corners() {
        let poly = [[2.0, 2.0], [8.0, 2.0], [8.0, 8.0], [2.0, 8.0]];
        let patch = drape_polygon(&poly, &plane()).expect("drape");
        let y = patch.height_at(5.0, 5.0).expect("centre");
        assert!((y - 1.0).abs() < 1e-3, "centre on the plane, got {y}");
        let low = patch.height_at(2.0, 2.0).expect("corner");
        assert!(y > low + 0.4, "interior follows the slope ({low} → {y})");
        assert!(patch.triangles.len() >= 2);
    }

    #[test]
    fn an_interior_peak_is_in_the_mesh() {
        let poly = [[2.0, 2.0], [8.0, 2.0], [8.0, 8.0], [2.0, 8.0]];
        let patch = drape_polygon(&poly, &peak()).expect("drape");
        let y = patch.height_at(5.0, 5.0).expect("peak");
        assert!(
            (y - 1.5).abs() < 1e-3,
            "peak must come from the triangulation, got {y}"
        );
        // A plane through the four corners is y = 0. The patch is not that plane.
        assert!(patch.triangles.len() > 2, "subdivided by the terrain");
        let mesh = patch.crust(0.02, 0.05);
        assert!(crate::is_watertight(&mesh));
        let on_rim = |x: f32, z: f32| {
            let (x, z) = (x as f64, z as f64);
            let near = |a: f64, b: f64| (a - b).abs() < 1e-3;
            (near(x, 2.0) || near(x, 8.0)) && (2.0 - 1e-3..=8.0 + 1e-3).contains(&z)
                || (near(z, 2.0) || near(z, 8.0)) && (2.0 - 1e-3..=8.0 + 1e-3).contains(&x)
        };
        for e in mesh.edges.chunks(6) {
            let (ax, az, bx, bz) = (e[0], e[2], e[3], e[5]);
            let vertical = (ax - bx).abs() < 1e-3 && (az - bz).abs() < 1e-3;
            if vertical {
                continue;
            }
            let mid = ((ax + bx) * 0.5, (az + bz) * 0.5);
            assert!(
                on_rim(mid.0, mid.1),
                "interior edge in the outline: {ax},{az} → {bx},{bz}"
            );
        }
    }

    #[test]
    fn a_polygon_off_the_terrain_is_not_draped() {
        let poly = [[20.0, 20.0], [24.0, 20.0], [24.0, 24.0], [20.0, 24.0]];
        assert!(drape_polygon(&poly, &plane()).is_none());
    }

    #[test]
    fn the_crust_sits_above_the_terrain() {
        let poly = [[2.0, 2.0], [8.0, 2.0], [8.0, 8.0], [2.0, 8.0]];
        let patch = drape_polygon(&poly, &plane()).unwrap();
        let mesh = patch.crust(0.02, 0.04);
        let (lo, hi) = mesh.aabb().expect("aabb");
        // Highest terrain under the square is y = 0.2 * 8 = 1.6; the crust adds
        // clearance + thickness. The bottom stays above the lowest ground.
        assert!(
            (hi[1] as f64 - (1.6 + 0.02 + 0.04)).abs() < 1e-2,
            "hi {}",
            hi[1]
        );
        assert!(
            lo[1] as f64 > 0.4,
            "bottom {} should clear the low edge of the slope",
            lo[1]
        );
        assert!(crate::is_watertight(&mesh));
    }
}
