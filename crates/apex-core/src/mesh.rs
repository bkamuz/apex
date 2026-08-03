use serde::{Deserialize, Serialize};

/// Flat triangle mesh ready for GPU upload.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TriangleMesh {
    /// Interleaved xyz positions (3 floats per vertex).
    pub positions: Vec<f32>,
    /// Interleaved xyz normals (3 floats per vertex).
    pub normals: Vec<f32>,
    /// Triangle indices.
    pub indices: Vec<u32>,
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

    pub fn push_triangle(&mut self, a: [f32; 3], b: [f32; 3], c: [f32; 3], normal: [f32; 3]) {
        let base = self.vertex_count() as u32;
        for p in [a, b, c] {
            self.positions.extend_from_slice(&p);
            self.normals.extend_from_slice(&normal);
        }
        self.indices.extend_from_slice(&[base, base + 1, base + 2]);
    }
}
