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

    /// Axis-aligned bounding box of positions: (min, max).
    pub fn aabb(&self) -> Option<([f32; 3], [f32; 3])> {
        if self.positions.len() < 3 {
            return None;
        }
        let mut min = [
            self.positions[0],
            self.positions[1],
            self.positions[2],
        ];
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
