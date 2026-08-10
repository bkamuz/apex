use glam::Vec3;
use serde::{Deserialize, Serialize};

/// Orthonormal local basis.
///
/// One convention across the whole kernel: profiles live in the local **XY**
/// plane and sweeps/extrusions advance along local **Z**.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Frame {
    pub origin: Vec3,
    pub x: Vec3,
    pub y: Vec3,
    pub z: Vec3,
}

impl Frame {
    pub const fn new(origin: Vec3, x: Vec3, y: Vec3, z: Vec3) -> Self {
        Self { origin, x, y, z }
    }

    /// Horizontal work plane at `elevation`: local XY spans world XZ, local Z is world up.
    pub fn horizontal(elevation: f32) -> Self {
        Self {
            origin: Vec3::new(0.0, elevation, 0.0),
            x: Vec3::X,
            y: -Vec3::Z,
            z: Vec3::Y,
        }
    }

    /// Frame at `origin` with local Z along `dir` and local Y as close to world up as possible.
    ///
    /// Returns `None` when `dir` has no usable length.
    pub fn from_direction(origin: Vec3, dir: Vec3) -> Option<Self> {
        let z = dir.try_normalize()?;
        let x = Vec3::Y
            .cross(z)
            .try_normalize()
            .unwrap_or_else(|| Vec3::Z.cross(z).normalize());
        let y = z.cross(x);
        Some(Self { origin, x, y, z })
    }

    /// Frame whose local Z is `normal`, with a deterministic in-plane basis.
    pub fn from_normal(origin: Vec3, normal: Vec3) -> Option<Self> {
        let z = normal.try_normalize()?;
        let (x, y) = plane_basis(z);
        Some(Self { origin, x, y, z })
    }

    /// Rotate the in-plane axes by `angle` radians about local Z.
    pub fn rotated(&self, angle: f32) -> Self {
        let (s, c) = angle.sin_cos();
        Self {
            origin: self.origin,
            x: self.x * c + self.y * s,
            y: self.y * c - self.x * s,
            z: self.z,
        }
    }

    pub fn translated(&self, offset: Vec3) -> Self {
        Self {
            origin: self.origin + offset,
            ..*self
        }
    }

    pub fn with_origin(&self, origin: Vec3) -> Self {
        Self { origin, ..*self }
    }

    /// Map a profile-space point to world space.
    pub fn point(&self, u: f32, v: f32) -> Vec3 {
        self.origin + self.x * u + self.y * v
    }

    /// Map a profile-space direction to world space (ignores `origin`).
    pub fn direction(&self, u: f32, v: f32) -> Vec3 {
        self.x * u + self.y * v
    }
}

/// Deterministic pair of axes perpendicular to `normal`, right-handed with it.
pub(crate) fn plane_basis(normal: Vec3) -> (Vec3, Vec3) {
    let n = normal.normalize();
    let seed = if n.x.abs() < 0.9 { Vec3::X } else { Vec3::Y };
    let u = seed.cross(n).normalize();
    let v = n.cross(u);
    (u, v)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_right_handed(f: &Frame) {
        let cross = f.x.cross(f.y);
        assert!(
            (cross - f.z).length() < 1e-5,
            "x cross y should equal z, got {cross} vs {}",
            f.z
        );
        for axis in [f.x, f.y, f.z] {
            assert!((axis.length() - 1.0).abs() < 1e-5, "axis not unit: {axis}");
        }
    }

    #[test]
    fn horizontal_frame_is_right_handed_with_z_up() {
        let f = Frame::horizontal(2.5);
        assert_eq!(f.origin, Vec3::new(0.0, 2.5, 0.0));
        assert_eq!(f.z, Vec3::Y);
        assert_right_handed(&f);
    }

    #[test]
    fn from_direction_keeps_y_up_for_horizontal_paths() {
        let f = Frame::from_direction(Vec3::ZERO, Vec3::X).expect("frame");
        assert_eq!(f.z, Vec3::X);
        assert!(
            (f.y - Vec3::Y).length() < 1e-5,
            "y should be world up, got {}",
            f.y
        );
        assert_right_handed(&f);
    }

    #[test]
    fn from_direction_survives_a_vertical_path() {
        let f = Frame::from_direction(Vec3::ZERO, Vec3::Y).expect("frame");
        assert_eq!(f.z, Vec3::Y);
        assert_right_handed(&f);
    }

    #[test]
    fn from_direction_rejects_zero_length() {
        assert!(Frame::from_direction(Vec3::ZERO, Vec3::ZERO).is_none());
    }

    #[test]
    fn plane_basis_is_right_handed_for_every_axis() {
        for n in [Vec3::X, Vec3::Y, Vec3::Z, -Vec3::X, -Vec3::Y, -Vec3::Z] {
            let (u, v) = plane_basis(n);
            assert!(
                (u.cross(v) - n).length() < 1e-5,
                "basis not right-handed for {n}"
            );
            assert!(u.dot(n).abs() < 1e-5);
            assert!(v.dot(n).abs() < 1e-5);
        }
    }

    #[test]
    fn rotating_a_frame_preserves_the_normal_and_handedness() {
        let f = Frame::horizontal(0.0).rotated(std::f32::consts::FRAC_PI_3);
        assert!((f.z - Vec3::Y).length() < 1e-5);
        assert_right_handed(&f);
    }

    #[test]
    fn point_maps_profile_space_onto_the_plane() {
        let f = Frame::horizontal(1.0);
        assert_eq!(f.point(2.0, 3.0), Vec3::new(2.0, 1.0, -3.0));
    }
}
