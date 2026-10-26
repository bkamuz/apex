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

        // (centroid depth, screen points, vertex depths, rgb)
        let mut tris: Vec<Tri> = Vec::new();
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
                let d = [a.dot(eye_dir), b.dot(eye_dir), c.dot(eye_dir)];
                tris.push((depth, [proj(a), proj(b), proj(c)], d, rgb));
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
        for (_, pts, _, _) in &tris {
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
        let order = paint_order(&tris, [x0, y0, w, h], width, height);
        let _ = write!(
            out,
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="{x0} {y0} {w} {h}" preserveAspectRatio="xMidYMid meet"><rect x="{x0}" y="{y0}" width="{w}" height="{h}" fill="white"/><g stroke-linejoin="round" stroke-width="{sw}">"#,
            sw = w / width.max(1) as f32 * 0.6
        );
        for (_, p, _, c) in order.iter().map(|&i| &tris[i]) {
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

type Tri = (f32, [[f32; 2]; 3], [f32; 3], [u8; 3]);

/// Painter order that matches a depth buffer. Sorting by centroid alone
/// lets large far faces (a roof slope) paint over small near ones and lets
/// faces hidden under a roof bleed through as slivers. Rasterise a depth
/// buffer at output resolution, drop faces with no visible pixel, and draw
/// every face before the faces that cover it (ties and cycles fall back to
/// centroid depth, far first).
fn paint_order(tris: &[Tri], view: [f32; 4], width: u32, height: u32) -> Vec<usize> {
    let (wpx, hpx) = (
        width.clamp(1, 4096) as usize,
        height.clamp(1, 4096) as usize,
    );
    let scale = (wpx as f32 / view[2]).min(hpx as f32 / view[3]);
    // preserveAspectRatio="xMidYMid meet" offsets.
    let (ox, oy) = (
        (wpx as f32 - view[2] * scale) * 0.5,
        (hpx as f32 - view[3] * scale) * 0.5,
    );
    let px = |p: [f32; 2]| [(p[0] - view[0]) * scale + ox, (p[1] - view[1]) * scale + oy];
    // Visit pixel centres inside triangle `t` with interpolated depth.
    let raster = |t: &Tri, f: &mut dyn FnMut(usize, f32)| {
        let [a, b, c] = t.1.map(px);
        let area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
        if area.abs() < 1e-9 {
            return;
        }
        let x0 = a[0].min(b[0]).min(c[0]).floor().max(0.0) as usize;
        let x1 = (a[0].max(b[0]).max(c[0]).ceil() as usize).min(wpx);
        let y0 = a[1].min(b[1]).min(c[1]).floor().max(0.0) as usize;
        let y1 = (a[1].max(b[1]).max(c[1]).ceil() as usize).min(hpx);
        for y in y0..y1 {
            for x in x0..x1 {
                let p = [x as f32 + 0.5, y as f32 + 0.5];
                let w0 = ((b[0] - p[0]) * (c[1] - p[1]) - (b[1] - p[1]) * (c[0] - p[0])) / area;
                let w1 = ((c[0] - p[0]) * (a[1] - p[1]) - (c[1] - p[1]) * (a[0] - p[0])) / area;
                let w2 = 1.0 - w0 - w1;
                if w0 < 0.0 || w1 < 0.0 || w2 < 0.0 {
                    continue;
                }
                f(y * wpx + x, w0 * t.2[0] + w1 * t.2[1] + w2 * t.2[2]);
            }
        }
    };
    // Larger depth = nearer the eye.
    let mut zbuf = vec![(f32::MIN, usize::MAX); wpx * hpx];
    for (i, t) in tris.iter().enumerate() {
        raster(t, &mut |k, d| {
            if d > zbuf[k].0 {
                zbuf[k] = (d, i);
            }
        });
    }
    let mut visible = vec![false; tris.len()];
    for &(_, i) in &zbuf {
        if i != usize::MAX {
            visible[i] = true;
        }
    }
    // Edge i -> j: j covers part of i, so i paints first.
    let mut after: Vec<std::collections::BTreeSet<usize>> = vec![Default::default(); tris.len()];
    for (i, t) in tris.iter().enumerate() {
        if !visible[i] {
            continue;
        }
        raster(t, &mut |k, _| {
            let j = zbuf[k].1;
            if j != i && j != usize::MAX {
                after[i].insert(j);
            }
        });
    }
    let mut indeg = vec![0usize; tris.len()];
    for set in &after {
        for &j in set {
            indeg[j] += 1;
        }
    }
    // Kahn's algorithm, far-first among ready faces; on a cycle release the
    // farthest remaining face.
    let key = |i: usize| ordered(tris[i].0);
    let mut ready: std::collections::BinaryHeap<std::cmp::Reverse<(i64, usize)>> = (0..tris.len())
        .filter(|&i| visible[i] && indeg[i] == 0)
        .map(|i| std::cmp::Reverse((key(i), i)))
        .collect();
    let mut done = vec![false; tris.len()];
    let mut remaining: Vec<usize> = (0..tris.len()).filter(|&i| visible[i]).collect();
    remaining.sort_by(|&a, &b| tris[a].0.total_cmp(&tris[b].0));
    let mut cursor = 0;
    let mut order = Vec::with_capacity(remaining.len());
    while order.len() < remaining.len() {
        let i = match ready.pop() {
            Some(std::cmp::Reverse((_, i))) => i,
            None => {
                while done[remaining[cursor]] {
                    cursor += 1;
                }
                remaining[cursor]
            }
        };
        if done[i] {
            continue;
        }
        done[i] = true;
        order.push(i);
        for &j in &after[i] {
            indeg[j] = indeg[j].saturating_sub(1);
            if indeg[j] == 0 && !done[j] {
                ready.push(std::cmp::Reverse((key(j), j)));
            }
        }
    }
    order
}

/// Total order key for a finite depth.
fn ordered(d: f32) -> i64 {
    (d as f64 * 1e6).round() as i64
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
