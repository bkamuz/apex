//! Headless 3D picture: a flat-shaded axonometric SVG of the model
//! (painter's algorithm). No GPU or browser needed; rasterise the SVG with
//! any SVG renderer to get a PNG.

use std::fmt::Write;

use glam::Vec3;

use crate::project::Project;

fn colour(category: &str) -> [f32; 3] {
    match category {
        "wall" => [0.93, 0.91, 0.87],
        "slab" | "floor" => [0.78, 0.78, 0.76],
        "roof" => [0.72, 0.38, 0.30],
        "opening" => [0.55, 0.72, 0.85],
        "column" | "beam" => [0.80, 0.80, 0.82],
        "stair" => [0.85, 0.80, 0.70],
        _ => [0.82, 0.82, 0.82],
    }
}

impl Project {
    /// Axonometric SVG of every visible element. `yaw`/`pitch` in radians
    /// (camera azimuth about +Y and elevation); `width`/`height` in px.
    pub fn render_3d_svg(&self, yaw: f32, pitch: f32, width: u32, height: u32) -> String {
        // Camera looks from `eye_dir` towards the origin.
        let eye_dir = Vec3::new(
            yaw.sin() * pitch.cos(),
            pitch.sin(),
            yaw.cos() * pitch.cos(),
        );
        let right = Vec3::Y.cross(eye_dir).normalize_or(Vec3::X);
        let up = eye_dir.cross(right).normalize();
        let light = (eye_dir * 0.5 + Vec3::new(0.3, 1.0, 0.2)).normalize();

        // (depth, screen points, rgb)
        let mut tris: Vec<(f32, [[f32; 2]; 3], [u8; 3])> = Vec::new();
        for element in self.document().elements() {
            if !self.boolean_consumers(element.id).is_empty() {
                continue; // operands render through their boolean
            }
            let Some(mesh) = self.document().get_mesh(element.id) else {
                continue;
            };
            let category = self
                .registry()
                .get(&element.component_id)
                .map(|c| c.category.as_str())
                .unwrap_or("element");
            if category == "space" {
                continue;
            }
            let base = colour(category);
            let pos = |i: u32| {
                let i = i as usize * 3;
                Vec3::new(
                    mesh.positions[i],
                    mesh.positions[i + 1],
                    mesh.positions[i + 2],
                )
            };
            for t in mesh.indices.as_chunks::<3>().0 {
                let (a, b, c) = (pos(t[0]), pos(t[1]), pos(t[2]));
                let n = (b - a).cross(c - a);
                if n.length_squared() < 1e-12 {
                    continue;
                }
                let n = n.normalize();
                if n.dot(eye_dir) <= 0.0 {
                    continue; // back face
                }
                let shade = 0.45 + 0.55 * n.dot(light).max(0.0);
                let rgb = base.map(|ch| (ch * shade * 255.0).clamp(0.0, 255.0) as u8);
                let proj = |p: Vec3| [p.dot(right), -p.dot(up)];
                let depth = (a + b + c).dot(eye_dir) / 3.0;
                tris.push((depth, [proj(a), proj(b), proj(c)], rgb));
            }
        }
        let mut out = String::new();
        if tris.is_empty() {
            let _ = write!(
                out,
                r#"<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}"><rect width="100%" height="100%" fill="white"/></svg>"#
            );
            return out;
        }
        let (mut min, mut max) = ([f32::MAX; 2], [f32::MIN; 2]);
        for (_, pts, _) in &tris {
            for p in pts {
                for k in 0..2 {
                    min[k] = min[k].min(p[k]);
                    max[k] = max[k].max(p[k]);
                }
            }
        }
        let pad = 0.05 * (max[0] - min[0]).max(max[1] - min[1]).max(1e-3);
        let (x0, y0) = (min[0] - pad, min[1] - pad);
        let (w, h) = (max[0] - min[0] + 2.0 * pad, max[1] - min[1] + 2.0 * pad);
        // Far first.
        tris.sort_by(|a, b| a.0.total_cmp(&b.0));
        let _ = write!(
            out,
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="{x0} {y0} {w} {h}" preserveAspectRatio="xMidYMid meet"><rect x="{x0}" y="{y0}" width="{w}" height="{h}" fill="white"/><g stroke-linejoin="round" stroke-width="{sw}">"#,
            sw = w / width.max(1) as f32 * 0.6
        );
        for (_, p, c) in &tris {
            let col = format!("#{:02x}{:02x}{:02x}", c[0], c[1], c[2]);
            let _ = write!(
                out,
                r#"<polygon points="{:.4},{:.4} {:.4},{:.4} {:.4},{:.4}" fill="{col}" stroke="{col}"/>"#,
                p[0][0], p[0][1], p[1][0], p[1][1], p[2][0], p[2][1]
            );
        }
        out.push_str("</g></svg>");
        out
    }
}

#[cfg(test)]
mod tests {
    use crate::Project;
    use serde_json::json;

    #[test]
    fn renders_visible_faces_of_a_wall() {
        let mut p = Project::new();
        p.execute_json(
            &json!({"op": "create_element", "component": "apex.wall", "points": [[0,0,0],[4,0,0]]})
                .to_string(),
        )
        .unwrap();
        let svg = p.render_3d_svg(0.6, 0.5, 400, 300);
        assert!(svg.starts_with("<svg") && svg.ends_with("</svg>"));
        assert!(svg.matches("<polygon").count() >= 4, "{svg}");
        let empty = Project::new().render_3d_svg(0.6, 0.5, 400, 300);
        assert!(!empty.contains("<polygon"));
    }
}
