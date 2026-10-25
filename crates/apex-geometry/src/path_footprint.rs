//! Plan footprints of swept path components (centerline + half-width).

use glam::Vec3;

use crate::curve::Curve;
use crate::join::adjust_end;
use crate::polygon::{union_contours, Contour2};

/// Build a closed XZ contour for one straight segment `a→b` with given half-width.
pub fn segment_footprint_rect(a: Vec3, b: Vec3, half_width: f32) -> Contour2 {
    if half_width <= 0.0 {
        return Vec::new();
    }
    let ab = Vec3::new(b.x - a.x, 0.0, b.z - a.z);
    let len = ab.length();
    if len < 1e-6 {
        return Vec::new();
    }
    let dir = ab / len;
    let perp = Vec3::new(-dir.z, 0.0, dir.x) * half_width;
    let p0 = a - perp;
    let p1 = a + perp;
    let p2 = b + perp;
    let p3 = b - perp;
    vec![
        [p0.x, p0.z],
        [p1.x, p1.z],
        [p2.x, p2.z],
        [p3.x, p3.z],
    ]
}

/// Union footprint of an open path after join extensions are applied.
pub fn path_footprint_union(
    curve: &Curve,
    half_width: f32,
    join_start: f32,
    join_end: f32,
) -> Vec<Contour2> {
    if half_width <= 0.0 {
        return Vec::new();
    }
    let extended = adjust_end(curve, true, join_start)
        .ok()
        .and_then(|c| adjust_end(&c, false, join_end).ok())
        .unwrap_or_else(|| curve.clone());

    let points = match &extended {
        Curve::Line { a, b } => vec![*a, *b],
        Curve::Polyline { points } if points.len() >= 2 => points.clone(),
        _ => return Vec::new(),
    };

    let mut rects = Vec::new();
    for w in points.windows(2) {
        let rect = segment_footprint_rect(w[0], w[1], half_width);
        if rect.len() >= 3 {
            rects.push(rect);
        }
    }
    if rects.is_empty() {
        return Vec::new();
    }
    union_contours(&rects)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Curve;

    #[test]
    fn l_shape_two_segments_union_without_internal_edge() {
        let a = Curve::line(Vec3::ZERO, Vec3::new(5.0, 0.0, 0.0));
        let b = Curve::line(Vec3::new(5.0, 0.0, 0.0), Vec3::new(5.0, 0.0, 4.0));
        let half = 0.1;
        let fa = path_footprint_union(&a, half, 0.1, 0.1);
        let fb = path_footprint_union(&b, half, 0.1, 0.1);
        let mut all = fa;
        all.extend(fb);
        let merged = union_contours(&all);
        assert_eq!(merged.len(), 1, "L cluster should be one outer polygon");
    }
}
