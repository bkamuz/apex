//! DXF R12 ASCII writer for [`VectorDrawing2d`].

use std::collections::BTreeSet;

use crate::vector_export::{ExportUnits, VectorDrawing2d, VectorLine2d, VectorText2d};

fn insunits_code(units: ExportUnits) -> i32 {
    match units {
        ExportUnits::Metres => 6,
        ExportUnits::Millimetres => 4,
    }
}

fn write_line(out: &mut String, layer: &str, a: [f64; 2], b: [f64; 2], z: f64) {
    out.push_str("  0\nLINE\n  8\n");
    out.push_str(layer);
    out.push_str("\n 10\n");
    out.push_str(&format!("{}\n 20\n{}\n 30\n{}\n", a[0], a[1], z));
    out.push_str(" 11\n");
    out.push_str(&format!("{}\n 21\n{}\n 31\n{}\n", b[0], b[1], z));
}

fn write_text(out: &mut String, text: &VectorText2d, z: f64) {
    out.push_str("  0\nTEXT\n  8\n");
    out.push_str(&text.layer);
    out.push_str("\n 10\n");
    out.push_str(&format!(
        "{}\n 20\n{}\n 30\n{}\n",
        text.position[0], text.position[1], z
    ));
    out.push_str(" 40\n");
    out.push_str(&format!("{}\n  1\n{}\n", text.height, text.text));
}

fn write_dimension_lines(out: &mut String, dim: &crate::vector_export::VectorDimension2d, z: f64) {
    write_line(out, &dim.layer, dim.extension_a, dim.dim_a, z);
    write_line(out, &dim.layer, dim.extension_b, dim.dim_b, z);
    write_line(out, &dim.layer, dim.dim_a, dim.dim_b, z);
    write_text(
        out,
        &VectorText2d {
            layer: dim.layer.clone(),
            position: dim.text_position,
            height: 0.25,
            text: dim.text.clone(),
        },
        z,
    );
}

pub fn drawing_to_dxf(drawing: &VectorDrawing2d) -> String {
    let mut layers: BTreeSet<String> = BTreeSet::new();
    for line in &drawing.lines {
        layers.insert(line.layer.clone());
    }
    for text in &drawing.texts {
        layers.insert(text.layer.clone());
    }
    for dim in &drawing.dimensions {
        layers.insert(dim.layer.clone());
    }

    let mut out = String::new();
    out.push_str("  0\nSECTION\n  2\nHEADER\n  9\n$INSUNITS\n 70\n");
    out.push_str(&format!("{}\n", insunits_code(drawing.units)));
    out.push_str("  0\nENDSEC\n  0\nSECTION\n  2\nTABLES\n  0\nTABLE\n  2\nLAYER\n 70\n");
    out.push_str(&format!("{}\n", layers.len() + 1));
    for layer in &layers {
        out.push_str("  0\nLAYER\n  2\n");
        out.push_str(layer);
        out.push_str("\n 70\n0\n 62\n7\n  6\nCONTINUOUS\n");
    }
    out.push_str("  0\nENDTAB\n  0\nENDSEC\n  0\nSECTION\n  2\nENTITIES\n");

    let z = 0.0;
    for line in &drawing.lines {
        write_line(&mut out, &line.layer, line.a, line.b, z);
    }
    for text in &drawing.texts {
        write_text(&mut out, text, z);
    }
    for dim in &drawing.dimensions {
        write_dimension_lines(&mut out, dim, z);
    }

    out.push_str("  0\nENDSEC\n  0\nEOF\n");
    out
}

pub fn bounds_2d(drawing: &VectorDrawing2d) -> Option<([f64; 2], [f64; 2])> {
    let mut min = [f64::INFINITY; 2];
    let mut max = [f64::NEG_INFINITY; 2];
    let mut any = false;
    let mut visit = |p: [f64; 2]| {
        any = true;
        min[0] = min[0].min(p[0]);
        min[1] = min[1].min(p[1]);
        max[0] = max[0].max(p[0]);
        max[1] = max[1].max(p[1]);
    };
    for line in &drawing.lines {
        visit(line.a);
        visit(line.b);
    }
    for text in &drawing.texts {
        visit(text.position);
    }
    for dim in &drawing.dimensions {
        visit(dim.dim_a);
        visit(dim.dim_b);
        visit(dim.text_position);
    }
    if any {
        Some((min, max))
    } else {
        None
    }
}

/// Fit a plan drawing (metres) into a sheet viewport rectangle (mm).
pub fn fit_view_to_viewport_mm(
    drawing: &VectorDrawing2d,
    center_x_mm: f64,
    center_y_mm: f64,
    width_mm: f64,
    height_mm: f64,
) -> VectorDrawing2d {
    let Some((min, max)) = bounds_2d(drawing) else {
        return VectorDrawing2d {
            units: ExportUnits::Millimetres,
            scale_denominator: drawing.scale_denominator,
            lines: Vec::new(),
            texts: Vec::new(),
            dimensions: Vec::new(),
        };
    };
    let cx = (min[0] + max[0]) * 0.5;
    let cz = (min[1] + max[1]) * 0.5;
    let w_m = (max[0] - min[0]).max(0.5);
    let h_m = (max[1] - min[1]).max(0.5);
    let mm_per_m = 1000.0 / f64::from(drawing.scale_denominator.max(1.0));
    let content_w_mm = w_m * mm_per_m;
    let content_h_mm = h_m * mm_per_m;
    let fit = (width_mm * 0.92 / content_w_mm).min(height_mm * 0.92 / content_h_mm);

    let map = |p: [f64; 2]| -> [f64; 2] {
        let dx = (p[0] - cx) * mm_per_m * fit;
        let dz = (p[1] - cz) * mm_per_m * fit;
        [center_x_mm + dx, center_y_mm + dz]
    };

    let mut out = VectorDrawing2d {
        units: ExportUnits::Millimetres,
        scale_denominator: drawing.scale_denominator,
        lines: Vec::new(),
        texts: Vec::new(),
        dimensions: Vec::new(),
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
            height: text.height * mm_per_m * fit,
            text: text.text.clone(),
        });
    }
    for dim in &drawing.dimensions {
        out.dimensions
            .push(crate::vector_export::VectorDimension2d {
                layer: dim.layer.clone(),
                extension_a: map(dim.extension_a),
                extension_b: map(dim.extension_b),
                dim_a: map(dim.dim_a),
                dim_b: map(dim.dim_b),
                text_position: map(dim.text_position),
                text: dim.text.clone(),
            });
    }
    out
}

impl crate::project::Project {
    pub fn vector_export_sheet(&self, sheet_id: crate::sheet::SheetId) -> Option<VectorDrawing2d> {
        let sheet = self.sheets.get(&sheet_id)?;
        let mut combined = VectorDrawing2d {
            units: ExportUnits::Millimetres,
            scale_denominator: 100.0,
            lines: Vec::new(),
            texts: Vec::new(),
            dimensions: Vec::new(),
        };

        let (sw, sh) = sheet.paper_size_mm();
        combined.lines.push(VectorLine2d {
            layer: "SHEET".into(),
            a: [0.0, 0.0],
            b: [sw as f64, 0.0],
        });
        combined.lines.push(VectorLine2d {
            layer: "SHEET".into(),
            a: [sw as f64, 0.0],
            b: [sw as f64, sh as f64],
        });
        combined.lines.push(VectorLine2d {
            layer: "SHEET".into(),
            a: [sw as f64, sh as f64],
            b: [0.0, sh as f64],
        });
        combined.lines.push(VectorLine2d {
            layer: "SHEET".into(),
            a: [0.0, sh as f64],
            b: [0.0, 0.0],
        });

        for vp in &sheet.viewports {
            let Some(view_drawing) = self.vector_export_view(vp.view_id) else {
                continue;
            };
            let fitted = fit_view_to_viewport_mm(
                &view_drawing,
                vp.center_x_mm as f64,
                vp.center_y_mm as f64,
                vp.width_mm as f64,
                vp.height_mm as f64,
            );
            combined.lines.extend(fitted.lines);
            combined.texts.extend(fitted.texts);
            combined.dimensions.extend(fitted.dimensions);
            combined.lines.push(VectorLine2d {
                layer: "VIEWPORT".into(),
                a: [
                    (vp.center_x_mm - vp.width_mm * 0.5) as f64,
                    (vp.center_y_mm - vp.height_mm * 0.5) as f64,
                ],
                b: [
                    (vp.center_x_mm + vp.width_mm * 0.5) as f64,
                    (vp.center_y_mm - vp.height_mm * 0.5) as f64,
                ],
            });
            combined.lines.push(VectorLine2d {
                layer: "VIEWPORT".into(),
                a: [
                    (vp.center_x_mm + vp.width_mm * 0.5) as f64,
                    (vp.center_y_mm - vp.height_mm * 0.5) as f64,
                ],
                b: [
                    (vp.center_x_mm + vp.width_mm * 0.5) as f64,
                    (vp.center_y_mm + vp.height_mm * 0.5) as f64,
                ],
            });
            combined.lines.push(VectorLine2d {
                layer: "VIEWPORT".into(),
                a: [
                    (vp.center_x_mm + vp.width_mm * 0.5) as f64,
                    (vp.center_y_mm + vp.height_mm * 0.5) as f64,
                ],
                b: [
                    (vp.center_x_mm - vp.width_mm * 0.5) as f64,
                    (vp.center_y_mm + vp.height_mm * 0.5) as f64,
                ],
            });
            combined.lines.push(VectorLine2d {
                layer: "VIEWPORT".into(),
                a: [
                    (vp.center_x_mm - vp.width_mm * 0.5) as f64,
                    (vp.center_y_mm + vp.height_mm * 0.5) as f64,
                ],
                b: [
                    (vp.center_x_mm - vp.width_mm * 0.5) as f64,
                    (vp.center_y_mm - vp.height_mm * 0.5) as f64,
                ],
            });
        }

        Some(combined)
    }

    pub fn export_view_dxf(&self, view_id: crate::view::ViewId) -> Option<String> {
        self.vector_export_view(view_id).map(|d| drawing_to_dxf(&d))
    }

    pub fn export_sheet_dxf(&self, sheet_id: crate::sheet::SheetId) -> Option<String> {
        self.vector_export_sheet(sheet_id)
            .map(|d| drawing_to_dxf(&d))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vector_export::{ExportUnits, VectorDrawing2d, VectorLine2d, VectorText2d};

    #[test]
    fn dxf_includes_insunits_and_layer_line() {
        let drawing = VectorDrawing2d {
            units: ExportUnits::Metres,
            scale_denominator: 100.0,
            lines: vec![VectorLine2d {
                layer: "WALL".into(),
                a: [0.0, 0.0],
                b: [4.0, 0.0],
            }],
            texts: vec![VectorText2d {
                layer: "ANNOT".into(),
                position: [1.0, 1.0],
                height: 0.25,
                text: "A1".into(),
            }],
            dimensions: vec![],
        };
        let dxf = drawing_to_dxf(&drawing);
        assert!(dxf.contains("$INSUNITS"));
        assert!(dxf.contains("  6\n"));
        assert!(dxf.contains("WALL"));
        assert!(dxf.contains("  0\nLINE\n"));
        assert!(dxf.contains("  0\nTEXT\n"));
        assert!(dxf.contains("A1"));
    }
}
