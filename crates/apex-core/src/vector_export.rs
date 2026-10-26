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
    /// Text baseline direction (radians, CCW from +X): along the dimension
    /// line, flipped to read left-to-right / bottom-to-top.
    #[serde(default)]
    pub text_angle: f64,
}

/// Nominal dimension text height (metres) used for placement.
const DIM_TEXT_H: f64 = 0.25;

/// Where a dimension's text goes: centred on the dimension line, on the side
/// away from the measured points, rotated along the line, and slid along it
/// (never past its ends) until it clears every grid bubble.
fn place_dimension_text(
    ea: [f64; 2],
    eb: [f64; 2],
    a2: [f64; 2],
    b2: [f64; 2],
    text: &str,
    bubbles: &[[f64; 2]],
) -> ([f64; 2], f64) {
    let d = [b2[0] - a2[0], b2[1] - a2[1]];
    let len = (d[0] * d[0] + d[1] * d[1]).sqrt().max(1e-9);
    let mut u = [d[0] / len, d[1] / len];
    // Read left-to-right, or bottom-to-top for vertical lines.
    if u[0] < -1e-6 || (u[0].abs() <= 1e-6 && u[1] < 0.0) {
        u = [-u[0], -u[1]];
    }
    let angle = u[1].atan2(u[0]);
    let mut n = [-u[1], u[0]];
    // Outward: from the measured points towards the dimension line.
    let out_dir = [a2[0] - ea[0] + b2[0] - eb[0], a2[1] - ea[1] + b2[1] - eb[1]];
    if out_dir[0] * n[0] + out_dir[1] * n[1] < 0.0 {
        n = [-n[0], -n[1]];
    }
    let mid = [(a2[0] + b2[0]) * 0.5, (a2[1] + b2[1]) * 0.5];
    let gap = DIM_TEXT_H * 0.3;
    // A baseline on the outward side; a text whose "up" points inward
    // (n opposite the reading up) sits fully past the line instead.
    let up = [-u[1], u[0]];
    let base_off = if n[0] * up[0] + n[1] * up[1] >= 0.0 {
        gap
    } else {
        gap + DIM_TEXT_H
    };
    let half_w = 0.3 * DIM_TEXT_H * text.chars().count() as f64;
    const BUBBLE_CLEAR: f64 = 0.35;
    let clear = |c: [f64; 2]| {
        bubbles.iter().all(|b| {
            // Distance from the bubble centre to the text box (a segment
            // of half-width half_w, thickened by half the text height).
            let rel = [b[0] - c[0], b[1] - c[1]];
            let along = (rel[0] * u[0] + rel[1] * u[1]).clamp(-half_w, half_w);
            let q = [rel[0] - along * u[0], rel[1] - along * u[1]];
            (q[0] * q[0] + q[1] * q[1]).sqrt() > BUBBLE_CLEAR + DIM_TEXT_H * 0.5
        })
    };
    let at = |s: f64| {
        let base = [
            mid[0] + u[0] * s + n[0] * base_off,
            mid[1] + u[1] * s + n[1] * base_off,
        ];
        let centre = [
            base[0] + up[0] * DIM_TEXT_H * 0.5,
            base[1] + up[1] * DIM_TEXT_H * 0.5,
        ];
        (base, centre)
    };
    let limit = (len * 0.5 - half_w).max(0.0);
    let mut best = at(0.0).0;
    'search: for k in 0..=20 {
        let s = limit * k as f64 / 20.0;
        for s in [s, -s] {
            let (base, centre) = at(s);
            if clear(centre) {
                best = base;
                break 'search;
            }
        }
    }
    (best, angle)
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
                pts.push([p.x as f64, -p.z as f64]);
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
    [p.x as f64, -p.z as f64]
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

        let mut cut_meshes: std::collections::BTreeMap<String, apex_geometry::TriangleMesh> =
            Default::default();
        let section_y = cut_y + PLAN_CUT_ABOVE_FLOOR_M + 1e-4;
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
            // Stairs draw as a symbol (treads, cut line, arrow), not a box.
            // Boolean operands are a modelling aid (shown as ghosts) only.
            if category == "opening"
                || category == "stair"
                || !self.boolean_consumers(element.id).is_empty()
            {
                continue;
            }
            // Cut elements (walls, columns): poché section at the cut plane.
            if matches!(category, "wall" | "column") {
                // Outline: joined walls are sectioned together so a cluster
                // reads as one outline without internal join lines.
                let merged = cut_meshes.entry(format!("{layer}_CUT")).or_default();
                let base = (merged.positions.len() / 3) as u32;
                merged.positions.extend_from_slice(&mesh.positions);
                merged.indices.extend(mesh.indices.iter().map(|i| i + base));
                // Fill: each element's own share of the cluster. Shares tile
                // without overlap and never cover an enclosed room.
                let rings: Vec<Vec<[f64; 2]>> = match self.plan_cut_region(element, section_y) {
                    Some(region) => region
                        .into_iter()
                        .filter_map(|shape| shape.into_iter().next())
                        .map(|ring| ring.into_iter().map(|[x, z]| [x, -z]).collect())
                        .collect(),
                    None => mesh_section_loops(mesh, section_y),
                };
                for ring in rings {
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
        for (layer, mesh) in &cut_meshes {
            for ring in mesh_section_loops(mesh, section_y) {
                for i in 0..ring.len() {
                    out.lines.push(VectorLine2d {
                        layer: layer.clone(),
                        a: ring[i],
                        b: ring[(i + 1) % ring.len()],
                    });
                }
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
            {
                let overlay = self.space_overlay(space);
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

        // Grid bubble centres: dimension text is kept clear of them.
        let bubbles: Vec<[f64; 2]> = out
            .texts
            .iter()
            .filter(|t| t.layer == "GRID_BUBBLE")
            .map(|t| t.position)
            .collect();
        for annotation in self.view_annotations_for(view_id) {
            let overlay = self.annotation_overlay(annotation);
            let layer = layer_name(annotation.kind.category());
            let is_dimension = matches!(
                annotation.kind,
                crate::view_annotation::ViewAnnotationKind::LinearDimension { .. }
            );
            if !is_dimension {
                push_segment_lines(&mut out, &layer, &overlay.line_segments);
            }
            // A dimension's lines and text come from its VectorDimension2d
            // below; pushing the overlay too drew every value twice.
            for label in overlay.labels.into_iter().filter(|_| !is_dimension) {
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
                        // Segments: a→a2, b→b2, a2→b2 (see linear_dimension_overlay).
                        let ea = plan_point(dim.line_segments[0]);
                        let a2 = plan_point(dim.line_segments[1]);
                        let eb = plan_point(dim.line_segments[2]);
                        let b2 = plan_point(dim.line_segments[3]);
                        let text = dim
                            .labels
                            .first()
                            .map(|l| l.text.clone())
                            .unwrap_or_default();
                        let (text_pos, text_angle) =
                            place_dimension_text(ea, eb, a2, b2, &text, &bubbles);
                        out.dimensions.push(VectorDimension2d {
                            layer: layer.clone(),
                            extension_a: ea,
                            extension_b: eb,
                            dim_a: a2,
                            dim_b: b2,
                            text_position: text_pos,
                            text,
                            text_angle,
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
        // Drawing y is -world Z; callers want world (x, z) bounds.
        let (min, max) = crate::dxf_export::bounds_2d(&drawing)?;
        Some(([min[0], -max[1]], [max[0], -min[1]]))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dimension_text_is_outside_rotated_and_clear_of_bubbles() {
        // Horizontal dim below the measured edge (y-up plan coords).
        let (p, ang) = place_dimension_text(
            [0.0, 0.0],
            [12.0, 0.0],
            [0.0, 1.0],
            [12.0, 1.0],
            "12.00",
            &[],
        );
        assert!(
            ang.abs() < 1e-9 && p[1] > 1.0 && (p[0] - 6.0).abs() < 1e-9,
            "{p:?}"
        );
        // A bubble right at the midpoint pushes the text along the line.
        let (q, _) = place_dimension_text(
            [0.0, 0.0],
            [12.0, 0.0],
            [0.0, 1.0],
            [12.0, 1.0],
            "12.00",
            &[[6.0, 1.2]],
        );
        assert!((q[0] - 6.0).abs() > 0.6, "{q:?}");
        // Vertical dim reads bottom-to-top.
        let (_, v) = place_dimension_text(
            [0.0, 0.0],
            [0.0, -9.0],
            [-1.0, 0.0],
            [-1.0, -9.0],
            "9.00",
            &[],
        );
        assert!((v - std::f64::consts::FRAC_PI_2).abs() < 1e-9);
    }

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

    /// Plans are drawn north-up (world -Z up the page), never mirrored:
    /// y-up 2D coordinates must negate world Z.
    #[test]
    fn plan_points_are_not_mirrored() {
        assert_eq!(plan_point(Vec3::new(1.0, 0.0, 2.0)), [1.0, -2.0]);
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

    /// A closed room of four walls exports as one outer and one inner
    /// outline: no lines across the joins, and no fill over the room.
    #[test]
    fn joined_room_exports_one_outline_without_spill() {
        use crate::param::ParamMap;
        use crate::placement::Placement;
        use crate::Project;

        let mut project = Project::new();
        let level = project.document().active_level_id().expect("level");
        let view_id = project.create_plan_view(level).expect("view");
        let pts = [(0.0, 0.0), (6.0, 0.0), (6.0, 4.0), (0.0, 4.0)];
        for i in 0..4 {
            let (a, b) = (pts[i], pts[(i + 1) % 4]);
            project
                .create_element(
                    "apex.wall",
                    Placement::line(Vec3::new(a.0, 0.0, a.1), Vec3::new(b.0, 0.0, b.1)),
                    ParamMap::new(),
                )
                .expect("wall");
        }
        let drawing = project.vector_export_view(view_id).expect("drawing");
        let cut: Vec<_> = drawing
            .lines
            .iter()
            .filter(|l| l.layer.ends_with("_CUT"))
            .collect();
        // Every outline line sits on the outer (±0.1 beyond) or inner face.
        for l in &cut {
            for p in [l.a, l.b] {
                let on = |v: f64, lo: f64, hi: f64| (v - lo).abs() < 1e-3 || (v - hi).abs() < 1e-3;
                let x_face = on(p[0], -0.1, 6.1) || on(p[0], 0.1, 5.9);
                let z_face = on(-p[1], -0.1, 4.1) || on(-p[1], 0.1, 3.9);
                assert!(x_face && z_face, "outline corner off the faces: {p:?}");
            }
        }
        assert_eq!(cut.len(), 8, "outer + inner rectangle");
        let centre = [3.0, -2.0];
        for fill in &drawing.fills {
            let r = &fill.ring;
            let mut inside = false;
            for i in 0..r.len() {
                let (a, b) = (r[i], r[(i + 1) % r.len()]);
                if (a[1] > centre[1]) != (b[1] > centre[1])
                    && centre[0] < a[0] + (centre[1] - a[1]) / (b[1] - a[1]) * (b[0] - a[0])
                {
                    inside = !inside;
                }
            }
            assert!(!inside, "fill spills over the room");
        }
        assert_eq!(drawing.fills.len(), 4, "one fill per wall share");
    }
}
