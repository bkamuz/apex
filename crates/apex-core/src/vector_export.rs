//! Shared 2D vector export (plan views): model edges, datums, view annotations.

use glam::Vec3;
use serde::{Deserialize, Serialize};

use crate::project::Project;
use crate::view::{ViewId, ViewKind};
use crate::view_annotation::linear_dimension_overlay;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExportUnits {
    Metres,
    Millimetres,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VectorLine2d {
    pub layer: String,
    pub a: [f64; 2],
    pub b: [f64; 2],
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VectorText2d {
    pub layer: String,
    pub position: [f64; 2],
    pub height: f64,
    pub text: String,
    /// Horizontal + vertical centring on `position` (room tags, grid bubbles).
    #[serde(default)]
    pub centered: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VectorDimension2d {
    pub layer: String,
    pub extension_a: [f64; 2],
    pub extension_b: [f64; 2],
    pub dim_a: [f64; 2],
    pub dim_b: [f64; 2],
    pub text_position: [f64; 2],
    pub text: String,
}

/// Closed filled region (e.g. wall poché cut by the plan plane).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VectorFill2d {
    pub layer: String,
    pub ring: Vec<[f64; 2]>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VectorDrawing2d {
    pub units: ExportUnits,
    pub scale_denominator: f32,
    pub lines: Vec<VectorLine2d>,
    pub texts: Vec<VectorText2d>,
    pub dimensions: Vec<VectorDimension2d>,
    #[serde(default)]
    pub fills: Vec<VectorFill2d>,
}

/// Height of the plan cut plane above the level floor (drafting convention).
pub const PLAN_CUT_ABOVE_FLOOR_M: f32 = 1.2;

/// Intersect a triangle mesh with the horizontal plane `y` and chain the
/// resulting segments into closed loops (plan section outline).
pub fn mesh_section_loops(mesh: &apex_geometry::TriangleMesh, y: f32) -> Vec<Vec<[f64; 2]>> {
    let pos = |i: u32| {
        let k = i as usize * 3;
        Vec3::new(
            mesh.positions[k],
            mesh.positions[k + 1],
            mesh.positions[k + 2],
        )
    };
    let key = |p: [f64; 2]| ((p[0] * 1e4).round() as i64, (p[1] * 1e4).round() as i64);
    let mut segs: Vec<([f64; 2], [f64; 2])> = Vec::new();
    for tri in mesh.indices.chunks(3) {
        if tri.len() < 3 {
            continue;
        }
        let v = [pos(tri[0]), pos(tri[1]), pos(tri[2])];
        let mut pts = Vec::with_capacity(2);
        for i in 0..3 {
            let a = v[i];
            let b = v[(i + 1) % 3];
            let (da, db) = (a.y - y, b.y - y);
            if (da < 0.0) != (db < 0.0) {
                let t = da / (da - db);
                let p = a + (b - a) * t;
                pts.push([p.x as f64, p.z as f64]);
            }
        }
        if pts.len() == 2 && key(pts[0]) != key(pts[1]) {
            segs.push((pts[0], pts[1]));
        }
    }
    // Chain segments sharing endpoints into loops.
    let mut by_key: std::collections::HashMap<(i64, i64), Vec<usize>> = Default::default();
    for (i, (a, b)) in segs.iter().enumerate() {
        by_key.entry(key(*a)).or_default().push(i);
        by_key.entry(key(*b)).or_default().push(i);
    }
    let mut used = vec![false; segs.len()];
    let mut closed: Vec<Vec<[f64; 2]>> = Vec::new();
    let mut open: Vec<Vec<[f64; 2]>> = Vec::new();
    // Walk from `end` of `ring` through unused segments sharing the endpoint.
    let extend = |ring: &mut Vec<[f64; 2]>, used: &mut [bool]| loop {
        let tail = key(*ring.last().unwrap());
        let next = by_key
            .get(&tail)
            .and_then(|c| c.iter().copied().find(|&j| !used[j]));
        let Some(j) = next else { return false };
        used[j] = true;
        let (a, b) = segs[j];
        ring.push(if key(a) == tail { b } else { a });
        if key(*ring.last().unwrap()) == key(ring[0]) {
            ring.pop();
            return true;
        }
    };
    for start in 0..segs.len() {
        if used[start] {
            continue;
        }
        used[start] = true;
        let mut ring = vec![segs[start].0, segs[start].1];
        if extend(&mut ring, &mut used) {
            closed.push(ring);
            continue;
        }
        // Open so far: grow the other end too.
        ring.reverse();
        extend(&mut ring, &mut used);
        open.push(ring);
    }
    // Punched openings leave the mesh without reveal faces, so the section is
    // a set of open chains. Stitch nearest chain ends (within a wall thickness
    // or so) to recover closed, fillable wall pieces.
    const STITCH: f64 = 0.6;
    let d2 = |a: [f64; 2], b: [f64; 2]| (a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2);
    while let Some(mut chain) = open.pop() {
        loop {
            let tail = *chain.last().unwrap();
            let self_gap = d2(tail, chain[0]);
            let mut best: Option<(usize, bool, f64)> = None;
            for (i, other) in open.iter().enumerate() {
                for (rev, end) in [(false, other[0]), (true, *other.last().unwrap())] {
                    let d = d2(tail, end);
                    if best.is_none_or(|(_, _, bd)| d < bd) {
                        best = Some((i, rev, d));
                    }
                }
            }
            match best {
                Some((i, rev, d)) if d < self_gap && d < STITCH * STITCH => {
                    let mut other = open.swap_remove(i);
                    if rev {
                        other.reverse();
                    }
                    chain.extend(other);
                }
                _ => {
                    if self_gap < STITCH * STITCH {
                        closed.push(chain);
                    }
                    break;
                }
            }
        }
    }
    let mut loops = Vec::new();
    for ring in closed {
        let ring = drop_collinear(ring);
        if ring.len() >= 3 {
            loops.push(ring);
        }
    }
    loops
}

/// Remove vertices lying on the straight line between their neighbours
/// (triangulated faces cut into several collinear pieces).
fn drop_collinear(mut ring: Vec<[f64; 2]>) -> Vec<[f64; 2]> {
    let mut changed = true;
    while changed && ring.len() > 3 {
        changed = false;
        let n = ring.len();
        for i in 0..n {
            let a = ring[(i + n - 1) % n];
            let b = ring[i];
            let c = ring[(i + 1) % n];
            let cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
            let len = ((c[0] - a[0]).powi(2) + (c[1] - a[1]).powi(2))
                .sqrt()
                .max(1e-9);
            if (cross / len).abs() < 1e-5 {
                ring.remove(i);
                changed = true;
                break;
            }
        }
    }
    ring
}

fn plan_point(p: Vec3) -> [f64; 2] {
    [p.x as f64, p.z as f64]
}

fn layer_name(category: &str) -> String {
    let s: String = category
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    if s.is_empty() {
        "APEX".into()
    } else {
        s.to_ascii_uppercase()
    }
}

fn push_segment_lines(out: &mut VectorDrawing2d, layer: &str, segments: &[Vec3]) {
    let mut iter = segments.iter();
    while let Some(a) = iter.next() {
        if let Some(b) = iter.next() {
            out.lines.push(VectorLine2d {
                layer: layer.to_string(),
                a: plan_point(*a),
                b: plan_point(*b),
            });
        }
    }
}

/// Area of a ring given as consecutive edge pairs (shoelace on XZ).
fn polygon_area(edge_pairs: &[Vec3]) -> f64 {
    let mut sum = 0.0_f64;
    for pair in edge_pairs.chunks(2) {
        if let [a, b] = pair {
            sum += f64::from(a.x) * f64::from(b.z) - f64::from(b.x) * f64::from(a.z);
        }
    }
    (sum * 0.5).abs()
}

impl Project {
    /// Build a plan-space vector drawing for a saved view (metres, XZ plane).
    pub fn vector_export_view(&self, view_id: ViewId) -> Option<VectorDrawing2d> {
        let view = self.views.get(&view_id)?;
        let scale = view.settings.scale;
        let mut out = VectorDrawing2d {
            units: ExportUnits::Metres,
            scale_denominator: scale,
            lines: Vec::new(),
            texts: Vec::new(),
            dimensions: Vec::new(),
            fills: Vec::new(),
        };

        let (plan_level, cut_y) = match &view.kind {
            ViewKind::Plan {
                level_id,
                cut_height,
                ..
            } => (*level_id, *cut_height),
            ViewKind::ThreeD { .. } | ViewKind::Section { .. } => {
                return None;
            }
        };

        for element in self.document().elements() {
            if self.effective_level_id(element.id) != Some(plan_level) {
                continue;
            }
            let category = self
                .registry()
                .get(&element.component_id)
                .map(|c| c.category.as_str())
                .unwrap_or("element");
            if view
                .settings
                .category_visible
                .get(category)
                .is_some_and(|v| !*v)
            {
                continue;
            }
            let layer = layer_name(category);
            let Some(mesh) = self.document().get_mesh(element.id) else {
                continue;
            };
            // Hosted doors/windows draw as plan symbols, never as their 3D body.
            if category == "opening" {
                continue;
            }
            // Cut elements (walls, columns): poché section at the cut plane.
            if matches!(category, "wall" | "column") {
                let section_y = cut_y + PLAN_CUT_ABOVE_FLOOR_M + 1e-4;
                for ring in mesh_section_loops(mesh, section_y) {
                    for i in 0..ring.len() {
                        out.lines.push(VectorLine2d {
                            layer: format!("{layer}_CUT"),
                            a: ring[i],
                            b: ring[(i + 1) % ring.len()],
                        });
                    }
                    out.fills.push(VectorFill2d {
                        layer: format!("{layer}_CUT"),
                        ring,
                    });
                }
                continue;
            }
            for chunk in mesh.edges.chunks(6) {
                if chunk.len() < 6 {
                    continue;
                }
                let a = Vec3::new(chunk[0], chunk[1], chunk[2]);
                let b = Vec3::new(chunk[3], chunk[4], chunk[5]);
                if a.y > cut_y + 0.01 && b.y > cut_y + 0.01 {
                    continue;
                }
                let (pa, pb) = (plan_point(a), plan_point(b));
                if (pa[0] - pb[0]).abs() < 1e-6 && (pa[1] - pb[1]).abs() < 1e-6 {
                    continue;
                }
                out.lines.push(VectorLine2d {
                    layer: layer.clone(),
                    a: pa,
                    b: pb,
                });
            }
        }
        // Door leaves/swings and window glazing.
        let symbols = crate::plan_symbols::opening_plan_symbols(self, Some(plan_level));
        push_segment_lines(&mut out, "OPENING", &symbols);

        let work_plane = self.work_plane(plan_level);
        for axis in self.document().grid_axes() {
            if axis.level_id != plan_level {
                continue;
            }
            if let Ok(overlay) = axis.overlay_geometry(&work_plane) {
                push_segment_lines(&mut out, "GRID", &overlay.line_segments);
                push_segment_lines(&mut out, "GRID_BUBBLE", &overlay.bubble_segments);
                for label in overlay.labels {
                    out.texts.push(VectorText2d {
                        layer: "GRID_BUBBLE".into(),
                        position: plan_point(label.position),
                        height: 0.3,
                        text: label.text,
                        centered: true,
                    });
                }
            }
        }
        for line in self.document().construction_lines() {
            if line.level_id != plan_level {
                continue;
            }
            if let Ok(overlay) = line.overlay_geometry(&work_plane) {
                push_segment_lines(&mut out, "CONSTRUCTION", &overlay.line_segments);
            }
        }
        for space in self.document().spaces() {
            if space.level_id != plan_level {
                continue;
            }
            // Rooms print as a name + area tag; the boundary is a modelling aid.
            if let Ok(overlay) = space.overlay_geometry(&work_plane) {
                let area = polygon_area(&overlay.line_segments);
                for label in overlay.labels {
                    let p = plan_point(label.position);
                    out.texts.push(VectorText2d {
                        layer: "ROOM_NAME".into(),
                        position: p,
                        height: 0.3,
                        text: label.text,
                        centered: true,
                    });
                    if area > 0.0 {
                        out.texts.push(VectorText2d {
                            layer: "ROOM_AREA".into(),
                            position: [p[0], p[1] - 0.45],
                            height: 0.22,
                            text: format!("{area:.1} m²"),
                            centered: true,
                        });
                    }
                }
            }
        }

        for annotation in self.view_annotations_for(view_id) {
            let overlay = self.annotation_overlay(annotation);
            let layer = layer_name(annotation.kind.category());
            push_segment_lines(&mut out, &layer, &overlay.line_segments);
            for label in overlay.labels {
                out.texts.push(VectorText2d {
                    layer: layer.clone(),
                    position: plan_point(label.position),
                    height: 0.25,
                    text: label.text,
                    centered: false,
                });
            }
            if let crate::view_annotation::ViewAnnotationKind::LinearDimension { a, b, offset } =
                &annotation.kind
            {
                if let (Some(pa), Some(pb)) = (
                    self.resolve_annotation_anchor(a),
                    self.resolve_annotation_anchor(b),
                ) {
                    let dim = linear_dimension_overlay(pa, pb, *offset);
                    if dim.line_segments.len() >= 6 {
                        let a2 = plan_point(dim.line_segments[2]);
                        let b2 = plan_point(dim.line_segments[3]);
                        let ea = plan_point(dim.line_segments[0]);
                        let eb = plan_point(dim.line_segments[1]);
                        let text = dim
                            .labels
                            .first()
                            .map(|l| l.text.clone())
                            .unwrap_or_default();
                        let text_pos = dim
                            .labels
                            .first()
                            .map(|l| plan_point(l.position))
                            .unwrap_or([(a2[0] + b2[0]) * 0.5, (a2[1] + b2[1]) * 0.5]);
                        out.dimensions.push(VectorDimension2d {
                            layer: layer.clone(),
                            extension_a: ea,
                            extension_b: eb,
                            dim_a: a2,
                            dim_b: b2,
                            text_position: text_pos,
                            text,
                        });
                    }
                }
            }
        }

        Some(out)
    }

    /// Plan extents of a view export in metres (XZ plane).
    pub fn view_plan_bounds_m(&self, view_id: ViewId) -> Option<([f64; 2], [f64; 2])> {
        let drawing = self.vector_export_view(view_id)?;
        crate::dxf_export::bounds_2d(&drawing)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn box_mesh(min: [f32; 3], max: [f32; 3]) -> apex_geometry::TriangleMesh {
        let mut positions = Vec::new();
        for i in 0..8 {
            positions.push(if i & 1 == 0 { min[0] } else { max[0] });
            positions.push(if i & 2 == 0 { min[1] } else { max[1] });
            positions.push(if i & 4 == 0 { min[2] } else { max[2] });
        }
        // Side faces only matter for a horizontal section.
        let quads = [
            [0, 1, 3, 2],
            [4, 6, 7, 5],
            [0, 4, 5, 1],
            [2, 3, 7, 6],
            [0, 2, 6, 4],
            [1, 5, 7, 3],
        ];
        let mut indices = Vec::new();
        for q in quads {
            indices.extend([q[0], q[1], q[2], q[0], q[2], q[3]]);
        }
        apex_geometry::TriangleMesh {
            positions,
            normals: vec![0.0; 24],
            indices,
            edges: Vec::new(),
        }
    }

    #[test]
    fn section_of_box_is_one_rectangle() {
        let mesh = box_mesh([0.0, 0.0, 0.0], [4.0, 3.0, 0.2]);
        let loops = mesh_section_loops(&mesh, 1.2);
        assert_eq!(loops.len(), 1);
        let ring = &loops[0];
        assert!(ring.len() >= 4);
        let xs: Vec<f64> = ring.iter().map(|p| p[0]).collect();
        assert!(xs.iter().cloned().fold(f64::MIN, f64::max) > 3.99);
        assert!(xs.iter().cloned().fold(f64::MAX, f64::min) < 0.01);
    }

    #[test]
    fn section_above_box_is_empty() {
        let mesh = box_mesh([0.0, 0.0, 0.0], [4.0, 1.0, 0.2]);
        assert!(mesh_section_loops(&mesh, 1.2).is_empty());
    }
}
