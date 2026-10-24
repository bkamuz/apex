//! Pure path-join helpers: miter extensions and segment queries.
//!
//! Knows nothing about walls, beams, or documents — only curves and widths.

use glam::Vec3;

use crate::curve::{Curve, MIN_CURVE_LENGTH};

/// Default plan-distance (metres) within which path ends are considered coincident.
pub const JOIN_SNAP: f32 = 0.05;

/// Half-width extension past a corner so square end caps meet in a miter.
///
/// `turn_angle` is the angle between the two directions leaving the join
/// (radians, in `(0, π]`). Returns 0 for degenerate or near-straight angles.
pub fn miter_extension(half_width: f32, turn_angle: f32) -> f32 {
    if half_width <= 0.0 || !turn_angle.is_finite() {
        return 0.0;
    }
    // Ignore near-collinear joins (almost 0 or almost π).
    let acute = turn_angle.min(std::f32::consts::PI - turn_angle);
    if acute < 1e-3 {
        return 0.0;
    }
    let half = (turn_angle * 0.5).tan();
    if half.abs() < 1e-6 {
        return 0.0;
    }
    let ext = half_width / half;
    // Cap runaway extensions at sharp corners.
    ext.clamp(0.0, half_width * 20.0)
}

/// How far to shorten a stem so its end cap sits on a host face of `host_half_width`.
///
/// `hit_angle` is the angle between stem direction and host direction (radians).
pub fn stem_trim(host_half_width: f32, hit_angle: f32) -> f32 {
    if host_half_width <= 0.0 || !hit_angle.is_finite() {
        return 0.0;
    }
    let sin = hit_angle.sin().abs();
    if sin < 1e-3 {
        return 0.0;
    }
    (host_half_width / sin).clamp(0.0, host_half_width * 20.0)
}

/// Angle in `[0, π]` between two directions (not required to be unit).
pub fn angle_between(a: Vec3, b: Vec3) -> Option<f32> {
    let a = a.try_normalize()?;
    let b = b.try_normalize()?;
    Some(a.dot(b).clamp(-1.0, 1.0).acos())
}

/// Closest point on segment `a→b` to `p`, projected in XZ (plan). Returns world
/// point (Y from the segment lerp), parameter `t ∈ [0,1]`, and plan distance.
pub fn closest_on_segment_xz(a: Vec3, b: Vec3, p: Vec3) -> Option<(Vec3, f32, f32)> {
    let ab = Vec3::new(b.x - a.x, 0.0, b.z - a.z);
    let len_sq = ab.length_squared();
    if len_sq < MIN_CURVE_LENGTH * MIN_CURVE_LENGTH {
        return None;
    }
    let ap = Vec3::new(p.x - a.x, 0.0, p.z - a.z);
    let t = (ap.dot(ab) / len_sq).clamp(0.0, 1.0);
    let q = a.lerp(b, t);
    let dist = Vec3::new(p.x - q.x, 0.0, p.z - q.z).length();
    Some((q, t, dist))
}

/// Plan (XZ) distance between two points.
pub fn plan_distance(a: Vec3, b: Vec3) -> f32 {
    Vec3::new(a.x - b.x, 0.0, a.z - b.z).length()
}

/// Extend (+) or shorten (−) a straight/open curve at one end.
///
/// `at_start`: true → start end; false → finish end.
pub fn adjust_end(
    curve: &Curve,
    at_start: bool,
    delta: f32,
) -> Result<Curve, crate::GeometryError> {
    if delta.abs() < 1e-9 {
        return Ok(curve.clone());
    }
    if at_start {
        curve.extended(delta, 0.0)
    } else {
        curve.extended(0.0, delta)
    }
}

/// Insert a vertex on a line or polyline at plan parameter `t` along the hit segment.
///
/// For a line, returns a 3-point polyline. Arcs/circles are rejected (`None`).
pub fn split_curve_at(curve: &Curve, point: Vec3, snap: f32) -> Option<Curve> {
    match curve {
        Curve::Line { a, b } => {
            let (q, t, dist) = closest_on_segment_xz(*a, *b, point)?;
            if dist > snap || !(0.05..=0.95).contains(&t) {
                return None;
            }
            // Keep original elevations; place the split on the segment.
            Some(Curve::Polyline {
                points: vec![*a, q, *b],
            })
        }
        Curve::Polyline { points } => {
            if points.len() < 2 {
                return None;
            }
            let mut best: Option<(usize, Vec3, f32, f32)> = None;
            for (i, w) in points.windows(2).enumerate() {
                let Some((q, t, dist)) = closest_on_segment_xz(w[0], w[1], point) else {
                    continue;
                };
                if dist > snap || !(0.05..=0.95).contains(&t) {
                    continue;
                }
                if best.as_ref().map(|b| dist < b.3).unwrap_or(true) {
                    best = Some((i, q, t, dist));
                }
            }
            let (i, q, _, _) = best?;
            // Skip if an existing vertex already sits there.
            if plan_distance(points[i], q) < snap || plan_distance(points[i + 1], q) < snap {
                return Some(curve.clone());
            }
            let mut out = Vec::with_capacity(points.len() + 1);
            out.extend_from_slice(&points[..=i]);
            out.push(q);
            out.extend_from_slice(&points[i + 1..]);
            Some(Curve::Polyline { points: out })
        }
        Curve::Arc { .. } | Curve::Circle { .. } => None,
    }
}

/// Unit direction at an open curve end, pointing **outward** (away from the curve).
pub fn outward_dir(curve: &Curve, at_start: bool) -> Option<Vec3> {
    let t = if at_start { 0.0 } else { 1.0 };
    let tangent = curve.tangent_at(t).ok()?;
    Some(if at_start { -tangent } else { tangent })
}

/// Unit direction at an open curve end, pointing **inward** (into the curve).
pub fn inward_dir(curve: &Curve, at_start: bool) -> Option<Vec3> {
    Some(-outward_dir(curve, at_start)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    const EPS: f32 = 1e-4;

    #[test]
    fn right_angle_miter_equals_half_width() {
        let e = miter_extension(0.1, std::f32::consts::FRAC_PI_2);
        assert!((e - 0.1).abs() < EPS, "got {e}");
    }

    #[test]
    fn straight_angle_needs_no_miter() {
        assert_eq!(miter_extension(0.1, std::f32::consts::PI), 0.0);
        assert_eq!(miter_extension(0.1, 0.0), 0.0);
    }

    #[test]
    fn perpendicular_stem_trim_equals_host_half_width() {
        let t = stem_trim(0.1, std::f32::consts::FRAC_PI_2);
        assert!((t - 0.1).abs() < EPS, "got {t}");
    }

    #[test]
    fn closest_on_segment_finds_midpoint() {
        let a = Vec3::ZERO;
        let b = Vec3::new(10.0, 0.0, 0.0);
        let p = Vec3::new(5.0, 1.0, 0.2);
        let (q, t, dist) = closest_on_segment_xz(a, b, p).unwrap();
        assert!((t - 0.5).abs() < EPS);
        assert!((q.x - 5.0).abs() < EPS);
        assert!((dist - 0.2).abs() < EPS);
    }

    #[test]
    fn split_line_makes_polyline() {
        let line = Curve::line(Vec3::ZERO, Vec3::new(10.0, 0.0, 0.0));
        let split = split_curve_at(&line, Vec3::new(4.0, 0.0, 0.01), 0.05).unwrap();
        match split {
            Curve::Polyline { points } => {
                assert_eq!(points.len(), 3);
                assert!((points[1].x - 4.0).abs() < 0.02);
            }
            other => panic!("expected polyline, got {other:?}"),
        }
    }

    #[test]
    fn adjust_end_lengthens_a_line() {
        let line = Curve::line(Vec3::ZERO, Vec3::new(5.0, 0.0, 0.0));
        let longer = adjust_end(&line, false, 0.1).unwrap();
        assert!((longer.length() - 5.1).abs() < EPS);
        let shorter = adjust_end(&line, true, -0.5).unwrap();
        assert!((shorter.length() - 4.5).abs() < EPS);
    }
}
