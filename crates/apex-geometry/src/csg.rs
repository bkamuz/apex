//! General mesh booleans on arbitrary closed (manifold) triangle meshes.
//!
//! Backed by `boolmesh`, a pure-Rust Manifold-style kernel, so it builds for
//! wasm32 without a C++ toolchain. Inputs are welded on a fine grid first
//! (Apex meshes are flat-shaded, i.e. split per face); outputs are re-split
//! per face with flat normals and get feature edges for line rendering.

use crate::mesh::TriangleMesh;
use crate::prism::BooleanOp;
use boolmesh::prelude::{compute_boolean, Manifold, OpType};
use std::collections::HashMap;

/// Weld grid for input vertices (metres).
const WELD: f64 = 1e-6;
/// Dihedral angle (radians) above which a shared edge is drawn.
const FEATURE_ANGLE: f64 = 0.35;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CsgError {
    #[error("operand is not a closed manifold mesh: {0}")]
    NotManifold(String),
    #[error("boolean failed: {0}")]
    Failed(String),
}

fn to_manifold(mesh: &TriangleMesh) -> Result<Manifold, CsgError> {
    let mut map: HashMap<(i64, i64, i64), usize> = HashMap::new();
    let mut pos: Vec<f64> = Vec::new();
    let mut remap = Vec::with_capacity(mesh.positions.len() / 3);
    for p in mesh.positions.chunks(3) {
        let k = (
            (p[0] as f64 / WELD).round() as i64,
            (p[1] as f64 / WELD).round() as i64,
            (p[2] as f64 / WELD).round() as i64,
        );
        let i = *map.entry(k).or_insert_with(|| {
            pos.extend([k.0 as f64 * WELD, k.1 as f64 * WELD, k.2 as f64 * WELD]);
            pos.len() / 3 - 1
        });
        remap.push(i);
    }
    let mut idx: Vec<usize> = Vec::with_capacity(mesh.indices.len());
    for t in mesh.indices.chunks(3) {
        let (a, b, c) = (
            remap[t[0] as usize],
            remap[t[1] as usize],
            remap[t[2] as usize],
        );
        // Welding can collapse slivers; drop them rather than feed the kernel
        // degenerate faces.
        if a != b && b != c && a != c {
            idx.extend([a, b, c]);
        }
    }
    let idx = split_t_junctions(&pos, idx);
    check_closed(&idx)?;
    Manifold::new(&pos, &idx).map_err(CsgError::NotManifold)
}

/// Builders (wall joins, cut openings) can leave T-junctions: a vertex lying
/// on another face's edge. Split such faces at the vertex so every edge is
/// shared by exactly two faces.
fn split_t_junctions(pos: &[f64], mut idx: Vec<usize>) -> Vec<usize> {
    const TOL: f64 = 1e-5;
    let p = |i: usize| [pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]];
    let nv = pos.len() / 3;
    for _ in 0..64 {
        let mut directed: std::collections::HashSet<(usize, usize)> =
            std::collections::HashSet::with_capacity(idx.len());
        for t in idx.chunks(3) {
            for k in 0..3 {
                directed.insert((t[k], t[(k + 1) % 3]));
            }
        }
        let mut out = Vec::with_capacity(idx.len() + 16);
        let mut changed = false;
        for t in idx.chunks(3) {
            let mut split = None;
            for k in 0..3 {
                let (a, b) = (t[k], t[(k + 1) % 3]);
                if directed.contains(&(b, a)) {
                    continue;
                }
                let (pa, pb) = (p(a), p(b));
                let d = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
                let len2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
                if len2 < TOL * TOL {
                    continue;
                }
                let mut best: Option<(f64, usize)> = None;
                for v in 0..nv {
                    if v == a || v == b {
                        continue;
                    }
                    let pv = p(v);
                    let w = [pv[0] - pa[0], pv[1] - pa[1], pv[2] - pa[2]];
                    let s = (w[0] * d[0] + w[1] * d[1] + w[2] * d[2]) / len2;
                    if s <= 1e-9 || s >= 1.0 - 1e-9 {
                        continue;
                    }
                    let e = [w[0] - s * d[0], w[1] - s * d[1], w[2] - s * d[2]];
                    if e[0] * e[0] + e[1] * e[1] + e[2] * e[2] > TOL * TOL {
                        continue;
                    }
                    if best.is_none_or(|(bs, _)| s < bs) {
                        best = Some((s, v));
                    }
                }
                if let Some((_, v)) = best {
                    split = Some((k, v));
                    break;
                }
            }
            match split {
                Some((k, v)) => {
                    let (a, b, c) = (t[k], t[(k + 1) % 3], t[(k + 2) % 3]);
                    out.extend([a, v, c, v, b, c]);
                    changed = true;
                }
                None => out.extend_from_slice(t),
            }
        }
        idx = out;
        if !changed {
            break;
        }
    }
    idx
}

/// Every directed edge must appear once and be matched by its reverse.
/// `boolmesh` panics (index out of bounds) on open or non-manifold input
/// instead of returning an error, so reject it here first.
fn check_closed(idx: &[usize]) -> Result<(), CsgError> {
    if idx.is_empty() {
        return Err(CsgError::NotManifold("no faces".into()));
    }
    let mut directed: HashMap<(usize, usize), u32> = HashMap::with_capacity(idx.len());
    for t in idx.chunks(3) {
        for k in 0..3 {
            *directed.entry((t[k], t[(k + 1) % 3])).or_default() += 1;
        }
    }
    for (&(a, b), &n) in &directed {
        if n != 1 {
            return Err(CsgError::NotManifold(format!(
                "edge {a}-{b} used {n} times"
            )));
        }
        if !directed.contains_key(&(b, a)) {
            return Err(CsgError::NotManifold(format!("open edge {a}-{b}")));
        }
    }
    Ok(())
}

fn from_manifold(m: &Manifold) -> TriangleMesh {
    let p = |i: usize| [m.ps[i].x, m.ps[i].y, m.ps[i].z];
    let tris: Vec<[usize; 3]> =
        m.hs.chunks(3)
            .map(|h| [h[0].tail, h[1].tail, h[2].tail])
            .collect();
    let normal = |t: &[usize; 3]| {
        let (a, b, c) = (p(t[0]), p(t[1]), p(t[2]));
        let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        let v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        let n = [
            u[1] * v[2] - u[2] * v[1],
            u[2] * v[0] - u[0] * v[2],
            u[0] * v[1] - u[1] * v[0],
        ];
        let l = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt().max(1e-300);
        [n[0] / l, n[1] / l, n[2] / l]
    };
    let normals: Vec<[f64; 3]> = tris.iter().map(normal).collect();
    let f = |a: [f64; 3]| [a[0] as f32, a[1] as f32, a[2] as f32];
    let mut out = TriangleMesh::empty();
    for (t, n) in tris.iter().zip(&normals) {
        out.push_triangle(f(p(t[0])), f(p(t[1])), f(p(t[2])), f(*n));
    }
    // Feature edges: halfedges whose two faces bend more than FEATURE_ANGLE.
    let cos_lim = FEATURE_ANGLE.cos();
    for (i, h) in m.hs.iter().enumerate() {
        let Some(j) = h.pair() else { continue };
        if j < i {
            continue;
        }
        let (na, nb) = (normals[i / 3], normals[j / 3]);
        let d = na[0] * nb[0] + na[1] * nb[1] + na[2] * nb[2];
        if d < cos_lim {
            out.push_edge(f(p(h.tail)), f(p(h.head)));
        }
    }
    out
}

/// Boolean of two closed meshes. An empty operand is treated as the empty
/// solid; an empty result is an empty mesh.
pub fn mesh_boolean(
    a: &TriangleMesh,
    b: &TriangleMesh,
    op: BooleanOp,
) -> Result<TriangleMesh, CsgError> {
    if a.is_empty() || b.is_empty() {
        return Ok(match op {
            BooleanOp::Union if a.is_empty() => b.clone(),
            BooleanOp::Union | BooleanOp::Subtract => a.clone(),
            BooleanOp::Intersect => TriangleMesh::empty(),
        });
    }
    let (ma, mb) = (to_manifold(a)?, to_manifold(b)?);
    let op = match op {
        BooleanOp::Union => OpType::Add,
        BooleanOp::Subtract => OpType::Subtract,
        BooleanOp::Intersect => OpType::Intersect,
    };
    match compute_boolean(&ma, &mb, op) {
        Ok(r) => Ok(from_manifold(&r)),
        // The kernel reports an empty result as an error.
        Err(e) if e.contains("empty") => Ok(TriangleMesh::empty()),
        Err(e) => Err(CsgError::Failed(e)),
    }
}

/// Enclosed volume of a closed mesh (divergence theorem).
pub fn mesh_volume(mesh: &TriangleMesh) -> f64 {
    let p = |i: u32| {
        let k = i as usize * 3;
        [
            mesh.positions[k] as f64,
            mesh.positions[k + 1] as f64,
            mesh.positions[k + 2] as f64,
        ]
    };
    mesh.indices
        .chunks(3)
        .map(|t| {
            let (a, b, c) = (p(t[0]), p(t[1]), p(t[2]));
            (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0])
                + a[2] * (b[0] * c[1] - b[1] * c[0]))
                / 6.0
        })
        .sum()
}

/// Axis-aligned box mesh (outward normals), handy for tools and tests.
pub fn box_mesh(min: [f32; 3], max: [f32; 3]) -> TriangleMesh {
    let c = |i: usize| {
        [
            if i & 1 == 0 { min[0] } else { max[0] },
            if i & 2 == 0 { min[1] } else { max[1] },
            if i & 4 == 0 { min[2] } else { max[2] },
        ]
    };
    // Quads (counter-clockwise seen from outside) and their normals.
    let faces: [([usize; 4], [f32; 3]); 6] = [
        ([0, 4, 6, 2], [-1.0, 0.0, 0.0]),
        ([1, 3, 7, 5], [1.0, 0.0, 0.0]),
        ([0, 1, 5, 4], [0.0, -1.0, 0.0]),
        ([2, 6, 7, 3], [0.0, 1.0, 0.0]),
        ([0, 2, 3, 1], [0.0, 0.0, -1.0]),
        ([4, 5, 7, 6], [0.0, 0.0, 1.0]),
    ];
    let mut m = TriangleMesh::empty();
    for (q, n) in faces {
        m.push_triangle(c(q[0]), c(q[1]), c(q[2]), n);
        m.push_triangle(c(q[0]), c(q[2]), c(q[3]), n);
    }
    for (a, b) in [
        (0, 1),
        (2, 3),
        (4, 5),
        (6, 7),
        (0, 2),
        (1, 3),
        (4, 6),
        (5, 7),
        (0, 4),
        (1, 5),
        (2, 6),
        (3, 7),
    ] {
        m.push_edge(c(a), c(b));
    }
    m
}

/// Closed vertical cylinder (axis along +Y) with `segments` sides.
pub fn cylinder_mesh(center: [f32; 3], radius: f32, height: f32, segments: usize) -> TriangleMesh {
    let mut m = TriangleMesh::empty();
    let n = segments.max(3);
    let pt = |i: usize, y: f32| {
        let a = std::f32::consts::TAU * (i % n) as f32 / n as f32;
        [
            center[0] + radius * a.cos(),
            y,
            center[2] + radius * a.sin(),
        ]
    };
    let (y0, y1) = (center[1], center[1] + height);
    for i in 0..n {
        let (a0, a1, b0, b1) = (pt(i, y0), pt(i + 1, y0), pt(i, y1), pt(i + 1, y1));
        let mid = std::f32::consts::TAU * (i as f32 + 0.5) / n as f32;
        let nr = [mid.cos(), 0.0, mid.sin()];
        m.push_triangle(a0, b0, a1, nr);
        m.push_triangle(a1, b0, b1, nr);
        m.push_triangle([center[0], y0, center[2]], a0, a1, [0.0, -1.0, 0.0]);
        m.push_triangle([center[0], y1, center[2]], b1, b0, [0.0, 1.0, 0.0]);
    }
    m
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::prism::is_watertight;

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-4 * b.abs().max(1.0)
    }

    #[test]
    fn primitives_are_closed_with_positive_volume() {
        let b = box_mesh([0.0; 3], [1.0, 2.0, 3.0]);
        assert!(is_watertight(&b));
        assert!(close(mesh_volume(&b), 6.0));
        let c = cylinder_mesh([0.0; 3], 1.0, 2.0, 32);
        assert!(is_watertight(&c));
        assert!(mesh_volume(&c) > 0.0);
    }

    #[test]
    fn box_minus_box_has_exact_volume() {
        let a = box_mesh([0.0; 3], [2.0, 2.0, 2.0]);
        let b = box_mesh([1.0, 1.0, 1.0], [3.0, 3.0, 3.0]);
        let r = mesh_boolean(&a, &b, BooleanOp::Subtract).unwrap();
        assert!(is_watertight(&r));
        assert!(close(mesh_volume(&r), 7.0), "{}", mesh_volume(&r));
        let i = mesh_boolean(&a, &b, BooleanOp::Intersect).unwrap();
        assert!(close(mesh_volume(&i), 1.0));
        let u = mesh_boolean(&a, &b, BooleanOp::Union).unwrap();
        assert!(is_watertight(&u));
        assert!(close(mesh_volume(&u), 15.0));
        assert!(!r.edges.is_empty());
    }

    #[test]
    fn through_hole_box_minus_box() {
        // A wall with a window punched clean through: reveal faces, genus 1.
        let wall = box_mesh([0.0, 0.0, 0.0], [4.0, 3.0, 0.2]);
        let hole = box_mesh([1.0, 1.0, -0.5], [2.0, 2.0, 0.7]);
        let r = mesh_boolean(&wall, &hole, BooleanOp::Subtract).unwrap();
        assert!(is_watertight(&r));
        assert!(close(mesh_volume(&r), 4.0 * 3.0 * 0.2 - 0.2));
    }

    #[test]
    fn coplanar_union_merges_into_one_solid() {
        // Face-sharing and coplanar-top boxes.
        let a = box_mesh([0.0; 3], [1.0, 1.0, 1.0]);
        let b = box_mesh([1.0, 0.0, 0.0], [2.0, 1.0, 1.0]);
        let u = mesh_boolean(&a, &b, BooleanOp::Union).unwrap();
        assert!(is_watertight(&u));
        assert!(close(mesh_volume(&u), 2.0));
        let c = box_mesh([0.5, 0.0, 0.0], [1.5, 1.0, 1.0]);
        let u2 = mesh_boolean(&u, &c, BooleanOp::Union).unwrap();
        assert!(is_watertight(&u2));
        assert!(close(mesh_volume(&u2), 2.0));
        let s = mesh_boolean(&u, &c, BooleanOp::Subtract).unwrap();
        assert!(is_watertight(&s));
        assert!(close(mesh_volume(&s), 1.0));
    }

    #[test]
    fn cylinder_minus_box_matches_polygon_volume() {
        let n = 48;
        let cyl = cylinder_mesh([0.0; 3], 1.0, 2.0, n);
        let full = mesh_volume(&cyl);
        let expected = 0.5 * n as f64 * (std::f64::consts::TAU / n as f64).sin() * 2.0;
        assert!(close(full, expected));
        // Remove the half with x > 0 (the box covers the cylinder's whole height).
        let cut = box_mesh([0.0, -1.0, -2.0], [2.0, 3.0, 2.0]);
        let r = mesh_boolean(&cyl, &cut, BooleanOp::Subtract).unwrap();
        assert!(is_watertight(&r));
        assert!(
            close(mesh_volume(&r), expected / 2.0),
            "{}",
            mesh_volume(&r)
        );
    }

    #[test]
    fn sloped_roof_clips_a_wall() {
        // Wall 4 x 4 x 0.2; roof half-space below the plane y = 2 + 0.5 x.
        let wall = box_mesh([0.0, 0.0, 0.0], [4.0, 4.0, 0.2]);
        let mut keep = TriangleMesh::empty();
        let (z0, z1) = (-1.0_f32, 1.0_f32);
        let pts = [[-1.0_f32, -1.0], [5.0, -1.0], [5.0, 4.5], [-1.0, 1.5]];
        // Prism over the (x, y) polygon, extruded in z.
        let n = |a: [f32; 2], b: [f32; 2]| {
            let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
            let l = (dx * dx + dy * dy).sqrt();
            [dy / l, -dx / l, 0.0]
        };
        for i in 0..4 {
            let (a, b) = (pts[i], pts[(i + 1) % 4]);
            let nn = n(a, b);
            keep.push_triangle([a[0], a[1], z0], [b[0], b[1], z0], [b[0], b[1], z1], nn);
            keep.push_triangle([a[0], a[1], z0], [b[0], b[1], z1], [a[0], a[1], z1], nn);
        }
        let p = |i: usize, z: f32| [pts[i][0], pts[i][1], z];
        keep.push_triangle(p(0, z0), p(2, z0), p(1, z0), [0.0, 0.0, -1.0]);
        keep.push_triangle(p(0, z0), p(3, z0), p(2, z0), [0.0, 0.0, -1.0]);
        keep.push_triangle(p(0, z1), p(1, z1), p(2, z1), [0.0, 0.0, 1.0]);
        keep.push_triangle(p(0, z1), p(2, z1), p(3, z1), [0.0, 0.0, 1.0]);
        assert!(is_watertight(&keep) && mesh_volume(&keep) > 0.0);
        let r = mesh_boolean(&wall, &keep, BooleanOp::Intersect).unwrap();
        assert!(is_watertight(&r));
        // Trapezoid x in [0,4]: height 2 + 0.5x -> area = 4*2 + 0.5*8 = 12.
        assert!(close(mesh_volume(&r), 12.0 * 0.2), "{}", mesh_volume(&r));
    }

    #[test]
    fn disjoint_and_empty_operands() {
        let a = box_mesh([0.0; 3], [1.0; 3]);
        let b = box_mesh([5.0; 3], [6.0; 3]);
        let u = mesh_boolean(&a, &b, BooleanOp::Union).unwrap();
        assert!(close(mesh_volume(&u), 2.0));
        let i = mesh_boolean(&a, &b, BooleanOp::Intersect).unwrap();
        assert!(i.is_empty() || mesh_volume(&i).abs() < 1e-9);
        let e = TriangleMesh::empty();
        assert!(close(
            mesh_volume(&mesh_boolean(&a, &e, BooleanOp::Subtract).unwrap()),
            1.0
        ));
    }
}
