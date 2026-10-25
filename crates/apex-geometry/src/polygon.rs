//! 2D polygon boolean ops for plan footprints (XZ plane).

use i_overlay::core::fill_rule::FillRule;
use i_overlay::core::overlay_rule::OverlayRule;
use i_overlay::float::single::SingleFloatOverlay;

/// Closed contour in the XZ plane as `[x, z]` pairs (CCW preferred).
pub type Contour2 = Vec<[f32; 2]>;

type Shape2 = Vec<Contour2>;

fn flatten_shapes(shapes: Vec<Shape2>) -> Vec<Contour2> {
    shapes
        .into_iter()
        .flat_map(|shape| shape.into_iter())
        .filter(|c| c.len() >= 3)
        .collect()
}

/// Union two closed contours.
pub fn union_two(a: &Contour2, b: &Contour2) -> Vec<Contour2> {
    if a.len() < 3 {
        return if b.len() >= 3 {
            vec![b.clone()]
        } else {
            Vec::new()
        };
    }
    if b.len() < 3 {
        return vec![a.clone()];
    }
    flatten_shapes(a.overlay(b, OverlayRule::Union, FillRule::NonZero))
}

/// Union many closed contours into one or more outer boundaries (holes included as inner loops).
pub fn union_contours(contours: &[Contour2]) -> Vec<Contour2> {
    let mut iter = contours.iter().filter(|c| c.len() >= 3);
    let Some(first) = iter.next() else {
        return Vec::new();
    };
    let mut acc = vec![first.clone()];
    for next in iter {
        let mut merged = Vec::new();
        for part in &acc {
            merged.extend(union_two(part, next));
        }
        acc = merged;
        if acc.is_empty() {
            break;
        }
    }
    acc
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overlapping_rectangles_union_to_one_outer_loop() {
        let a = vec![[0.0, 0.0], [2.0, 0.0], [2.0, 1.0], [0.0, 1.0]];
        let b = vec![[1.0, 0.0], [3.0, 0.0], [3.0, 1.0], [1.0, 1.0]];
        let out = union_contours(&[a, b]);
        assert!(!out.is_empty());
        let min_x = out
            .iter()
            .flat_map(|c| c.iter().map(|p| p[0]))
            .fold(f32::INFINITY, f32::min);
        let max_x = out
            .iter()
            .flat_map(|c| c.iter().map(|p| p[0]))
            .fold(f32::NEG_INFINITY, f32::max);
        assert!((min_x - 0.0).abs() < 0.02);
        assert!((max_x - 3.0).abs() < 0.02);
    }
}
