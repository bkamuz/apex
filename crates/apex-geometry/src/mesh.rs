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

    /// Drop triangles that intersect any AABB void.
    ///
    /// A crude host-cut used until a full boolean solid engine lands: openings
    /// punch see-through voids in walls and slabs without CSG. Intersection
    /// (not centroid-in-box) matters because sweep meshes use large faces.
    pub fn punch_aabbs(&self, boxes: &[([f32; 3], [f32; 3])]) -> Self {
        if boxes.is_empty() || self.is_empty() {
            return self.clone();
        }
        let mut out = Self::empty();
        for tri in self.indices.chunks_exact(3) {
            let a = self.vertex(tri[0] as usize);
            let b = self.vertex(tri[1] as usize);
            let c = self.vertex(tri[2] as usize);
            if boxes
                .iter()
                .any(|(min, max)| triangle_hits_aabb(a, b, c, *min, *max))
            {
                continue;
            }
            let na = self.normal(tri[0] as usize);
            // Rebuild with the first vertex normal; host meshes are flat-shaded per tri.
            out.push_triangle(a, b, c, na);
        }
        // Keep edges that still have both endpoints outside every void.
        for edge in self.edges.chunks_exact(6) {
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
}

fn point_in_aabb(p: [f32; 3], min: [f32; 3], max: [f32; 3]) -> bool {
    p[0] >= min[0]
        && p[0] <= max[0]
        && p[1] >= min[1]
        && p[1] <= max[1]
        && p[2] >= min[2]
        && p[2] <= max[2]
}

fn triangle_hits_aabb(a: [f32; 3], b: [f32; 3], c: [f32; 3], min: [f32; 3], max: [f32; 3]) -> bool {
    // Any vertex inside, or the triangle's AABB overlaps the void.
    if point_in_aabb(a, min, max) || point_in_aabb(b, min, max) || point_in_aabb(c, min, max) {
        return true;
    }
    let tmin = [
        a[0].min(b[0]).min(c[0]),
        a[1].min(b[1]).min(c[1]),
        a[2].min(b[2]).min(c[2]),
    ];
    let tmax = [
        a[0].max(b[0]).max(c[0]),
        a[1].max(b[1]).max(c[1]),
        a[2].max(b[2]).max(c[2]),
    ];
    tmin[0] <= max[0]
        && tmax[0] >= min[0]
        && tmin[1] <= max[1]
        && tmax[1] >= min[1]
        && tmin[2] <= max[2]
        && tmax[2] >= min[2]
}

#[cfg(test)]
mod tests {
    use super::*;

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
