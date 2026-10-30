use serde::{Deserialize, Serialize};

/// Flat triangle mesh ready for GPU upload, plus CAD edge segments.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TriangleMesh {
    /// Interleaved xyz positions (3 floats per vertex).
    pub positions: Vec<f32>,
    /// Interleaved xyz normals (3 floats per vertex).
    pub normals: Vec<f32>,
    /// Triangle indices.
    pub indices: Vec<u32>,
    /// Unique edge segments as consecutive point pairs (xyz, xyz, ...).
    pub edges: Vec<f32>,
}

impl TriangleMesh {
    pub fn empty() -> Self {
        Self::default()
    }

    pub fn vertex_count(&self) -> usize {
        self.positions.len() / 3
    }

    pub fn triangle_count(&self) -> usize {
        self.indices.len() / 3
    }

    pub fn edge_count(&self) -> usize {
        self.edges.len() / 6
    }

    pub fn push_triangle(&mut self, a: [f32; 3], b: [f32; 3], c: [f32; 3], normal: [f32; 3]) {
        let base = self.vertex_count() as u32;
        for p in [a, b, c] {
            self.positions.extend_from_slice(&p);
            self.normals.extend_from_slice(&normal);
        }
        self.indices.extend_from_slice(&[base, base + 1, base + 2]);
    }

    pub fn push_edge(&mut self, a: [f32; 3], b: [f32; 3]) {
        self.edges.extend_from_slice(&a);
        self.edges.extend_from_slice(&b);
    }

    /// Append another mesh, rebasing its indices.
    pub fn append(&mut self, other: &TriangleMesh) {
        let base = self.vertex_count() as u32;
        self.positions.extend_from_slice(&other.positions);
        self.normals.extend_from_slice(&other.normals);
        self.indices.extend(other.indices.iter().map(|i| i + base));
        self.edges.extend_from_slice(&other.edges);
    }

    pub fn is_empty(&self) -> bool {
        self.indices.is_empty()
    }

    /// Remove the parts of triangles inside any AABB void.
    ///
    /// A crude host-cut used until a full boolean solid engine lands: openings
    /// punch see-through voids in walls and slabs without CSG. Triangles are
    /// clipped to the box (not dropped whole) because hosts use large faces.
    pub fn punch_aabbs(&self, boxes: &[([f32; 3], [f32; 3])]) -> Self {
        if boxes.is_empty() || self.is_empty() {
            return self.clone();
        }
        let mut out = Self::empty();
        for tri in self.indices.as_chunks::<3>().0 {
            let a = self.vertex(tri[0] as usize);
            let b = self.vertex(tri[1] as usize);
            let c = self.vertex(tri[2] as usize);
            let na = self.normal(tri[0] as usize);
            // Clip the triangle against each void so only the covered part
            // goes: a big slab face keeps its surround around a stair hole.
            let mut pieces = vec![vec![a, b, c]];
            for (min, max) in boxes {
                let mut kept = Vec::new();
                for piece in pieces {
                    if !polygon_hits_aabb(&piece, *min, *max) {
                        kept.push(piece);
                        continue;
                    }
                    kept.extend(subtract_aabb(piece, *min, *max));
                }
                pieces = kept;
            }
            for piece in pieces {
                for i in 1..piece.len().saturating_sub(1) {
                    let (p, q, r) = (piece[0], piece[i], piece[i + 1]);
                    if triangle_area2(p, q, r) > 1e-10 {
                        // Rebuild with the first vertex normal; hosts are flat per tri.
                        out.push_triangle(p, q, r, na);
                    }
                }
            }
        }
        // Keep edges that still have both endpoints outside every void.
        for edge in self.edges.as_chunks::<6>().0 {
            let a = [edge[0], edge[1], edge[2]];
            let b = [edge[3], edge[4], edge[5]];
            let mid = [
                (a[0] + b[0]) * 0.5,
                (a[1] + b[1]) * 0.5,
                (a[2] + b[2]) * 0.5,
            ];
            if boxes
                .iter()
                .any(|(min, max)| point_in_aabb(mid, *min, *max))
            {
                continue;
            }
            out.push_edge(a, b);
        }
        out
    }

    fn vertex(&self, index: usize) -> [f32; 3] {
        let i = index * 3;
        [
            self.positions[i],
            self.positions[i + 1],
            self.positions[i + 2],
        ]
    }

    fn normal(&self, index: usize) -> [f32; 3] {
        let i = index * 3;
        [self.normals[i], self.normals[i + 1], self.normals[i + 2]]
    }

    /// Axis-aligned bounding box of positions: (min, max).
    pub fn aabb(&self) -> Option<([f32; 3], [f32; 3])> {
        if self.positions.len() < 3 {
            return None;
        }
        let mut min = [self.positions[0], self.positions[1], self.positions[2]];
        let mut max = min;
        for chunk in self.positions.as_chunks::<3>().0 {
            for i in 0..3 {
                min[i] = min[i].min(chunk[i]);
                max[i] = max[i].max(chunk[i]);
            }
        }
        Some((min, max))
    }

    /// Replace [`Self::edges`] with CAD feature edges.
    ///
    /// Welds coincident vertices (flat-shaded meshes split verts per face), then
    /// keeps an edge when it is on the mesh boundary or the dihedral angle
    /// between the two incident faces exceeds `sharp_radians`. Coplanar
    /// triangulation diagonals are dropped — that is what makes IFC Open
    /// readable instead of a black spaghetti wireframe.
    pub fn rebuild_feature_edges(&mut self, sharp_radians: f32) {
        self.edges.clear();
        if self.indices.len() < 3 || self.positions.len() < 9 {
            return;
        }
        const WELD: f32 = 1e-5;
        let mut map: std::collections::HashMap<(i64, i64, i64), u32> =
            std::collections::HashMap::new();
        let mut welded: Vec<[f32; 3]> = Vec::new();
        let mut remap = Vec::with_capacity(self.vertex_count());
        for p in self.positions.chunks(3) {
            let key = (
                (p[0] / WELD).round() as i64,
                (p[1] / WELD).round() as i64,
                (p[2] / WELD).round() as i64,
            );
            let id = *map.entry(key).or_insert_with(|| {
                let i = welded.len() as u32;
                welded.push([
                    key.0 as f32 * WELD,
                    key.1 as f32 * WELD,
                    key.2 as f32 * WELD,
                ]);
                i
            });
            remap.push(id);
        }

        let mut face_normals: Vec<[f32; 3]> = Vec::with_capacity(self.triangle_count());
        let mut faces: Vec<[u32; 3]> = Vec::with_capacity(self.triangle_count());
        for tri in self.indices.chunks(3) {
            if tri.len() < 3 {
                continue;
            }
            let a = remap[tri[0] as usize];
            let b = remap[tri[1] as usize];
            let c = remap[tri[2] as usize];
            if a == b || b == c || a == c {
                continue;
            }
            let pa = welded[a as usize];
            let pb = welded[b as usize];
            let pc = welded[c as usize];
            let u = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
            let v = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]];
            let n = [
                u[1] * v[2] - u[2] * v[1],
                u[2] * v[0] - u[0] * v[2],
                u[0] * v[1] - u[1] * v[0],
            ];
            let len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
            if len < 1e-12 {
                continue;
            }
            face_normals.push([n[0] / len, n[1] / len, n[2] / len]);
            faces.push([a, b, c]);
        }

        let cos_lim = sharp_radians.cos();
        // undirected edge → up to two incident face normals
        let mut edge_faces: std::collections::BTreeMap<(u32, u32), Vec<usize>> =
            std::collections::BTreeMap::new();
        for (fi, face) in faces.iter().enumerate() {
            for (i, j) in [(0, 1), (1, 2), (2, 0)] {
                let (a, b) = (face[i], face[j]);
                let key = if a < b { (a, b) } else { (b, a) };
                edge_faces.entry(key).or_default().push(fi);
            }
        }

        for ((a, b), faces_here) in edge_faces {
            let keep = match faces_here.as_slice() {
                [] => false,
                [_] => true, // boundary
                [i, j, ..] => {
                    let na = face_normals[*i];
                    let nb = face_normals[*j];
                    let d = na[0] * nb[0] + na[1] * nb[1] + na[2] * nb[2];
                    // Also drop near-coplanar pairs where float noise keeps
                    // |n| slightly off 1 (IFC face fans).
                    d < cos_lim
                        && (na[0] - nb[0]).abs() + (na[1] - nb[1]).abs() + (na[2] - nb[2]).abs()
                            > 1e-3
                }
            };
            if keep {
                self.push_edge(welded[a as usize], welded[b as usize]);
            }
        }
    }
}

fn polygon_hits_aabb(poly: &[[f32; 3]], min: [f32; 3], max: [f32; 3]) -> bool {
    (0..3).all(|axis| {
        let lo = poly.iter().map(|p| p[axis]).fold(f32::MAX, f32::min);
        let hi = poly.iter().map(|p| p[axis]).fold(f32::MIN, f32::max);
        hi > min[axis] && lo < max[axis]
    })
}

/// Split a convex polygon by the plane `p[axis] = value`: (below, above).
fn split_polygon(poly: &[[f32; 3]], axis: usize, value: f32) -> (Vec<[f32; 3]>, Vec<[f32; 3]>) {
    let mut below = Vec::new();
    let mut above = Vec::new();
    for i in 0..poly.len() {
        let p = poly[i];
        let q = poly[(i + 1) % poly.len()];
        let dp = p[axis] - value;
        let dq = q[axis] - value;
        if dp <= 0.0 {
            below.push(p);
        }
        if dp >= 0.0 {
            above.push(p);
        }
        if (dp < 0.0 && dq > 0.0) || (dp > 0.0 && dq < 0.0) {
            let t = dp / (dp - dq);
            let x = [
                p[0] + (q[0] - p[0]) * t,
                p[1] + (q[1] - p[1]) * t,
                p[2] + (q[2] - p[2]) * t,
            ];
            below.push(x);
            above.push(x);
        }
    }
    (below, above)
}

/// Convex pieces of `poly` lying outside the box.
fn subtract_aabb(poly: Vec<[f32; 3]>, min: [f32; 3], max: [f32; 3]) -> Vec<Vec<[f32; 3]>> {
    let mut outside = Vec::new();
    let mut rest = poly;
    for axis in 0..3 {
        let (below, above) = split_polygon(&rest, axis, min[axis]);
        if below.len() >= 3 {
            outside.push(below);
        }
        rest = above;
        if rest.len() < 3 {
            return outside;
        }
        let (below, above) = split_polygon(&rest, axis, max[axis]);
        if above.len() >= 3 {
            outside.push(above);
        }
        rest = below;
        if rest.len() < 3 {
            return outside;
        }
    }
    outside
}

fn triangle_area2(a: [f32; 3], b: [f32; 3], c: [f32; 3]) -> f32 {
    let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    let v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let n = [
        u[1] * v[2] - u[2] * v[1],
        u[2] * v[0] - u[0] * v[2],
        u[0] * v[1] - u[1] * v[0],
    ];
    n[0] * n[0] + n[1] * n[1] + n[2] * n[2]
}

fn point_in_aabb(p: [f32; 3], min: [f32; 3], max: [f32; 3]) -> bool {
    p[0] >= min[0]
        && p[0] <= max[0]
        && p[1] >= min[1]
        && p[1] <= max[1]
        && p[2] >= min[2]
        && p[2] <= max[2]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn feature_edges_keep_box_silhouette_not_face_diagonals() {
        // Unit cube as 12 triangles with split (flat-shaded) vertices — the
        // IFC import shape. Diagonals must disappear; 12 box edges remain.
        let mut m = TriangleMesh::empty();
        let faces = [
            (
                [[0., 0., 0.], [1., 0., 0.], [1., 1., 0.], [0., 1., 0.]],
                [0., 0., -1.],
            ),
            (
                [[0., 0., 1.], [0., 1., 1.], [1., 1., 1.], [1., 0., 1.]],
                [0., 0., 1.],
            ),
            (
                [[0., 0., 0.], [0., 0., 1.], [1., 0., 1.], [1., 0., 0.]],
                [0., -1., 0.],
            ),
            (
                [[0., 1., 0.], [1., 1., 0.], [1., 1., 1.], [0., 1., 1.]],
                [0., 1., 0.],
            ),
            (
                [[0., 0., 0.], [0., 1., 0.], [0., 1., 1.], [0., 0., 1.]],
                [-1., 0., 0.],
            ),
            (
                [[1., 0., 0.], [1., 0., 1.], [1., 1., 1.], [1., 1., 0.]],
                [1., 0., 0.],
            ),
        ];
        for (ring, n) in faces {
            m.push_triangle(ring[0], ring[1], ring[2], n);
            m.push_triangle(ring[0], ring[2], ring[3], n);
            // Pretend we wrongly stored every triangle edge (IFC decode bug).
            m.push_edge(ring[0], ring[1]);
            m.push_edge(ring[1], ring[2]);
            m.push_edge(ring[2], ring[0]);
            m.push_edge(ring[0], ring[2]);
            m.push_edge(ring[2], ring[3]);
            m.push_edge(ring[3], ring[0]);
        }
        assert!(m.edge_count() > 12);
        m.rebuild_feature_edges(0.70);
        assert_eq!(m.edge_count(), 12, "cube silhouette has 12 edges");
    }

    #[test]
    fn appending_rebases_indices_and_keeps_edges() {
        let mut a = TriangleMesh::empty();
        a.push_triangle([0.0; 3], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]);
        a.push_edge([0.0; 3], [1.0, 0.0, 0.0]);

        let mut b = TriangleMesh::empty();
        b.push_triangle([0.0; 3], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, 1.0, 0.0]);

        a.append(&b);

        assert_eq!(a.triangle_count(), 2);
        assert_eq!(a.vertex_count(), 6);
        assert_eq!(a.edge_count(), 1);
        assert_eq!(&a.indices[3..], &[3, 4, 5], "second mesh must be rebased");
    }

    #[test]
    fn punch_aabbs_drops_triangles_inside_the_void() {
        let mut mesh = TriangleMesh::empty();
        mesh.push_triangle(
            [0.0, 0.0, 0.0],
            [2.0, 0.0, 0.0],
            [0.0, 2.0, 0.0],
            [0.0, 0.0, 1.0],
        );
        mesh.push_triangle(
            [10.0, 0.0, 0.0],
            [12.0, 0.0, 0.0],
            [10.0, 2.0, 0.0],
            [0.0, 0.0, 1.0],
        );
        let punched = mesh.punch_aabbs(&[([-0.1, -0.1, -0.1], [3.0, 3.0, 3.0])]);
        assert_eq!(punched.triangle_count(), 1);
    }
}
