//! True-scale sheet mapping: model metres → paper mm.

use crate::vector_export::{VectorDimension2d, VectorDrawing2d, VectorLine2d, VectorText2d};

pub const PAPER_TEXT_HEIGHT_MM: f64 = 2.5;

pub const STANDARD_VIEW_SCALES: &[u32] = &[1, 2, 5, 10, 20, 25, 50, 100, 200, 500, 1000];

/// Space below the viewport frame reserved for the drawing title (mm on paper).
pub const VIEWPORT_TITLE_BAND_MM: f32 = 8.0;

/// Inset around exported plan bounds inside the viewport canvas (mm on paper).
pub const VIEWPORT_CONTENT_PADDING_MM: f32 = 6.0;

pub fn mm_per_model_metre(scale_denominator: f32) -> f64 {
    1000.0 / f64::from(scale_denominator.max(1.0))
}

/// Paper mm from model extent in metres at a view scale.
pub fn model_metres_to_paper_mm(metres: f64, scale_denominator: f32) -> f64 {
    metres * mm_per_model_metre(scale_denominator)
}

/// Centre of plan bounds (metres, XZ).
pub fn plan_bounds_center(min: [f64; 2], max: [f64; 2]) -> (f32, f32) {
    (
        ((min[0] + max[0]) * 0.5) as f32,
        ((min[1] + max[1]) * 0.5) as f32,
    )
}

/// Viewport frame size on paper (mm) that fits plan bounds at true scale.
pub fn viewport_size_mm_for_bounds(
    min: [f64; 2],
    max: [f64; 2],
    scale_denominator: f32,
) -> (f32, f32) {
    let w_m = (max[0] - min[0]).max(0.01);
    let h_m = (max[1] - min[1]).max(0.01);
    let w_mm = model_metres_to_paper_mm(w_m, scale_denominator) as f32;
    let h_mm = model_metres_to_paper_mm(h_m, scale_denominator) as f32;
    let pad = VIEWPORT_CONTENT_PADDING_MM * 2.0;
    (
        (w_mm + pad).max(10.0),
        (h_mm + pad + VIEWPORT_TITLE_BAND_MM).max(10.0),
    )
}

/// Map a plan-space view export (metres) onto sheet coordinates (mm) at true scale.
pub fn map_view_drawing_to_sheet_mm(
    drawing: &VectorDrawing2d,
    anchor_x_m: f64,
    anchor_z_m: f64,
    center_x_mm: f64,
    center_y_mm: f64,
) -> VectorDrawing2d {
    let k = mm_per_model_metre(drawing.scale_denominator);
    let map = |p: [f64; 2]| -> [f64; 2] {
        [
            center_x_mm + (p[0] - anchor_x_m) * k,
            center_y_mm + (p[1] + anchor_z_m) * k,
        ]
    };

    let mut out = VectorDrawing2d {
        units: crate::vector_export::ExportUnits::Millimetres,
        scale_denominator: drawing.scale_denominator,
        lines: Vec::with_capacity(drawing.lines.len()),
        texts: Vec::with_capacity(drawing.texts.len()),
        dimensions: Vec::with_capacity(drawing.dimensions.len()),
        fills: drawing
            .fills
            .iter()
            .map(|f| crate::vector_export::VectorFill2d {
                layer: f.layer.clone(),
                ring: f.ring.iter().map(|p| map(*p)).collect(),
            })
            .collect(),
    };
    for line in &drawing.lines {
        out.lines.push(VectorLine2d {
            layer: line.layer.clone(),
            a: map(line.a),
            b: map(line.b),
        });
    }
    for text in &drawing.texts {
        out.texts.push(VectorText2d {
            layer: text.layer.clone(),
            position: map(text.position),
            height: (text.height * k)
                .clamp(PAPER_TEXT_HEIGHT_MM * 0.75, PAPER_TEXT_HEIGHT_MM * 2.0),
            text: text.text.clone(),
            centered: text.centered,
        });
    }
    for dim in &drawing.dimensions {
        out.dimensions.push(VectorDimension2d {
            layer: dim.layer.clone(),
            extension_a: map(dim.extension_a),
            extension_b: map(dim.extension_b),
            dim_a: map(dim.dim_a),
            dim_b: map(dim.dim_b),
            text_position: map(dim.text_position),
            text: dim.text.clone(),
            text_angle: dim.text_angle,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vector_export::{ExportUnits, VectorLine2d};

    #[test]
    fn map_10m_segment_to_100mm_at_1_100() {
        let drawing = VectorDrawing2d {
            units: ExportUnits::Metres,
            scale_denominator: 100.0,
            lines: vec![VectorLine2d {
                layer: "WALL".into(),
                a: [0.0, 0.0],
                b: [10.0, 0.0],
            }],
            texts: vec![],
            dimensions: vec![],
            fills: vec![],
        };
        let mapped = map_view_drawing_to_sheet_mm(&drawing, 5.0, 0.0, 100.0, 50.0);
        let line = &mapped.lines[0];
        let len = ((line.b[0] - line.a[0]).powi(2) + (line.b[1] - line.a[1]).powi(2)).sqrt();
        assert!(
            (len - 100.0).abs() < 0.01,
            "expected 100 mm segment, got {len}"
        );
    }
}
