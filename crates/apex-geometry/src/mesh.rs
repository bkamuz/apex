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

    /// Axis-aligned bounding box of positions: (min, max).
    pub fn aabb(&self) -> Option<([f32; 3], [f32; 3])> {
        if self.positions.len() < 3 {
            return None;
        }
        let mut min = [self.positions[0], self.positions[1], self.positions[2]];
        let mut max = min;
        for chunk in self.positions.chunks_exact(3) {
            for i in 0..3 {
                min[i] = min[i].min(chunk[i]);
                max[i] = max[i].max(chunk[i]);
            }
        }
        Some((min, max))
    }
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
}
