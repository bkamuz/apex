use apex_core::{TriangleMesh, WallParams};
use glam::Vec3;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum WallMeshError {
    #[error("wall length is too small ({0})")]
    DegenerateLength(f32),
    #[error("wall height must be positive ({0})")]
    InvalidHeight(f32),
    #[error("wall thickness must be positive ({0})")]
    InvalidThickness(f32),
}

/// Build a wall as an oriented box along start→end (Y-up world).
///
/// Profile is a rectangle in the wall's local YZ cross-section, extruded along
/// the centerline in XZ. Includes 12 unique CAD edges for overlay rendering.
pub fn generate_wall_mesh(params: &WallParams) -> Result<TriangleMesh, WallMeshError> {
    if params.height <= 0.0 {
        return Err(WallMeshError::InvalidHeight(params.height));
    }
    if params.thickness <= 0.0 {
        return Err(WallMeshError::InvalidThickness(params.thickness));
    }

    let start = Vec3::from_array(params.start);
    let end = Vec3::from_array(params.end);
    let mut dir = Vec3::new(end.x - start.x, 0.0, end.z - start.z);
    let length = dir.length();
    if length < 1e-4 {
        return Err(WallMeshError::DegenerateLength(length));
    }
    dir /= length;

    let up = Vec3::Y;
    let mut right = up.cross(dir);
    if right.length_squared() < 1e-8 {
        right = Vec3::X;
    } else {
        right = right.normalize();
    }
    // Re-orthogonalize
    let dir = right.cross(up).normalize();
    let right = up.cross(dir).normalize();

    let base_y = start.y.min(end.y);
    let origin = Vec3::new(
        (start.x + end.x) * 0.5,
        base_y + params.height * 0.5,
        (start.z + end.z) * 0.5,
    );

    let hx = length * 0.5;
    let hy = params.height * 0.5;
    let hz = params.thickness * 0.5;

    // 8 corners in local space, then map to world
    let local = [
        Vec3::new(-hx, -hy, -hz),
        Vec3::new(hx, -hy, -hz),
        Vec3::new(hx, hy, -hz),
        Vec3::new(-hx, hy, -hz),
        Vec3::new(-hx, -hy, hz),
        Vec3::new(hx, -hy, hz),
        Vec3::new(hx, hy, hz),
        Vec3::new(-hx, hy, hz),
    ];

    let to_world = |p: Vec3| origin + dir * p.x + up * p.y + right * p.z;
    let corners: [Vec3; 8] = std::array::from_fn(|i| to_world(local[i]));
    let ca = |i: usize| corners[i].to_array();

    // Faces as quads (ccw outward)
    let faces: [([usize; 4], Vec3); 6] = [
        ([0, 3, 2, 1], -right),
        ([4, 5, 6, 7], right),
        ([0, 1, 5, 4], -up),
        ([3, 7, 6, 2], up),
        ([0, 4, 7, 3], -dir),
        ([1, 2, 6, 5], dir),
    ];

    let mut mesh = TriangleMesh::empty();
    for (idx, normal) in faces {
        let n = normal.to_array();
        let a = ca(idx[0]);
        let b = ca(idx[1]);
        let c = ca(idx[2]);
        let d = ca(idx[3]);
        mesh.push_triangle(a, b, c, n);
        mesh.push_triangle(a, c, d, n);
    }

    // 12 unique box edges
    const EDGE_PAIRS: [[usize; 2]; 12] = [
        [0, 1],
        [1, 2],
        [2, 3],
        [3, 0],
        [4, 5],
        [5, 6],
        [6, 7],
        [7, 4],
        [0, 4],
        [1, 5],
        [2, 6],
        [3, 7],
    ];
    for [i, j] in EDGE_PAIRS {
        mesh.push_edge(ca(i), ca(j));
    }

    Ok(mesh)
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
}
