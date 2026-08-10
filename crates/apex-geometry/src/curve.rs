use std::f32::consts::TAU;

use glam::Vec3;
use serde::{Deserialize, Serialize};

use crate::error::GeometryError;
use crate::frame::{plane_basis, Frame};

/// Below this length a curve cannot define a direction.
pub const MIN_CURVE_LENGTH: f32 = 1e-4;

const DEFAULT_TOLERANCE: f32 = 0.01;
const MAX_ARC_SEGMENTS: usize = 256;

/// A path in world space. The single source of "where and along what" for placement.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Curve {
    Line {
        a: Vec3,
        b: Vec3,
    },
    /// Angles are measured in the deterministic basis derived from `normal`.
    Arc {
        center: Vec3,
        normal: Vec3,
        radius: f32,
        start_angle: f32,
        sweep: f32,
    },
    Circle {
        center: Vec3,
        normal: Vec3,
        radius: f32,
    },
    Polyline {
        points: Vec<Vec3>,
    },
}

impl Curve {
    pub fn line(a: Vec3, b: Vec3) -> Self {
        Self::Line { a, b }
    }

    /// Arc through `a`, `b`, `c` in that order. `None` when the points are collinear.
    pub fn arc_from_three_points(a: Vec3, b: Vec3, c: Vec3) -> Option<Self> {
        let ab = b - a;
        let ac = c - a;
        let n = ab.cross(ac);
        let n_len_sq = n.length_squared();
        if n_len_sq < 1e-12 {
            return None;
        }

        let center = a
            + (ac.length_squared() * n.cross(ab) + ab.length_squared() * ac.cross(n))
                / (2.0 * n_len_sq);
        let radius = (a - center).length();
        if radius < MIN_CURVE_LENGTH {
            return None;
        }

        let normal = n.normalize();
        let (u, v) = plane_basis(normal);
        let angle_of = |p: Vec3| {
            let d = p - center;
            d.dot(v).atan2(d.dot(u))
        };

        let start_angle = angle_of(a);
        let to_b = (angle_of(b) - start_angle).rem_euclid(TAU);
        let to_c = (angle_of(c) - start_angle).rem_euclid(TAU);
        // b must lie between a and c; if it does not, the arc runs the other way.
        let sweep = if to_b < to_c { to_c } else { to_c - TAU };

        Some(Self::Arc {
            center,
            normal,
            radius,
            start_angle,
            sweep,
        })
    }

    pub fn is_closed(&self) -> bool {
        match self {
            Self::Circle { .. } => true,
            Self::Polyline { points } => {
                points.len() > 2
                    && (points[0] - points[points.len() - 1]).length() < MIN_CURVE_LENGTH
            }
            _ => false,
        }
    }

    pub fn length(&self) -> f32 {
        match self {
            Self::Line { a, b } => (*b - *a).length(),
            Self::Arc { radius, sweep, .. } => radius * sweep.abs(),
            Self::Circle { radius, .. } => radius * TAU,
            Self::Polyline { points } => points
                .windows(2)
                .map(|w| (w[1] - w[0]).length())
                .sum::<f32>(),
        }
    }

    pub fn start(&self) -> Vec3 {
        self.point_at(0.0)
    }

    pub fn end(&self) -> Vec3 {
        self.point_at(1.0)
    }

    /// Position at normalized parameter `t` in `[0, 1]` (arc-length based for polylines).
    pub fn point_at(&self, t: f32) -> Vec3 {
        match self {
            Self::Line { a, b } => *a + (*b - *a) * t,
            Self::Arc {
                center,
                normal,
                radius,
                start_angle,
                sweep,
            } => arc_point(*center, *normal, *radius, start_angle + sweep * t),
            Self::Circle {
                center,
                normal,
                radius,
            } => arc_point(*center, *normal, *radius, TAU * t),
            Self::Polyline { points } => {
                let (i, local) = polyline_at(points, t);
                points[i] + (points[i + 1] - points[i]) * local
            }
        }
    }

    /// Unit tangent at normalized parameter `t`.
    pub fn tangent_at(&self, t: f32) -> Result<Vec3, GeometryError> {
        let raw = match self {
            Self::Line { a, b } => *b - *a,
            Self::Arc {
                normal,
                start_angle,
                sweep,
                ..
            } => arc_tangent(*normal, start_angle + sweep * t) * *sweep,
            Self::Circle { normal, .. } => arc_tangent(*normal, TAU * t),
            Self::Polyline { points } => {
                let (i, _) = polyline_at(points, t);
                points[i + 1] - points[i]
            }
        };
        raw.try_normalize()
            .ok_or(GeometryError::DegenerateCurve(self.length()))
    }

    /// Cross-section frame at `t`: local Z along the tangent, local Y toward `up`.
    pub fn frame_at(&self, t: f32, up: Vec3) -> Result<Frame, GeometryError> {
        let tangent = self.tangent_at(t)?;
        let origin = self.point_at(t);
        let z = tangent;
        let x = up
            .cross(z)
            .try_normalize()
            .or_else(|| Vec3::Z.cross(z).try_normalize())
            .or_else(|| Vec3::X.cross(z).try_normalize())
            .ok_or(GeometryError::DegenerateCurve(self.length()))?;
        Ok(Frame::new(origin, x, z.cross(x), z))
    }

    /// Normalized parameters at which the curve should be sampled.
    ///
    /// Open curves include both ends; closed curves omit the duplicate final station.
    pub fn station_params(&self, tolerance: f32) -> Vec<f32> {
        let tol = if tolerance > 0.0 {
            tolerance
        } else {
            DEFAULT_TOLERANCE
        };
        match self {
            Self::Line { .. } => vec![0.0, 1.0],
            Self::Arc { radius, sweep, .. } => {
                let n = arc_segments(*radius, sweep.abs(), tol).max(1);
                (0..=n).map(|i| i as f32 / n as f32).collect()
            }
            Self::Circle { radius, .. } => {
                let n = arc_segments(*radius, TAU, tol).max(3);
                (0..n).map(|i| i as f32 / n as f32).collect()
            }
            Self::Polyline { points } => {
                let total = self.length();
                if total < MIN_CURVE_LENGTH {
                    return vec![0.0, 1.0];
                }
                let mut params = Vec::with_capacity(points.len());
                let mut travelled = 0.0;
                params.push(0.0);
                for w in points.windows(2) {
                    travelled += (w[1] - w[0]).length();
                    params.push((travelled / total).min(1.0));
                }
                if self.is_closed() {
                    params.pop();
                }
                params
            }
        }
    }

    /// Sampled points along the curve.
    pub fn tessellate(&self, tolerance: f32) -> Vec<Vec3> {
        self.station_params(tolerance)
            .into_iter()
            .map(|t| self.point_at(t))
            .collect()
    }

    /// Lengthen (positive) or shorten (negative) the curve at each end.
    ///
    /// Closed curves have no ends, so they come back unchanged.
    pub fn extended(&self, start: f32, end: f32) -> Result<Self, GeometryError> {
        if start == 0.0 && end == 0.0 {
            return Ok(self.clone());
        }
        match self {
            Self::Line { a, b } => {
                let dir = (*b - *a)
                    .try_normalize()
                    .ok_or(GeometryError::DegenerateCurve(0.0))?;
                Ok(Self::Line {
                    a: *a - dir * start,
                    b: *b + dir * end,
                })
            }
            Self::Arc {
                center,
                normal,
                radius,
                start_angle,
                sweep,
            } => {
                if *radius <= 0.0 {
                    return Err(GeometryError::InvalidRadius(*radius));
                }
                let sign = if *sweep < 0.0 { -1.0 } else { 1.0 };
                let d_start = sign * start / radius;
                let d_end = sign * end / radius;
                Ok(Self::Arc {
                    center: *center,
                    normal: *normal,
                    radius: *radius,
                    start_angle: start_angle - d_start,
                    sweep: sweep + d_start + d_end,
                })
            }
            Self::Circle { .. } => Ok(self.clone()),
            Self::Polyline { points } => {
                if self.is_closed() || points.len() < 2 {
                    return Ok(self.clone());
                }
                let mut points = points.clone();
                let last = points.len() - 1;
                let head = (points[1] - points[0])
                    .try_normalize()
                    .ok_or(GeometryError::DegenerateCurve(0.0))?;
                let tail = (points[last] - points[last - 1])
                    .try_normalize()
                    .ok_or(GeometryError::DegenerateCurve(0.0))?;
                points[0] -= head * start;
                points[last] += tail * end;
                Ok(Self::Polyline { points })
            }
        }
    }
}

fn arc_point(center: Vec3, normal: Vec3, radius: f32, angle: f32) -> Vec3 {
    let (u, v) = plane_basis(normal);
    center + (u * angle.cos() + v * angle.sin()) * radius
}

/// Direction of increasing angle (unit length, ignores radius).
fn arc_tangent(normal: Vec3, angle: f32) -> Vec3 {
    let (u, v) = plane_basis(normal);
    -u * angle.sin() + v * angle.cos()
}

fn arc_segments(radius: f32, sweep_abs: f32, tolerance: f32) -> usize {
    if radius <= 0.0 || sweep_abs <= 0.0 {
        return 1;
    }
    let tol = tolerance.min(radius * 0.999);
    let max_angle = 2.0 * (1.0 - tol / radius).clamp(-1.0, 1.0).acos();
    if max_angle <= 1e-6 {
        return MAX_ARC_SEGMENTS;
    }
    ((sweep_abs / max_angle).ceil() as usize).clamp(1, MAX_ARC_SEGMENTS)
}

/// Segment index plus local `[0, 1]` position for an arc-length parameter.
fn polyline_at(points: &[Vec3], t: f32) -> (usize, f32) {
    let segments = points.len().saturating_sub(1);
    if segments == 0 {
        return (0, 0.0);
    }
    let total: f32 = points.windows(2).map(|w| (w[1] - w[0]).length()).sum();
    if total < MIN_CURVE_LENGTH {
        return (0, 0.0);
    }
    let target = (t.clamp(0.0, 1.0)) * total;
    let mut travelled = 0.0;
    for i in 0..segments {
        let len = (points[i + 1] - points[i]).length();
        if travelled + len >= target || i == segments - 1 {
            let local = if len > MIN_CURVE_LENGTH {
                ((target - travelled) / len).clamp(0.0, 1.0)
            } else {
                0.0
            };
            return (i, local);
        }
        travelled += len;
    }
    (segments - 1, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    const EPS: f32 = 1e-4;

    fn close(a: Vec3, b: Vec3) -> bool {
        (a - b).length() < EPS
    }

    #[test]
    fn line_reports_length_endpoints_and_tangent() {
        let c = Curve::line(Vec3::ZERO, Vec3::new(3.0, 0.0, 4.0));
        assert!((c.length() - 5.0).abs() < EPS);
        assert!(close(c.start(), Vec3::ZERO));
        assert!(close(c.end(), Vec3::new(3.0, 0.0, 4.0)));
        assert!(close(c.point_at(0.5), Vec3::new(1.5, 0.0, 2.0)));
        assert!(close(c.tangent_at(0.3).unwrap(), Vec3::new(0.6, 0.0, 0.8)));
        assert!(!c.is_closed());
    }

    #[test]
    fn zero_length_line_has_no_tangent() {
        let c = Curve::line(Vec3::ONE, Vec3::ONE);
        assert!(c.tangent_at(0.0).is_err());
    }

    #[test]
    fn arc_through_three_points_passes_through_all_three() {
        let a = Vec3::new(1.0, 0.0, 0.0);
        let b = Vec3::new(0.0, 0.0, 1.0);
        let c = Vec3::new(-1.0, 0.0, 0.0);
        let arc = Curve::arc_from_three_points(a, b, c).expect("arc");

        let Curve::Arc { center, radius, .. } = &arc else {
            panic!("expected an arc");
        };
        assert!(close(*center, Vec3::ZERO), "center {center}");
        assert!((radius - 1.0).abs() < EPS, "radius {radius}");

        assert!(close(arc.start(), a), "start {}", arc.start());
        assert!(close(arc.end(), c), "end {}", arc.end());
        assert!(close(arc.point_at(0.5), b), "mid {}", arc.point_at(0.5));
        assert!((arc.length() - std::f32::consts::PI).abs() < EPS);
    }

    #[test]
    fn arc_orientation_follows_the_middle_point() {
        let a = Vec3::new(1.0, 0.0, 0.0);
        let c = Vec3::new(-1.0, 0.0, 0.0);
        let up = Curve::arc_from_three_points(a, Vec3::new(0.0, 0.0, 1.0), c).expect("arc");
        let down = Curve::arc_from_three_points(a, Vec3::new(0.0, 0.0, -1.0), c).expect("arc");

        assert!(close(up.point_at(0.5), Vec3::new(0.0, 0.0, 1.0)));
        assert!(close(down.point_at(0.5), Vec3::new(0.0, 0.0, -1.0)));
    }

    #[test]
    fn collinear_points_make_no_arc() {
        let a = Vec3::ZERO;
        let b = Vec3::new(1.0, 0.0, 0.0);
        let c = Vec3::new(2.0, 0.0, 0.0);
        assert!(Curve::arc_from_three_points(a, b, c).is_none());
    }

    #[test]
    fn arc_tangent_is_perpendicular_to_the_radius() {
        let arc = Curve::arc_from_three_points(
            Vec3::new(2.0, 0.0, 0.0),
            Vec3::new(0.0, 0.0, 2.0),
            Vec3::new(-2.0, 0.0, 0.0),
        )
        .expect("arc");
        for t in [0.0, 0.25, 0.5, 0.75, 1.0] {
            let p = arc.point_at(t);
            let tangent = arc.tangent_at(t).unwrap();
            assert!((tangent.length() - 1.0).abs() < EPS);
            assert!(p.dot(tangent).abs() < 1e-3, "not perpendicular at t={t}");
        }
    }

    #[test]
    fn circle_is_closed_and_has_the_right_circumference() {
        let c = Curve::Circle {
            center: Vec3::ZERO,
            normal: Vec3::Y,
            radius: 2.0,
        };
        assert!(c.is_closed());
        assert!((c.length() - TAU * 2.0).abs() < EPS);
        // Closed curves omit the duplicate final station.
        let params = c.station_params(0.01);
        assert!(params.len() >= 3);
        assert!(*params.last().unwrap() < 1.0);
    }

    #[test]
    fn polyline_is_parameterized_by_arc_length() {
        let c = Curve::Polyline {
            points: vec![
                Vec3::ZERO,
                Vec3::new(3.0, 0.0, 0.0),
                Vec3::new(3.0, 0.0, 1.0),
            ],
        };
        assert!((c.length() - 4.0).abs() < EPS);
        // Halfway by length lands 2m along the first (3m) segment.
        assert!(close(c.point_at(0.5), Vec3::new(2.0, 0.0, 0.0)));
        assert!(close(c.end(), Vec3::new(3.0, 0.0, 1.0)));
    }

    #[test]
    fn tessellation_of_an_arc_respects_the_tolerance() {
        let arc = Curve::arc_from_three_points(
            Vec3::new(5.0, 0.0, 0.0),
            Vec3::new(0.0, 0.0, 5.0),
            Vec3::new(-5.0, 0.0, 0.0),
        )
        .expect("arc");
        let coarse = arc.tessellate(1.0).len();
        let fine = arc.tessellate(0.001).len();
        assert!(fine > coarse, "finer tolerance should add stations");
        for p in arc.tessellate(0.01) {
            assert!((p.length() - 5.0).abs() < EPS, "point off the circle: {p}");
        }
    }

    #[test]
    fn line_frame_puts_y_up_and_z_along_the_path() {
        let c = Curve::line(Vec3::ZERO, Vec3::new(10.0, 0.0, 0.0));
        let f = c.frame_at(0.0, Vec3::Y).expect("frame");
        assert!(close(f.z, Vec3::X));
        assert!(close(f.y, Vec3::Y));
        assert!(close(f.x.cross(f.y), f.z), "frame must stay right-handed");
    }

    #[test]
    fn extending_a_line_moves_both_ends_outward() {
        let c = Curve::line(Vec3::ZERO, Vec3::new(4.0, 0.0, 0.0));
        let e = c.extended(1.0, 2.0).expect("extended");
        assert!(close(e.start(), Vec3::new(-1.0, 0.0, 0.0)));
        assert!(close(e.end(), Vec3::new(6.0, 0.0, 0.0)));
        assert!((e.length() - 7.0).abs() < EPS);
    }

    #[test]
    fn extending_an_arc_changes_length_by_the_offsets() {
        let arc = Curve::arc_from_three_points(
            Vec3::new(2.0, 0.0, 0.0),
            Vec3::new(0.0, 0.0, 2.0),
            Vec3::new(-2.0, 0.0, 0.0),
        )
        .expect("arc");
        let before = arc.length();
        let after = arc.extended(0.5, 0.25).expect("extended").length();
        assert!(
            (after - (before + 0.75)).abs() < 1e-3,
            "{before} -> {after}"
        );
    }

    #[test]
    fn extending_a_closed_circle_is_a_no_op() {
        let c = Curve::Circle {
            center: Vec3::ZERO,
            normal: Vec3::Y,
            radius: 1.0,
        };
        assert_eq!(c.extended(1.0, 1.0).unwrap(), c);
    }

    #[test]
    fn curve_round_trips_through_json() {
        let c = Curve::line(Vec3::new(1.0, 2.0, 3.0), Vec3::new(4.0, 5.0, 6.0));
        let json = serde_json::to_string(&c).expect("serialize");
        assert!(json.contains("\"kind\":\"line\""), "json was {json}");
        let back: Curve = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, c);
    }
}
