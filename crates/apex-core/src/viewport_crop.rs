//! Viewport crop polygons (normalized frame coords) and 2D clipping helpers.

/// Default rectangular crop (full frame), UV from bottom-left of viewport frame.
pub fn default_crop_polygon_uv() -> Vec<[f32; 2]> {
    vec![[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]]
}

pub fn normalize_crop_polygon(points: &[[f32; 2]]) -> Result<Vec<[f32; 2]>, CropError> {
    if points.len() < 3 {
        return Err(CropError::TooFewVertices);
    }
    Ok(points
        .iter()
        .map(|[u, v]| [u.clamp(0.0, 1.0), v.clamp(0.0, 1.0)])
        .collect())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CropError {
    TooFewVertices,
}

pub fn bbox_2d(points: &[[f64; 2]]) -> Option<([f64; 2], [f64; 2])> {
    if points.is_empty() {
        return None;
    }
    let mut min = [f64::INFINITY; 2];
    let mut max = [f64::NEG_INFINITY; 2];
    for p in points {
        min[0] = min[0].min(p[0]);
        min[1] = min[1].min(p[1]);
        max[0] = max[0].max(p[0]);
        max[1] = max[1].max(p[1]);
    }
    Some((min, max))
}

/// Even-odd point in polygon test (closed ring).
pub fn point_in_polygon(p: [f64; 2], ring: &[[f64; 2]]) -> bool {
    if ring.len() < 3 {
        return false;
    }
    let mut inside = false;
    let mut j = ring.len() - 1;
    for i in 0..ring.len() {
        let pi = ring[i];
        let pj = ring[j];
        let intersect = ((pi[1] > p[1]) != (pj[1] > p[1]))
            && (p[0] < (pj[0] - pi[0]) * (p[1] - pi[1]) / (pj[1] - pi[1]).max(1e-12) + pi[0]);
        if intersect {
            inside = !inside;
        }
        j = i;
    }
    inside
}

fn lerp2(a: [f64; 2], b: [f64; 2], t: f64) -> [f64; 2] {
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
}

fn segment_intersection_t(a: [f64; 2], b: [f64; 2], c: [f64; 2], d: [f64; 2]) -> Option<f64> {
    let r = [b[0] - a[0], b[1] - a[1]];
    let s = [d[0] - c[0], d[1] - c[1]];
    let rxs = r[0] * s[1] - r[1] * s[0];
    if rxs.abs() < 1e-12 {
        return None;
    }
    let qp = [c[0] - a[0], c[1] - a[1]];
    let t = (qp[0] * s[1] - qp[1] * s[0]) / rxs;
    let u = (qp[0] * r[1] - qp[1] * r[0]) / rxs;
    if (0.0..=1.0).contains(&t) && (0.0..=1.0).contains(&u) {
        Some(t)
    } else {
        None
    }
}

/// Clip a line segment to a (possibly non-convex) closed polygon; may return multiple segments.
pub fn clip_segment_to_polygon(
    a: [f64; 2],
    b: [f64; 2],
    ring: &[[f64; 2]],
) -> Vec<([f64; 2], [f64; 2])> {
    if ring.len() < 3 {
        return vec![(a, b)];
    }
    let mut ts = vec![0.0_f64, 1.0];
    for i in 0..ring.len() {
        let j = (i + 1) % ring.len();
        if let Some(t) = segment_intersection_t(a, b, ring[i], ring[j]) {
            ts.push(t);
        }
    }
    ts.sort_by(|x, y| x.partial_cmp(y).unwrap_or(std::cmp::Ordering::Equal));
    ts.dedup_by(|x, y| (*x - *y).abs() < 1e-9);

    let mut out = Vec::new();
    for w in ts.windows(2) {
        let t0 = w[0];
        let t1 = w[1];
        if t1 - t0 < 1e-9 {
            continue;
        }
        let mid = lerp2(a, b, (t0 + t1) * 0.5);
        if point_in_polygon(mid, ring) {
            out.push((lerp2(a, b, t0), lerp2(a, b, t1)));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clip_segment_across_square() {
        let square = vec![[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0]];
        let segs = clip_segment_to_polygon([-5.0, 5.0], [15.0, 5.0], &square);
        assert_eq!(segs.len(), 1);
        assert!((segs[0].0[0] - 0.0).abs() < 1e-6);
        assert!((segs[0].1[0] - 10.0).abs() < 1e-6);
    }
}
