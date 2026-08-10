use glam::Vec3;

use crate::curve::Curve;
use crate::error::GeometryError;
use crate::frame::Frame;
use crate::mesh::TriangleMesh;
use crate::profile::{Justification, Point2, Profile};

const DEFAULT_TOLERANCE: f32 = 0.01;

#[derive(Debug, Clone, PartialEq)]
pub struct SweepOptions {
    pub justification: Justification,
    /// Lengthen the path before the start (negative shortens).
    pub start_extension: f32,
    /// Lengthen the path past the end (negative shortens).
    pub end_extension: f32,
    /// Chord tolerance for tessellating curved paths.
    pub tolerance: f32,
    /// Reference direction that keeps the profile's local Y upright.
    pub up: Vec3,
}

impl Default for SweepOptions {
    fn default() -> Self {
        Self {
            justification: Justification::Center,
            start_extension: 0.0,
            end_extension: 0.0,
            tolerance: DEFAULT_TOLERANCE,
            up: Vec3::Y,
        }
    }
}

impl SweepOptions {
    pub fn with_justification(justification: Justification) -> Self {
        Self {
            justification,
            ..Self::default()
        }
    }
}

/// Sweep a profile along a path. The profile stays perpendicular to the tangent.
pub fn sweep(
    profile: &Profile,
    path: &Curve,
    options: &SweepOptions,
) -> Result<TriangleMesh, GeometryError> {
    let path = path.extended(options.start_extension, options.end_extension)?;
    let length = path.length();
    if length < crate::curve::MIN_CURVE_LENGTH {
        return Err(GeometryError::DegenerateCurve(length));
    }

    let placed = profile.justified(options.justification);
    let frames = path
        .station_params(options.tolerance)
        .into_iter()
        .map(|t| path.frame_at(t, options.up))
        .collect::<Result<Vec<_>, _>>()?;

    build(&placed, &frames, path.is_closed())
}

/// Extrude a profile off its own plane along the frame's local Z.
pub fn extrude(
    profile: &Profile,
    base: &Frame,
    height: f32,
) -> Result<TriangleMesh, GeometryError> {
    if height <= 0.0 {
        return Err(GeometryError::InvalidHeight(height));
    }
    let top = base.translated(base.z * height);
    build(profile, &[*base, top], false)
}

/// Shared ring-and-cap builder for every swept solid.
fn build(
    profile: &Profile,
    frames: &[Frame],
    closed: bool,
) -> Result<TriangleMesh, GeometryError> {
    if profile.has_holes() {
        return Err(GeometryError::HolesUnsupported);
    }
    let outline = profile.outer();
    let corners = outline.len();
    if corners < 3 {
        return Err(GeometryError::ProfileTooSmall(corners));
    }
    let stations = frames.len();
    if stations < 2 {
        return Err(GeometryError::NotEnoughStations);
    }

    let rings: Vec<Vec<Vec3>> = frames
        .iter()
        .map(|f| outline.iter().map(|p| f.point(p[0], p[1])).collect())
        .collect();

    let mut mesh = TriangleMesh::empty();
    let spans = if closed { stations } else { stations - 1 };

    for i in 0..spans {
        let next = (i + 1) % stations;
        for j in 0..corners {
            let j1 = (j + 1) % corners;
            let normal = side_normal(outline, j, &frames[i], &frames[next]);
            let (a, b) = (rings[i][j], rings[i][j1]);
            let (c, d) = (rings[next][j1], rings[next][j]);
            mesh.push_triangle(a.to_array(), b.to_array(), c.to_array(), normal);
            mesh.push_triangle(a.to_array(), c.to_array(), d.to_array(), normal);
        }
    }

    if !closed {
        let triangles = profile.triangulate()?;
        let last = stations - 1;

        // Start cap faces backwards, so its winding is reversed.
        let start_normal = (-frames[0].z).to_array();
        for t in &triangles {
            let (a, b, c) = (rings[0][t[0]], rings[0][t[1]], rings[0][t[2]]);
            mesh.push_triangle(a.to_array(), c.to_array(), b.to_array(), start_normal);
        }

        let end_normal = frames[last].z.to_array();
        for t in &triangles {
            let (a, b, c) = (rings[last][t[0]], rings[last][t[1]], rings[last][t[2]]);
            mesh.push_triangle(a.to_array(), b.to_array(), c.to_array(), end_normal);
        }
    }

    push_edges(&mut mesh, &rings, corners, stations, closed, spans);
    Ok(mesh)
}

/// CAD overlay lines: the profile outline at each open end, plus rails along the path.
fn push_edges(
    mesh: &mut TriangleMesh,
    rings: &[Vec<Vec3>],
    corners: usize,
    stations: usize,
    closed: bool,
    spans: usize,
) {
    if !closed {
        for ring in [&rings[0], &rings[stations - 1]] {
            for j in 0..corners {
                let j1 = (j + 1) % corners;
                mesh.push_edge(ring[j].to_array(), ring[j1].to_array());
            }
        }
    }
    for j in 0..corners {
        for i in 0..spans {
            let next = (i + 1) % stations;
            mesh.push_edge(rings[i][j].to_array(), rings[next][j].to_array());
        }
    }
}

/// Outward normal of side face `j`, averaged across the two stations it spans.
fn side_normal(outline: &[Point2], j: usize, a: &Frame, b: &Frame) -> [f32; 3] {
    let corners = outline.len();
    let p = outline[j];
    let q = outline[(j + 1) % corners];
    let (du, dv) = (q[0] - p[0], q[1] - p[1]);
    let len = (du * du + dv * dv).sqrt();
    // For a CCW outline the outward normal of an edge is the edge rotated -90 degrees.
    let (nu, nv) = if len > 1e-9 {
        (dv / len, -du / len)
    } else {
        (1.0, 0.0)
    };

    let first = a.direction(nu, nv);
    let second = b.direction(nu, nv);
    (first + second)
        .try_normalize()
        .or_else(|| first.try_normalize())
        .unwrap_or(Vec3::Y)
        .to_array()
}

#[cfg(test)]
mod tests {
    use super::*;

    const EPS: f32 = 1e-4;

    fn size_of(mesh: &TriangleMesh) -> [f32; 3] {
        let (min, max) = mesh.aabb().expect("aabb");
        [max[0] - min[0], max[1] - min[1], max[2] - min[2]]
    }

    fn assert_unit_normals(mesh: &TriangleMesh) {
        for n in mesh.normals.chunks_exact(3) {
            let len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
            assert!((len - 1.0).abs() < EPS, "normal length {len}");
        }
    }

    #[test]
    fn sweeping_a_rectangle_along_a_line_makes_a_box() {
        let profile = Profile::rectangle(0.2, 3.0).expect("profile");
        let path = Curve::line(Vec3::ZERO, Vec3::new(5.0, 0.0, 0.0));
        let mesh = sweep(
            &profile,
            &path,
            &SweepOptions::with_justification(Justification::BaseCenter),
        )
        .expect("mesh");

        // 4 side quads (8 triangles) plus 2 triangles per cap.
        assert_eq!(mesh.triangle_count(), 12);
        assert_eq!(mesh.vertex_count(), 36);
        // Outline at both ends plus one rail per corner.
        assert_eq!(mesh.edge_count(), 12);

        let size = size_of(&mesh);
        assert!((size[0] - 5.0).abs() < EPS, "length {}", size[0]);
        assert!((size[1] - 3.0).abs() < EPS, "height {}", size[1]);
        assert!((size[2] - 0.2).abs() < EPS, "thickness {}", size[2]);
        assert_unit_normals(&mesh);
    }

    #[test]
    fn base_center_seats_the_sweep_on_the_path() {
        let profile = Profile::rectangle(0.2, 3.0).expect("profile");
        let path = Curve::line(Vec3::new(0.0, 2.0, 0.0), Vec3::new(4.0, 2.0, 0.0));
        let mesh = sweep(
            &profile,
            &path,
            &SweepOptions::with_justification(Justification::BaseCenter),
        )
        .expect("mesh");

        let (min, max) = mesh.aabb().expect("aabb");
        assert!((min[1] - 2.0).abs() < EPS, "base should sit on the path");
        assert!((max[1] - 5.0).abs() < EPS);
    }

    #[test]
    fn top_center_hangs_the_sweep_below_the_path() {
        let profile = Profile::rectangle(0.3, 0.5).expect("profile");
        let path = Curve::line(Vec3::new(0.0, 3.0, 0.0), Vec3::new(4.0, 3.0, 0.0));
        let mesh = sweep(
            &profile,
            &path,
            &SweepOptions::with_justification(Justification::TopCenter),
        )
        .expect("mesh");

        let (min, max) = mesh.aabb().expect("aabb");
        assert!((max[1] - 3.0).abs() < EPS, "top should sit on the path");
        assert!((min[1] - 2.5).abs() < EPS);
    }

    #[test]
    fn a_sweep_along_z_swaps_length_and_thickness_axes() {
        let profile = Profile::rectangle(0.3, 2.5).expect("profile");
        let path = Curve::line(Vec3::new(1.0, 0.0, 0.0), Vec3::new(1.0, 0.0, 4.0));
        let mesh = sweep(
            &profile,
            &path,
            &SweepOptions::with_justification(Justification::BaseCenter),
        )
        .expect("mesh");

        let size = size_of(&mesh);
        assert!((size[2] - 4.0).abs() < EPS, "length along z {}", size[2]);
        assert!((size[1] - 2.5).abs() < EPS, "height {}", size[1]);
        assert!((size[0] - 0.3).abs() < EPS, "thickness {}", size[0]);
    }

    #[test]
    fn side_normals_point_away_from_the_centerline() {
        let profile = Profile::rectangle(0.4, 2.0).expect("profile");
        let path = Curve::line(Vec3::ZERO, Vec3::new(6.0, 0.0, 0.0));
        let mesh = sweep(
            &profile,
            &path,
            &SweepOptions::with_justification(Justification::BaseCenter),
        )
        .expect("mesh");

        // Sample each triangle: the normal must face away from the solid's center.
        let (min, max) = mesh.aabb().expect("aabb");
        let center = Vec3::new(
            (min[0] + max[0]) * 0.5,
            (min[1] + max[1]) * 0.5,
            (min[2] + max[2]) * 0.5,
        );
        for t in 0..mesh.triangle_count() {
            let i = t * 9;
            let p = Vec3::new(
                mesh.positions[i],
                mesh.positions[i + 1],
                mesh.positions[i + 2],
            );
            let n = Vec3::new(mesh.normals[i], mesh.normals[i + 1], mesh.normals[i + 2]);
            assert!(
                (p - center).dot(n) > 0.0,
                "triangle {t} normal points inward"
            );
        }
    }

    #[test]
    fn sweeping_along_an_arc_adds_stations_and_stays_on_the_circle() {
        let profile = Profile::rectangle(0.2, 3.0).expect("profile");
        let arc = Curve::arc_from_three_points(
            Vec3::new(5.0, 0.0, 0.0),
            Vec3::new(0.0, 0.0, 5.0),
            Vec3::new(-5.0, 0.0, 0.0),
        )
        .expect("arc");
        let mesh = sweep(
            &profile,
            &arc,
            &SweepOptions::with_justification(Justification::BaseCenter),
        )
        .expect("mesh");

        assert!(
            mesh.triangle_count() > 12,
            "a curved sweep needs more than a box"
        );
        let (min, max) = mesh.aabb().expect("aabb");
        assert!((min[1] - 0.0).abs() < EPS, "arc wall should sit on y=0");
        assert!((max[1] - 3.0).abs() < EPS);
        // Radius 5 plus half of the 0.2 thickness.
        assert!((max[0] - 5.1).abs() < 1e-2, "outer radius {}", max[0]);
        assert_unit_normals(&mesh);
    }

    #[test]
    fn a_closed_path_produces_no_caps() {
        let profile = Profile::rectangle(0.2, 1.0).expect("profile");
        let circle = Curve::Circle {
            center: Vec3::ZERO,
            normal: Vec3::Y,
            radius: 4.0,
        };
        let open = Curve::arc_from_three_points(
            Vec3::new(4.0, 0.0, 0.0),
            Vec3::new(0.0, 0.0, 4.0),
            Vec3::new(-4.0, 0.0, 0.0),
        )
        .expect("arc");

        let closed_mesh = sweep(&profile, &circle, &SweepOptions::default()).expect("mesh");
        let open_mesh = sweep(&profile, &open, &SweepOptions::default()).expect("mesh");

        // Every triangle of the closed ring is a side face: 4 corners x 2 per quad.
        assert_eq!(closed_mesh.triangle_count() % 8, 0);
        // The open arc carries 2 extra triangles per cap.
        assert_eq!(open_mesh.triangle_count() % 8, 4);
    }

    #[test]
    fn extensions_lengthen_the_result() {
        let profile = Profile::rectangle(0.2, 3.0).expect("profile");
        let path = Curve::line(Vec3::ZERO, Vec3::new(5.0, 0.0, 0.0));
        let mesh = sweep(
            &profile,
            &path,
            &SweepOptions {
                justification: Justification::BaseCenter,
                start_extension: 1.0,
                end_extension: 2.0,
                ..SweepOptions::default()
            },
        )
        .expect("mesh");

        let (min, max) = mesh.aabb().expect("aabb");
        assert!((min[0] + 1.0).abs() < EPS, "start {}", min[0]);
        assert!((max[0] - 7.0).abs() < EPS, "end {}", max[0]);
    }

    #[test]
    fn a_degenerate_path_is_rejected() {
        let profile = Profile::rectangle(0.2, 3.0).expect("profile");
        let path = Curve::line(Vec3::ONE, Vec3::ONE);
        assert!(matches!(
            sweep(&profile, &path, &SweepOptions::default()),
            Err(GeometryError::DegenerateCurve(_))
        ));
    }

    #[test]
    fn extruding_a_rectangle_makes_an_upright_box() {
        let profile = Profile::rectangle(0.4, 0.6).expect("profile");
        let frame = Frame::horizontal(0.0);
        let mesh = extrude(&profile, &frame, 3.0).expect("mesh");

        assert_eq!(mesh.triangle_count(), 12);
        let size = size_of(&mesh);
        assert!((size[0] - 0.4).abs() < EPS, "x {}", size[0]);
        assert!((size[1] - 3.0).abs() < EPS, "height {}", size[1]);
        assert!((size[2] - 0.6).abs() < EPS, "z {}", size[2]);

        let (min, _) = mesh.aabb().expect("aabb");
        assert!((min[1] - 0.0).abs() < EPS, "should stand on the frame");
        assert_unit_normals(&mesh);
    }

    #[test]
    fn extruding_a_circle_makes_a_round_column() {
        let profile = Profile::circle(0.5, 32).expect("profile");
        let mesh = extrude(&profile, &Frame::horizontal(2.0), 4.0).expect("mesh");

        let size = size_of(&mesh);
        assert!((size[0] - 1.0).abs() < 1e-2, "diameter {}", size[0]);
        assert!((size[1] - 4.0).abs() < EPS, "height {}", size[1]);

        let (min, max) = mesh.aabb().expect("aabb");
        assert!((min[1] - 2.0).abs() < EPS, "base at the frame elevation");
        assert!((max[1] - 6.0).abs() < EPS);
    }

    #[test]
    fn extruding_a_rotated_frame_turns_the_profile() {
        let profile = Profile::rectangle(2.0, 0.2).expect("profile");
        let straight = extrude(&profile, &Frame::horizontal(0.0), 1.0).expect("mesh");
        let turned = extrude(
            &profile,
            &Frame::horizontal(0.0).rotated(std::f32::consts::FRAC_PI_2),
            1.0,
        )
        .expect("mesh");

        let a = size_of(&straight);
        let b = size_of(&turned);
        assert!((a[0] - 2.0).abs() < EPS && (a[2] - 0.2).abs() < EPS);
        assert!(
            (b[0] - 0.2).abs() < EPS && (b[2] - 2.0).abs() < EPS,
            "a quarter turn should swap the footprint, got {b:?}"
        );
    }

    #[test]
    fn extrusion_rejects_a_non_positive_height() {
        let profile = Profile::rectangle(1.0, 1.0).expect("profile");
        assert_eq!(
            extrude(&profile, &Frame::horizontal(0.0), 0.0).unwrap_err(),
            GeometryError::InvalidHeight(0.0)
        );
    }
}
