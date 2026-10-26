//! Minimal SVG writer for [`VectorDrawing2d`] (headless exports; the web app
//! has its own richer SVG/PDF path).

use std::fmt::Write;

use crate::dxf_export::bounds_2d;
use crate::vector_export::VectorDrawing2d;

fn esc(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// Render a drawing to a standalone SVG document. Drawing Y is up; SVG Y is
/// down, so Y is negated.
pub fn drawing_to_svg(drawing: &VectorDrawing2d) -> String {
    let (min, max) = bounds_2d(drawing).unwrap_or(([0.0, 0.0], [1.0, 1.0]));
    let pad = ((max[0] - min[0]).max(max[1] - min[1]) * 0.05).max(0.01);
    let (x0, y0) = (min[0] - pad, -max[1] - pad);
    let (w, h) = (max[0] - min[0] + 2.0 * pad, max[1] - min[1] + 2.0 * pad);
    let stroke = (w.max(h) / 800.0).max(1e-4);
    let mut out = String::new();
    let _ = write!(
        out,
        r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="{x0} {y0} {w} {h}" width="1200" height="{}" stroke-linecap="round"><rect x="{x0}" y="{y0}" width="{w}" height="{h}" fill="white"/>"#,
        (1200.0 * h / w).round()
    );
    for f in &drawing.fills {
        let pts: Vec<String> = f
            .ring
            .iter()
            .map(|p| format!("{},{}", p[0], -p[1]))
            .collect();
        let _ = write!(
            out,
            r##"<polygon points="{}" fill="#ddd" stroke="none"/>"##,
            pts.join(" ")
        );
    }
    let _ = write!(
        out,
        r#"<g stroke="black" stroke-width="{stroke}" fill="none">"#
    );
    for l in &drawing.lines {
        let _ = write!(
            out,
            r#"<line x1="{}" y1="{}" x2="{}" y2="{}"/>"#,
            l.a[0], -l.a[1], l.b[0], -l.b[1]
        );
    }
    for d in &drawing.dimensions {
        for (a, b) in [
            (d.extension_a, d.dim_a),
            (d.extension_b, d.dim_b),
            (d.dim_a, d.dim_b),
        ] {
            let _ = write!(
                out,
                r#"<line x1="{}" y1="{}" x2="{}" y2="{}"/>"#,
                a[0], -a[1], b[0], -b[1]
            );
        }
    }
    out.push_str("</g>");
    let text_h = (w.max(h) / 60.0).max(0.05);
    for d in &drawing.dimensions {
        let _ = write!(
            out,
            r#"<text x="{x}" y="{y}" font-size="{text_h}" text-anchor="middle" font-family="sans-serif" transform="rotate({r} {x} {y})">{}</text>"#,
            esc(&d.text),
            x = d.text_position[0],
            y = -d.text_position[1],
            r = -d.text_angle.to_degrees()
        );
    }
    for t in &drawing.texts {
        let size = if t.height > 0.0 { t.height } else { text_h };
        let anchor = if t.centered { "middle" } else { "start" };
        let _ = write!(
            out,
            r#"<text x="{}" y="{}" font-size="{size}" text-anchor="{anchor}" font-family="sans-serif">{}</text>"#,
            t.position[0],
            -t.position[1],
            esc(&t.text)
        );
    }
    out.push_str("</svg>");
    out
}
