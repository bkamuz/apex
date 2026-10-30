//! Pluggable boolean kernels.
//!
//! [`GeometryKernel`] folds booleans over closed solids. [`MeshKernel`] is the
//! built-in mesh boolean (boolmesh). An exact BRep kernel (SMLib) plugs in
//! from outside: natively through the `apex-smlib` crate, in the browser
//! through a Web Worker. Both exchange solids as [`PlanarSolids`]: planar
//! polyhedra recovered from triangle meshes by merging coplanar triangles.

use std::collections::{BTreeMap, HashMap};

use crate::{mesh_boolean, BooleanOp, TriangleMesh};

/// Why a kernel produced no result.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum KernelError {
    /// The result is being computed elsewhere (e.g. in a worker); use a
    /// fallback for now.
    #[error("kernel result {0:x} pending")]
    Pending(u64),
    /// An operand is not a closed planar polyhedron the kernel accepts.
    #[error("unsupported input: {0}")]
    Unsupported(String),
    #[error("kernel failed: {0}")]
    Failed(String),
}

/// A boolean kernel: folds `tools` into `base` in order.
pub trait GeometryKernel: Send + Sync {
    fn name(&self) -> &'static str;

    fn combine(
        &self,
        base: &TriangleMesh,
        tools: &[(BooleanOp, &TriangleMesh)],
    ) -> Result<TriangleMesh, KernelError>;

    fn subtract_all(
        &self,
        base: &TriangleMesh,
        cuts: &[&TriangleMesh],
    ) -> Result<TriangleMesh, KernelError> {
        let tools: Vec<_> = cuts.iter().map(|c| (BooleanOp::Subtract, *c)).collect();
        self.combine(base, &tools)
    }
}

/// The built-in mesh boolean kernel.
#[derive(Debug, Default, Clone, Copy)]
pub struct MeshKernel;

impl GeometryKernel for MeshKernel {
    fn name(&self) -> &'static str {
        "mesh"
    }

    fn combine(
        &self,
        base: &TriangleMesh,
        tools: &[(BooleanOp, &TriangleMesh)],
    ) -> Result<TriangleMesh, KernelError> {
        let mut mesh = base.clone();
        for (op, tool) in tools {
            mesh =
                mesh_boolean(&mesh, tool, *op).map_err(|e| KernelError::Failed(e.to_string()))?;
        }
        Ok(mesh)
    }
}

/// Solids encoded for the C kernel bridge (`apex_sm_run`).
///
/// `points` holds xyz doubles shared by every solid. `ints` holds, per solid:
/// face count, then per face: loop count, then per loop: vertex count and
/// point indices (first loop outer). `ops[i]` combines solid `i` into the
/// running result (0 union, 1 difference, 2 intersection; `ops[0]` unused).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PlanarSolids {
    pub points: Vec<f64>,
    pub ints: Vec<i32>,
    pub ops: Vec<i32>,
    pub solids: usize,
}

impl PlanarSolids {
    /// Encode `base` followed by each tool.
    pub fn encode(
        base: &TriangleMesh,
        tools: &[(BooleanOp, &TriangleMesh)],
    ) -> Result<Self, KernelError> {
        let mut out = Self::default();
        out.push(base, 0)?;
        for (op, tool) in tools {
            let code = match op {
                BooleanOp::Union => 0,
                BooleanOp::Subtract => 1,
                BooleanOp::Intersect => 2,
            };
            out.push(tool, code)?;
        }
        Ok(out)
    }

    fn push(&mut self, mesh: &TriangleMesh, op: i32) -> Result<(), KernelError> {
        let faces = planar_faces(mesh)?;
        let base = (self.points.len() / 3) as i32;
        let (points, faces) = faces;
        self.points.extend(points);
        self.ints.push(faces.len() as i32);
        for face in faces {
            self.ints.push(face.len() as i32);
            for lp in face {
                self.ints.push(lp.len() as i32);
                self.ints.extend(lp.iter().map(|&i| base + i as i32));
            }
        }
        self.ops.push(op);
        self.solids += 1;
        Ok(())
    }

    /// Stable key of the encoded input (FNV-1a over the exact bits).
    pub fn key(&self) -> u64 {
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        let mut eat = |x: u64| {
            for b in x.to_le_bytes() {
                h ^= b as u64;
                h = h.wrapping_mul(0x100_0000_01b3);
            }
        };
        for p in &self.points {
            eat(p.to_bits());
        }
        for i in self.ints.iter().chain(&self.ops) {
            eat(*i as u64);
        }
        h
    }
}

const WELD: f64 = 1e-5;
const COPLANAR_DOT: f64 = 1.0 - 1e-6;
const COPLANAR_DIST: f64 = 1e-5;

type Faces = (Vec<f64>, Vec<Vec<Vec<usize>>>);

/// Recover planar faces (outer loop + holes, vertex indices into the returned
/// points) from a closed triangle mesh.
pub fn planar_faces(mesh: &TriangleMesh) -> Result<Faces, KernelError> {
    if mesh.is_empty() {
        return Err(KernelError::Unsupported("empty mesh".into()));
    }
    // Weld coincident vertices.
    let mut points: Vec<[f64; 3]> = Vec::new();
    let mut lookup: HashMap<[i64; 3], usize> = HashMap::new();
    let mut remap = Vec::with_capacity(mesh.vertex_count());
    for p in mesh.positions.chunks(3) {
        let q = [p[0] as f64, p[1] as f64, p[2] as f64];
        let k = q.map(|v| (v / WELD).round() as i64);
        let id = *lookup.entry(k).or_insert_with(|| {
            points.push(q);
            points.len() - 1
        });
        remap.push(id);
    }
    let mut tris: Vec<[usize; 3]> = Vec::new();
    for t in mesh.indices.chunks(3) {
        let t = [
            remap[t[0] as usize],
            remap[t[1] as usize],
            remap[t[2] as usize],
        ];
        if t[0] != t[1] && t[1] != t[2] && t[0] != t[2] {
            tris.push(t);
        }
    }
    let planes: Vec<([f64; 3], f64)> = tris
        .iter()
        .map(|t| {
            let (a, b, c) = (points[t[0]], points[t[1]], points[t[2]]);
            let n = normalize(cross(sub(b, a), sub(c, a)));
            (n, dot(n, a))
        })
        .collect();
    // Directed edge -> triangle; closedness check.
    let mut owner: HashMap<(usize, usize), usize> = HashMap::new();
    for (i, t) in tris.iter().enumerate() {
        for k in 0..3 {
            if owner.insert((t[k], t[(k + 1) % 3]), i).is_some() {
                return Err(KernelError::Unsupported("non-manifold edge".into()));
            }
        }
    }
    if owner.keys().any(|&(a, b)| !owner.contains_key(&(b, a))) {
        return Err(KernelError::Unsupported("open mesh".into()));
    }
    // Union coplanar neighbours.
    let mut parent: Vec<usize> = (0..tris.len()).collect();
    fn find(p: &mut [usize], mut x: usize) -> usize {
        while p[x] != x {
            p[x] = p[p[x]];
            x = p[x];
        }
        x
    }
    // Sorted edges and min-index roots: face grouping and order (and so the
    // encoded input, its key, and the kernel's tessellation) never depend
    // on hash iteration order.
    let mut edge_list: Vec<((usize, usize), usize)> = owner.iter().map(|(k, v)| (*k, *v)).collect();
    edge_list.sort_unstable();
    for &((a, b), i) in &edge_list {
        let j = owner[&(b, a)];
        let (pi, pj) = (planes[i], planes[j]);
        if dot(pi.0, pj.0) > COPLANAR_DOT && (pi.1 - pj.1).abs() < COPLANAR_DIST {
            let (ri, rj) = (find(&mut parent, i), find(&mut parent, j));
            if ri != rj {
                parent[ri.max(rj)] = ri.min(rj);
            }
        }
    }
    let mut groups: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
    for i in 0..tris.len() {
        let r = find(&mut parent, i);
        groups.entry(r).or_default().push(i);
    }
    let mut faces = Vec::new();
    for members in groups.values() {
        let n = planes[members[0]].0;
        let inside: std::collections::HashSet<usize> = members.iter().copied().collect();
        // Boundary half-edges: their twin lies in another face.
        let mut next: BTreeMap<usize, usize> = BTreeMap::new();
        for &i in members {
            let t = tris[i];
            for k in 0..3 {
                let (a, b) = (t[k], t[(k + 1) % 3]);
                if !inside.contains(&owner[&(b, a)]) && next.insert(a, b).is_some() {
                    return Err(KernelError::Unsupported("pinched face boundary".into()));
                }
            }
        }
        let mut loops: Vec<Vec<usize>> = Vec::new();
        while let Some((&start, _)) = next.iter().next() {
            let mut lp = vec![start];
            let mut cur = next.remove(&start).unwrap();
            while cur != start {
                lp.push(cur);
                cur = next
                    .remove(&cur)
                    .ok_or_else(|| KernelError::Unsupported("broken face loop".into()))?;
            }
            let lp = drop_collinear(&points, lp, n);
            if lp.len() >= 3 {
                loops.push(lp);
            }
        }
        // Outer loops wind CCW about the face normal; holes CW.
        let (u, v) = basis(n);
        let flat = |lp: &[usize]| -> Vec<[f64; 2]> {
            lp.iter()
                .map(|&i| [dot(points[i], u), dot(points[i], v)])
                .collect()
        };
        let (outers, holes): (Vec<_>, Vec<_>) =
            loops.into_iter().partition(|lp| area(&flat(lp)) > 0.0);
        let mut out: Vec<Vec<Vec<usize>>> = outers.into_iter().map(|o| vec![o]).collect();
        for h in holes {
            let probe = flat(&h)[0];
            let host = out
                .iter_mut()
                .find(|f| contains(&flat(&f[0]), probe))
                .ok_or_else(|| KernelError::Unsupported("hole outside its face".into()))?;
            host.push(h);
        }
        faces.extend(out);
    }
    Ok((points.into_iter().flatten().collect(), faces))
}

/// Drop vertices where the loop runs straight on. A vertex shared with a
/// neighbouring face's corner is kept: those are where three planes meet and
/// are never collinear on both faces.
fn drop_collinear(points: &[[f64; 3]], lp: Vec<usize>, _n: [f64; 3]) -> Vec<usize> {
    let len = lp.len();
    if len <= 3 {
        return lp;
    }
    let keep: Vec<usize> = (0..len)
        .filter(|&k| {
            let (a, b, c) = (
                points[lp[(k + len - 1) % len]],
                points[lp[k]],
                points[lp[(k + 1) % len]],
            );
            let x = cross(sub(b, a), sub(c, b));
            dot(x, x).sqrt() > 1e-9 * (len3(sub(b, a)) * len3(sub(c, b))).max(1e-30)
        })
        .map(|k| lp[k])
        .collect();
    if keep.len() >= 3 {
        keep
    } else {
        lp
    }
}

/// Indexed triangles from a kernel back into a render mesh with flat normals
/// and feature edges.
pub fn mesh_from_indexed(points: &[f64], tris: &[i32]) -> TriangleMesh {
    let p = |i: i32| {
        let k = i as usize * 3;
        [points[k], points[k + 1], points[k + 2]]
    };
    let f = |a: [f64; 3]| [a[0] as f32, a[1] as f32, a[2] as f32];
    let mut out = TriangleMesh::empty();
    let mut normals = Vec::with_capacity(tris.len() / 3);
    let mut edges: HashMap<(i32, i32), usize> = HashMap::new();
    for (ti, t) in tris.chunks(3).enumerate() {
        let n = normalize(cross(sub(p(t[1]), p(t[0])), sub(p(t[2]), p(t[0]))));
        out.push_triangle(f(p(t[0])), f(p(t[1])), f(p(t[2])), f(n));
        normals.push(n);
        for k in 0..3 {
            edges.insert((t[k], t[(k + 1) % 3]), ti);
        }
    }
    let cos_lim = 0.35f64.cos();
    let mut pairs: Vec<_> = edges.iter().filter(|((a, b), _)| a < b).collect();
    pairs.sort();
    for (&(a, b), &ti) in pairs {
        let bend = match edges.get(&(b, a)) {
            Some(&tj) => dot(normals[ti], normals[tj]) < cos_lim,
            None => true,
        };
        if bend {
            out.push_edge(f(p(a)), f(p(b)));
        }
    }
    out
}

fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}
fn len3(a: [f64; 3]) -> f64 {
    dot(a, a).sqrt()
}
fn normalize(a: [f64; 3]) -> [f64; 3] {
    let l = len3(a).max(1e-300);
    [a[0] / l, a[1] / l, a[2] / l]
}
fn basis(n: [f64; 3]) -> ([f64; 3], [f64; 3]) {
    let t = if n[0].abs() < 0.9 {
        [1.0, 0.0, 0.0]
    } else {
        [0.0, 1.0, 0.0]
    };
    let u = normalize(cross(n, t));
    (u, cross(n, u))
}
fn area(p: &[[f64; 2]]) -> f64 {
    (0..p.len())
        .map(|i| {
            let (a, b) = (p[i], p[(i + 1) % p.len()]);
            a[0] * b[1] - b[0] * a[1]
        })
        .sum::<f64>()
        / 2.0
}
fn contains(poly: &[[f64; 2]], q: [f64; 2]) -> bool {
    let mut inside = false;
    let mut j = poly.len() - 1;
    for i in 0..poly.len() {
        let (a, b) = (poly[i], poly[j]);
        if (a[1] > q[1]) != (b[1] > q[1])
            && q[0] < (b[0] - a[0]) * (q[1] - a[1]) / (b[1] - a[1]) + a[0]
        {
            inside = !inside;
        }
        j = i;
    }
    inside
}

/// Split a mesh into its connected shells (vertices welded), in order of
/// first triangle. Feature edges are dropped.
pub fn split_shells(mesh: &TriangleMesh) -> Vec<TriangleMesh> {
    let mut lookup: HashMap<[i64; 3], usize> = HashMap::new();
    let ids: Vec<usize> = mesh
        .positions
        .chunks(3)
        .map(|p| {
            let k = [p[0], p[1], p[2]].map(|v| (v as f64 / WELD).round() as i64);
            let n = lookup.len();
            *lookup.entry(k).or_insert(n)
        })
        .collect();
    let mut parent: Vec<usize> = (0..lookup.len()).collect();
    fn find(p: &mut [usize], mut x: usize) -> usize {
        while p[x] != x {
            p[x] = p[p[x]];
            x = p[x];
        }
        x
    }
    for t in mesh.indices.chunks(3) {
        let a = find(&mut parent, ids[t[0] as usize]);
        for &i in &t[1..] {
            let b = find(&mut parent, ids[i as usize]);
            parent[b] = a;
        }
    }
    let mut order: BTreeMap<usize, usize> = BTreeMap::new();
    let mut out: Vec<TriangleMesh> = Vec::new();
    for t in mesh.indices.chunks(3) {
        let root = find(&mut parent, ids[t[0] as usize]);
        let next = out.len();
        let k = *order.entry(root).or_insert(next);
        if k == out.len() {
            out.push(TriangleMesh::empty());
        }
        let v = |i: u32| {
            let i = i as usize * 3;
            [
                mesh.positions[i],
                mesh.positions[i + 1],
                mesh.positions[i + 2],
            ]
        };
        let n = {
            let i = t[0] as usize * 3;
            [mesh.normals[i], mesh.normals[i + 1], mesh.normals[i + 2]]
        };
        out[k].push_triangle(v(t[0]), v(t[1]), v(t[2]), n);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{box_mesh, mesh_volume};

    #[test]
    fn box_becomes_six_quads() {
        let (pts, faces) = planar_faces(&box_mesh([0.0; 3], [1.0, 2.0, 3.0])).unwrap();
        assert_eq!(pts.len(), 24);
        assert_eq!(faces.len(), 6);
        assert!(faces.iter().all(|f| f.len() == 1 && f[0].len() == 4));
    }

    #[test]
    fn wall_with_hole_has_holed_faces() {
        let wall = box_mesh([0.0; 3], [5.0, 3.0, 0.3]);
        let hole = box_mesh([1.9, 0.9, -0.1], [3.1, 2.3, 0.4]);
        let cut = MeshKernel.subtract_all(&wall, &[&hole]).unwrap();
        let (_, faces) = planar_faces(&cut).unwrap();
        // 6 outer faces (2 with a hole) + 4 reveal faces.
        assert_eq!(faces.len(), 10);
        assert_eq!(faces.iter().filter(|f| f.len() == 2).count(), 2);
        assert!((mesh_volume(&cut) - (4.5 - 1.2 * 1.4 * 0.3)).abs() < 1e-4);
    }

    #[test]
    fn encoding_is_deterministic() {
        let a = box_mesh([0.0; 3], [1.0; 3]);
        let b = box_mesh([0.5; 3], [2.0; 3]);
        let e1 = PlanarSolids::encode(&a, &[(BooleanOp::Subtract, &b)]).unwrap();
        let e2 = PlanarSolids::encode(&a, &[(BooleanOp::Subtract, &b)]).unwrap();
        assert_eq!(e1, e2);
        assert_eq!(e1.key(), e2.key());
        assert_eq!(e1.solids, 2);
        assert_eq!(e1.ops, vec![0, 1]);
    }

    #[test]
    fn indexed_roundtrip_keeps_volume() {
        let pts = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];
        let tris = [0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2];
        let m = mesh_from_indexed(&pts, &tris);
        assert!((mesh_volume(&m) - 1.0 / 6.0).abs() < 1e-6);
        assert_eq!(m.edge_count(), 6);
    }
}
