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
/// the centerline in XZ. This matches the parametric wall model and is the
/// CSG-extrude path we'll later route through csgrs for booleans.
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

    // Faces as quads (ccw outward): -Z, +Z, -Y, +Y, -X, +X in local framing
    // Using world corners indices:
    // 0:(-x,-y,-z) 1:(+x,-y,-z) 2:(+x,+y,-z) 3:(-x,+y,-z)
    // 4:(-x,-y,+z) 5:(+x,-y,+z) 6:(+x,+y,+z) 7:(-x,+y,+z)
    let faces: [( [usize; 4], Vec3 ); 6] = [
        ([0, 3, 2, 1], -right), // -Z local (thickness -)
        ([4, 5, 6, 7], right),  // +Z local
        ([0, 1, 5, 4], -up),    // bottom
        ([3, 7, 6, 2], up),     // top
        ([0, 4, 7, 3], -dir),   // start end
        ([1, 2, 6, 5], dir),    // finish end
    ];

    let mut mesh = TriangleMesh::empty();
    for (idx, normal) in faces {
        let n = normal.to_array();
        let a = corners[idx[0]].to_array();
        let b = corners[idx[1]].to_array();
        let c = corners[idx[2]].to_array();
        let d = corners[idx[3]].to_array();
        mesh.push_triangle(a, b, c, n);
        mesh.push_triangle(a, c, d, n);
    }

    Ok(mesh)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wall_along_x_has_twelve_triangles() {
        let params = WallParams {
            start: [0.0, 0.0, 0.0],
            end: [5.0, 0.0, 0.0],
            height: 3.0,
            thickness: 0.2,
        };
        let mesh = generate_wall_mesh(&params).expect("mesh");
        assert_eq!(mesh.triangle_count(), 12);
        assert_eq!(mesh.vertex_count(), 36);
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
