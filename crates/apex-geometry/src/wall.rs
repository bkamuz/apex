//! Temporary bridge kept only until walls are registered as a component.
//!
//! It exists so the document model and the web app keep working while the
//! kernel underneath is replaced; the component registry deletes it.

use glam::Vec3;
use serde::{Deserialize, Serialize};

use crate::curve::Curve;
use crate::error::GeometryError;
use crate::profile::{Justification, Profile};
use crate::sweep::{sweep, SweepOptions};
use crate::TriangleMesh;

/// Parametric wall along a centerline. World axes: X right, Y up, Z depth.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WallParams {
    pub start: [f32; 3],
    pub end: [f32; 3],
    pub height: f32,
    pub thickness: f32,
}

impl WallParams {
    pub fn length(&self) -> f32 {
        let dx = self.end[0] - self.start[0];
        let dy = self.end[1] - self.start[1];
        let dz = self.end[2] - self.start[2];
        (dx * dx + dy * dy + dz * dz).sqrt()
    }
}

/// Build a wall as a rectangular profile swept along its centerline.
pub fn generate_wall_mesh(params: &WallParams) -> Result<TriangleMesh, GeometryError> {
    let profile = Profile::rectangle(params.thickness, params.height).map_err(|e| match e {
        GeometryError::InvalidWidth(w) => GeometryError::InvalidThickness(w),
        other => other,
    })?;

    // The centerline is horizontal; both ends seat on the lower elevation.
    let start = Vec3::from_array(params.start);
    let end = Vec3::from_array(params.end);
    let base = start.y.min(end.y);
    let path = Curve::line(
        Vec3::new(start.x, base, start.z),
        Vec3::new(end.x, base, end.z),
    );

    sweep(
        &profile,
        &path,
        &SweepOptions::with_justification(Justification::BaseCenter),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wall_along_x_has_twelve_triangles_and_edges() {
        let params = WallParams {
            start: [0.0, 0.0, 0.0],
            end: [5.0, 0.0, 0.0],
            height: 3.0,
            thickness: 0.2,
        };
        let mesh = generate_wall_mesh(&params).expect("mesh");
        assert_eq!(mesh.triangle_count(), 12);
        assert_eq!(mesh.vertex_count(), 36);
        assert_eq!(mesh.edge_count(), 12);
    }

    #[test]
    fn wall_along_x_aabb_matches_params() {
        let params = WallParams {
            start: [0.0, 0.0, 0.0],
            end: [5.0, 0.0, 0.0],
            height: 3.0,
            thickness: 0.2,
        };
        let mesh = generate_wall_mesh(&params).expect("mesh");
        let (min, max) = mesh.aabb().expect("aabb");
        let size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
        assert!((size[0] - 5.0).abs() < 1e-4, "length {}", size[0]);
        assert!((size[1] - 3.0).abs() < 1e-4, "height {}", size[1]);
        assert!((size[2] - 0.2).abs() < 1e-4, "thickness {}", size[2]);
        assert!(min[1].abs() < 1e-4, "base on ground {}", min[1]);
    }

    #[test]
    fn wall_along_z_aabb_matches_params() {
        let params = WallParams {
            start: [1.0, 0.0, 0.0],
            end: [1.0, 0.0, 4.0],
            height: 2.5,
            thickness: 0.3,
        };
        let mesh = generate_wall_mesh(&params).expect("mesh");
        let (min, max) = mesh.aabb().expect("aabb");
        let size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
        assert!((size[2] - 4.0).abs() < 1e-4, "length along z {}", size[2]);
        assert!((size[1] - 2.5).abs() < 1e-4, "height {}", size[1]);
        assert!((size[0] - 0.3).abs() < 1e-4, "thickness {}", size[0]);
    }

    #[test]
    fn normals_are_unit_length() {
        let params = WallParams {
            start: [0.0, 0.0, 0.0],
            end: [2.0, 0.0, 0.0],
            height: 3.0,
            thickness: 0.2,
        };
        let mesh = generate_wall_mesh(&params).expect("mesh");
        for n in mesh.normals.chunks_exact(3) {
            let len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
            assert!((len - 1.0).abs() < 1e-4, "normal len {len}");
        }
    }

    #[test]
    fn wall_along_z_rejects_zero_length() {
        let params = WallParams {
            start: [1.0, 0.0, 1.0],
            end: [1.0, 0.0, 1.0],
            height: 3.0,
            thickness: 0.2,
        };
        assert!(generate_wall_mesh(&params).is_err());
    }

    #[test]
    fn wall_rejects_non_positive_height_and_thickness() {
        let base = WallParams {
            start: [0.0, 0.0, 0.0],
            end: [4.0, 0.0, 0.0],
            height: 3.0,
            thickness: 0.2,
        };
        assert_eq!(
            generate_wall_mesh(&WallParams {
                height: 0.0,
                ..base.clone()
            })
            .unwrap_err(),
            GeometryError::InvalidHeight(0.0)
        );
        assert_eq!(
            generate_wall_mesh(&WallParams {
                thickness: -0.1,
                ..base
            })
            .unwrap_err(),
            GeometryError::InvalidThickness(-0.1)
        );
    }
}
