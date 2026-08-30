use std::f32::consts::TAU;

use serde::{Deserialize, Serialize};

use crate::error::GeometryError;

/// A point in profile space (local XY of a [`Frame`](crate::Frame)).
pub type Point2 = [f32; 2];

/// Where the driving curve or point sits relative to the profile's bounding box.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Justification {
    /// Bounding box centered on the curve.
    #[default]
    Center,
    /// Horizontally centered, sitting on top of the curve. Walls and columns.
    BaseCenter,
    /// Horizontally centered, hanging below the curve. Beams.
    TopCenter,
}

/// Closed loops in profile space: the first is the outline, the rest are holes.
///
/// Loops are stored counter-clockwise so that outward normals are unambiguous.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Profile {
    loops: Vec<Vec<Point2>>,
}

impl Profile {
    /// Build from an outline plus optional holes, normalizing winding.
    pub fn new(outer: Vec<Point2>, holes: Vec<Vec<Point2>>) -> Result<Self, GeometryError> {
        if outer.len() < 3 {
            return Err(GeometryError::ProfileTooSmall(outer.len()));
        }
        if signed_area(&outer).abs() < 1e-9 {
            return Err(GeometryError::ProfileDegenerate);
        }

        let mut loops = Vec::with_capacity(1 + holes.len());
        loops.push(as_ccw(outer));
        for hole in holes {
            if hole.len() < 3 {
                return Err(GeometryError::ProfileTooSmall(hole.len()));
            }
            loops.push(as_ccw(hole));
        }
        Ok(Self { loops })
    }

    pub fn polygon(points: Vec<Point2>) -> Result<Self, GeometryError> {
        Self::new(points, Vec::new())
    }

    /// Axis-aligned rectangle centered on the origin.
    pub fn rectangle(width: f32, height: f32) -> Result<Self, GeometryError> {
        if width <= 0.0 {
            return Err(GeometryError::InvalidWidth(width));
        }
        if height <= 0.0 {
            return Err(GeometryError::InvalidHeight(height));
        }
        let (hw, hh) = (width * 0.5, height * 0.5);
        Self::polygon(vec![[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]])
    }

    /// Regular polygon approximating a circle, centered on the origin.
    pub fn circle(radius: f32, segments: u32) -> Result<Self, GeometryError> {
        if radius <= 0.0 {
            return Err(GeometryError::InvalidRadius(radius));
        }
        let n = segments.max(3);
        let points = (0..n)
            .map(|i| {
                let a = TAU * i as f32 / n as f32;
                [radius * a.cos(), radius * a.sin()]
            })
            .collect();
        Self::polygon(points)
    }

    pub fn outer(&self) -> &[Point2] {
        &self.loops[0]
    }

    pub fn holes(&self) -> &[Vec<Point2>] {
        &self.loops[1..]
    }

    pub fn has_holes(&self) -> bool {
        self.loops.len() > 1
    }

    /// `(min, max)` of the outline in profile space.
    pub fn bounds(&self) -> (Point2, Point2) {
        let mut min = self.loops[0][0];
        let mut max = min;
        for p in self.outer() {
            min[0] = min[0].min(p[0]);
            min[1] = min[1].min(p[1]);
            max[0] = max[0].max(p[0]);
            max[1] = max[1].max(p[1]);
        }
        (min, max)
    }

    pub fn translated(&self, du: f32, dv: f32) -> Self {
        Self {
            loops: self
                .loops
                .iter()
                .map(|l| l.iter().map(|p| [p[0] + du, p[1] + dv]).collect())
                .collect(),
        }
    }

    /// Reposition so the driving curve sits where `justification` says.
    pub fn justified(&self, justification: Justification) -> Self {
        let (min, max) = self.bounds();
        let center_u = -(min[0] + max[0]) * 0.5;
        let dv = match justification {
            Justification::Center => -(min[1] + max[1]) * 0.5,
            Justification::BaseCenter => -min[1],
            Justification::TopCenter => -max[1],
        };
        self.translated(center_u, dv)
    }

    /// Triangulate the outline into index triples over [`Profile::outer`].
    pub fn triangulate(&self) -> Result<Vec<[usize; 3]>, GeometryError> {
        if self.has_holes() {
            return Err(GeometryError::HolesUnsupported);
        }
        triangulate_ccw(self.outer())
    }
}

fn signed_area(points: &[Point2]) -> f32 {
    let n = points.len();
    let mut sum = 0.0;
    for i in 0..n {
        let a = points[i];
        let b = points[(i + 1) % n];
        sum += a[0] * b[1] - b[0] * a[1];
    }
    sum * 0.5
}

fn as_ccw(mut points: Vec<Point2>) -> Vec<Point2> {
    if signed_area(&points) < 0.0 {
        points.reverse();
    }
    points
}

/// Ear clipping over a simple counter-clockwise polygon.
pub(crate) fn triangulate_ccw(points: &[Point2]) -> Result<Vec<[usize; 3]>, GeometryError> {
    let n = points.len();
    if n < 3 {
        return Err(GeometryError::ProfileTooSmall(n));
    }
    if n == 3 {
        return Ok(vec![[0, 1, 2]]);
    }

    let mut remaining: Vec<usize> = (0..n).collect();
    let mut triangles = Vec::with_capacity(n - 2);

    while remaining.len() > 3 {
        let m = remaining.len();
        let mut clipped = None;

        for i in 0..m {
            let ia = remaining[(i + m - 1) % m];
            let ib = remaining[i];
            let ic = remaining[(i + 1) % m];
            let (a, b, c) = (points[ia], points[ib], points[ic]);

            // Convex corners only; a reflex corner cannot be an ear.
            if cross2(a, b, c) <= 0.0 {
                continue;
            }
            // An ear must not swallow any other vertex.
            if remaining
                .iter()
                .any(|&j| j != ia && j != ib && j != ic && point_in_triangle(points[j], a, b, c))
            {
                continue;
            }

            triangles.push([ia, ib, ic]);
            clipped = Some(i);
            break;
        }

        match clipped {
            Some(i) => {
                remaining.remove(i);
            }
            None => return Err(GeometryError::Triangulation),
        }
    }

    triangles.push([remaining[0], remaining[1], remaining[2]]);
    Ok(triangles)
}

/// Z of the cross product of `ab` and `bc`; positive means a left turn.
fn cross2(a: Point2, b: Point2, c: Point2) -> f32 {
    (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])
}

fn point_in_triangle(p: Point2, a: Point2, b: Point2, c: Point2) -> bool {
    let d1 = cross2(a, b, p);
    let d2 = cross2(b, c, p);
    let d3 = cross2(c, a, p);
    let has_neg = d1 < 0.0 || d2 < 0.0 || d3 < 0.0;
    let has_pos = d1 > 0.0 || d2 > 0.0 || d3 > 0.0;
    !(has_neg && has_pos)
}

#[cfg(test)]
mod tests {
    use super::*;

    const EPS: f32 = 1e-5;

    #[test]
    fn rectangle_is_centered_and_counter_clockwise() {
        let p = Profile::rectangle(2.0, 6.0).expect("profile");
        let (min, max) = p.bounds();
        assert_eq!(min, [-1.0, -3.0]);
        assert_eq!(max, [1.0, 3.0]);
        assert!(signed_area(p.outer()) > 0.0, "outline must be CCW");
        assert!((signed_area(p.outer()) - 12.0).abs() < EPS);
    }

    #[test]
    fn rectangle_rejects_non_positive_dimensions() {
        assert_eq!(
            Profile::rectangle(0.0, 1.0),
            Err(GeometryError::InvalidWidth(0.0))
        );
        assert_eq!(
            Profile::rectangle(1.0, -2.0),
            Err(GeometryError::InvalidHeight(-2.0))
        );
    }

    #[test]
    fn clockwise_input_is_flipped_to_counter_clockwise() {
        let cw = vec![[0.0, 0.0], [0.0, 1.0], [1.0, 1.0], [1.0, 0.0]];
        let p = Profile::polygon(cw).expect("profile");
        assert!(signed_area(p.outer()) > 0.0);
    }

    #[test]
    fn degenerate_and_tiny_profiles_are_rejected() {
        assert_eq!(
            Profile::polygon(vec![[0.0, 0.0], [1.0, 0.0]]),
            Err(GeometryError::ProfileTooSmall(2))
        );
        let collinear = vec![[0.0, 0.0], [1.0, 0.0], [2.0, 0.0]];
        assert_eq!(
            Profile::polygon(collinear),
            Err(GeometryError::ProfileDegenerate)
        );
    }

    #[test]
    fn circle_is_an_inscribed_polygon_converging_on_pi() {
        // An inscribed n-gon of radius r has area (n/2) r^2 sin(2 pi / n).
        let exact = |n: u32| 0.5 * n as f32 * (TAU / n as f32).sin();
        let coarse = signed_area(Profile::circle(1.0, 8).expect("profile").outer());
        let fine = signed_area(Profile::circle(1.0, 128).expect("profile").outer());

        assert!((coarse - exact(8)).abs() < EPS, "8-gon area {coarse}");
        assert!((fine - exact(128)).abs() < EPS, "128-gon area {fine}");
        // Always inscribed, so always under the true circle, and closing in on it.
        assert!(coarse < fine && fine < std::f32::consts::PI);
        assert!((std::f32::consts::PI - fine) < 2e-3);
    }

    #[test]
    fn circle_honours_radius_and_a_minimum_of_three_segments() {
        let p = Profile::circle(2.0, 1).expect("profile");
        assert_eq!(p.outer().len(), 3, "must not collapse below a triangle");
        let (min, max) = Profile::circle(2.0, 64).expect("profile").bounds();
        assert!((max[0] - 2.0).abs() < 1e-2 && (min[0] + 2.0).abs() < 1e-2);
    }

    #[test]
    fn base_center_justification_seats_the_profile_on_the_curve() {
        let p = Profile::rectangle(0.2, 3.0)
            .expect("profile")
            .justified(Justification::BaseCenter);
        let (min, max) = p.bounds();
        assert!((min[1] - 0.0).abs() < EPS, "base should sit at v=0");
        assert!((max[1] - 3.0).abs() < EPS);
        assert!((min[0] + 0.1).abs() < EPS, "should stay centered in u");
    }

    #[test]
    fn top_center_justification_hangs_the_profile_below_the_curve() {
        let p = Profile::rectangle(0.2, 3.0)
            .expect("profile")
            .justified(Justification::TopCenter);
        let (min, max) = p.bounds();
        assert!((max[1] - 0.0).abs() < EPS, "top should sit at v=0");
        assert!((min[1] + 3.0).abs() < EPS);
    }

    #[test]
    fn center_justification_leaves_a_centered_profile_alone() {
        let p = Profile::rectangle(2.0, 4.0).expect("profile");
        let j = p.justified(Justification::Center);
        assert_eq!(p.bounds(), j.bounds());
    }

    #[test]
    fn rectangle_triangulates_into_two_triangles() {
        let p = Profile::rectangle(1.0, 1.0).expect("profile");
        assert_eq!(p.triangulate().expect("tris").len(), 2);
    }

    #[test]
    fn concave_profile_triangulates_into_n_minus_two_triangles() {
        // An L shape: 6 vertices, one reflex corner.
        let l = vec![
            [0.0, 0.0],
            [3.0, 0.0],
            [3.0, 1.0],
            [1.0, 1.0],
            [1.0, 3.0],
            [0.0, 3.0],
        ];
        let p = Profile::polygon(l).expect("profile");
        let tris = p.triangulate().expect("tris");
        assert_eq!(tris.len(), 4, "n-2 triangles for n=6");

        // Triangulation must preserve the polygon's area.
        let outer = p.outer();
        let area: f32 = tris
            .iter()
            .map(|t| cross2(outer[t[0]], outer[t[1]], outer[t[2]]).abs() * 0.5)
            .sum();
        assert!((area - 5.0).abs() < 1e-3, "area was {area}");
    }

    #[test]
    fn profiles_with_holes_are_rejected_for_now() {
        let outer = vec![[0.0, 0.0], [4.0, 0.0], [4.0, 4.0], [0.0, 4.0]];
        let hole = vec![[1.0, 1.0], [2.0, 1.0], [2.0, 2.0], [1.0, 2.0]];
        let p = Profile::new(outer, vec![hole]).expect("profile");
        assert!(p.has_holes());
        assert_eq!(p.triangulate(), Err(GeometryError::HolesUnsupported));
    }
}
