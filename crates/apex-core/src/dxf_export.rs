//! DXF R12 ASCII writer for [`VectorDrawing2d`].

use std::collections::BTreeSet;

use crate::vector_export::{ExportUnits, VectorDrawing2d, VectorLine2d, VectorText2d};
use crate::viewport_crop::{clip_segment_to_polygon, point_in_polygon};

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
            centered: false,
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
    for fill in &drawing.fills {
        layers.insert(fill.layer.clone());
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
        visit(dim.extension_a);
        visit(dim.extension_b);
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

/// Clip vector geometry to a closed polygon (sheet mm).
pub fn clip_drawing_to_polygon(drawing: &VectorDrawing2d, ring: &[[f64; 2]]) -> VectorDrawing2d {
    if ring.len() < 3 {
        return drawing.clone();
    }
    let mut out = VectorDrawing2d {
        units: drawing.units,
        scale_denominator: drawing.scale_denominator,
        lines: Vec::new(),
        texts: Vec::new(),
        dimensions: Vec::new(),
        // Keep regions whose vertices all lie in the crop; partial regions
        // are dropped (their clipped outline lines still print).
        fills: drawing
            .fills
            .iter()
            .filter(|f| f.ring.iter().all(|p| point_in_polygon(*p, ring)))
            .cloned()
            .collect(),
    };
    for line in &drawing.lines {
        for (a, b) in clip_segment_to_polygon(line.a, line.b, ring) {
            out.lines.push(VectorLine2d {
                layer: line.layer.clone(),
                a,
                b,
            });
        }
    }
    for text in &drawing.texts {
        if point_in_polygon(text.position, ring) {
            out.texts.push(text.clone());
        }
    }
    for dim in &drawing.dimensions {
        let mid = [
            (dim.dim_a[0] + dim.dim_b[0]) * 0.5,
            (dim.dim_a[1] + dim.dim_b[1]) * 0.5,
        ];
        if point_in_polygon(mid, ring) || point_in_polygon(dim.text_position, ring) {
            let mut clipped = dim.clone();
            for (a, b) in [
                (dim.extension_a, dim.dim_a),
                (dim.extension_b, dim.dim_b),
                (dim.dim_a, dim.dim_b),
            ] {
                for (ca, cb) in clip_segment_to_polygon(a, b, ring) {
                    if (ca[0] - a[0]).abs() + (ca[1] - a[1]).abs() < 1e-6 {
                        clipped.extension_a = ca;
                        clipped.dim_a = cb;
                    }
                }
            }
            out.dimensions.push(clipped);
        }
    }
    out
}

fn rect_lines(out: &mut VectorDrawing2d, layer: &str, x0: f64, y0: f64, x1: f64, y1: f64) {
    for (a, b) in [
        ([x0, y0], [x1, y0]),
        ([x1, y0], [x1, y1]),
        ([x1, y1], [x0, y1]),
        ([x0, y1], [x0, y0]),
    ] {
        out.lines.push(VectorLine2d {
            layer: layer.into(),
            a,
            b,
        });
    }
}

/// ISO-style drawing frame (10 mm margin, 20 mm binding edge) and a
/// bottom-right title block.
fn push_title_block(out: &mut VectorDrawing2d, sheet: &crate::sheet::Sheet, sw: f64, sh: f64) {
    let (l, r, b, t) = (20.0, sw - 10.0, 10.0, sh - 10.0);
    rect_lines(out, "SHEET_FRAME", l, b, r, t);
    let (w, h) = (180.0, 48.0);
    let (x0, y0) = (r - w, b);
    rect_lines(out, "TITLE_BLOCK", x0, y0, r, y0 + h);
    for y in [y0 + 16.0, y0 + 32.0] {
        out.lines.push(VectorLine2d {
            layer: "TITLE_BLOCK".into(),
            a: [x0, y],
            b: [r, y],
        });
    }
    out.lines.push(VectorLine2d {
        layer: "TITLE_BLOCK".into(),
        a: [x0 + 120.0, y0],
        b: [x0 + 120.0, y0 + 16.0],
    });
    let mut text = |x: f64, y: f64, height: f64, s: String| {
        out.texts.push(VectorText2d {
            layer: "TITLE_BLOCK".into(),
            position: [x, y],
            height,
            text: s,
            centered: false,
        });
    };
    text(x0 + 3.0, y0 + h - 3.5, 2.0, "PROJECT".into());
    text(x0 + 3.0, y0 + 35.5, 5.0, "APEX PROJECT".into());
    text(x0 + 3.0, y0 + 29.0, 2.0, "SHEET TITLE".into());
    text(x0 + 3.0, y0 + 19.5, 5.0, sheet.name.to_uppercase());
    text(x0 + 3.0, y0 + 13.0, 2.0, "SCALE".into());
    text(x0 + 3.0, y0 + 4.0, 4.0, "AS INDICATED".into());
    text(x0 + 123.0, y0 + 13.0, 2.0, "SHEET NO.".into());
    text(x0 + 123.0, y0 + 3.5, 7.0, sheet.number.clone());
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
            fills: Vec::new(),
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
            if let Some(view_drawing) = self.vector_export_view(vp.view_id) {
                let mapped = crate::sheet_scale::map_view_drawing_to_sheet_mm(
                    &view_drawing,
                    f64::from(vp.anchor_x_m),
                    f64::from(vp.anchor_z_m),
                    f64::from(vp.center_x_mm),
                    f64::from(vp.center_y_mm),
                );
                let crop_ring = vp.crop_polygon_mm();
                let clipped = clip_drawing_to_polygon(&mapped, &crop_ring);
                combined.lines.extend(clipped.lines);
                combined.texts.extend(clipped.texts);
                combined.dimensions.extend(clipped.dimensions);
                combined.fills.extend(clipped.fills);
            }

            // View title under the viewport: name, rule, scale.
            if let Some(view) = self.views.get(&vp.view_id) {
                let left = f64::from(vp.center_x_mm - vp.width_mm * 0.5);
                let bottom = f64::from(vp.center_y_mm - vp.height_mm * 0.5);
                let name = view.name.to_uppercase();
                let rule = (name.chars().count() as f64 * 3.2).max(40.0);
                combined.texts.push(VectorText2d {
                    layer: "VIEW_TITLE".into(),
                    position: [left + 2.0, bottom + 5.0],
                    height: 4.0,
                    text: name,
                    centered: false,
                });
                combined.lines.push(VectorLine2d {
                    layer: "VIEW_TITLE".into(),
                    a: [left + 2.0, bottom + 3.8],
                    b: [left + 2.0 + rule, bottom + 3.8],
                });
                combined.texts.push(VectorText2d {
                    layer: "VIEW_TITLE".into(),
                    position: [left + 2.0, bottom - 0.5],
                    height: 3.0,
                    text: format!("1:{}", view.settings.scale.round() as i64),
                    centered: false,
                });
            }
        }

        push_title_block(&mut combined, sheet, sw as f64, sh as f64);
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
                centered: false,
            }],
            dimensions: vec![],
            fills: vec![],
        };
        let dxf = drawing_to_dxf(&drawing);
        assert!(dxf.contains("$INSUNITS"));
        assert!(dxf.contains("  6\n"));
        assert!(dxf.contains("WALL"));
        assert!(dxf.contains("  0\nLINE\n"));
        assert!(dxf.contains("  0\nTEXT\n"));
        assert!(dxf.contains("A1"));
    }

    #[test]
    fn sheet_export_10m_wall_measures_100mm_at_1_100() {
        use glam::Vec3;

        use crate::param::ParamMap;
        use crate::placement::PlacementKind;
        use crate::Project;

        let mut project = Project::new();
        let level = project.document().active_level_id().expect("level");
        let view_id = project.create_plan_view(level).expect("view");
        project
            .views
            .get_mut(&view_id)
            .expect("view")
            .settings
            .scale = 100.0;
        let a = Vec3::new(0.0, 0.0, 0.0);
        let b = Vec3::new(10.0, 0.0, 0.0);
        let placement = project
            .placement_from_gesture("apex.wall", Some(PlacementKind::TwoPoint), &[a, b], 0.0)
            .expect("placement");
        project
            .create_element("apex.wall", placement, ParamMap::new())
            .expect("wall");
        let sheet_id = project.create_sheet("A101".into(), "Plan".into());
        project
            .place_view_on_sheet(sheet_id, view_id, 150.0, 150.0, 0.0, 0.0)
            .expect("place");
        let drawing = project.vector_export_sheet(sheet_id).expect("export");
        let mut best = 0.0_f64;
        for line in &drawing.lines {
            if line.layer != "WALL_CUT" {
                continue;
            }
            let len = ((line.b[0] - line.a[0]).powi(2) + (line.b[1] - line.a[1]).powi(2)).sqrt();
            best = best.max(len);
        }
        assert!(
            (best - 100.0).abs() < 1.0,
            "expected ~100 mm wall on sheet, longest WALL_CUT segment was {best} mm"
        );
    }
}
