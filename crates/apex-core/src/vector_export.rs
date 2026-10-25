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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VectorDrawing2d {
    pub units: ExportUnits,
    pub scale_denominator: f32,
    pub lines: Vec<VectorLine2d>,
    pub texts: Vec<VectorText2d>,
    pub dimensions: Vec<VectorDimension2d>,
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
            for chunk in mesh.edges.chunks(6) {
                if chunk.len() < 6 {
                    continue;
                }
                let a = Vec3::new(chunk[0], chunk[1], chunk[2]);
                let b = Vec3::new(chunk[3], chunk[4], chunk[5]);
                if a.y > cut_y + 0.01 && b.y > cut_y + 0.01 {
                    continue;
                }
                out.lines.push(VectorLine2d {
                    layer: layer.clone(),
                    a: plan_point(a),
                    b: plan_point(b),
                });
            }
        }

        let work_plane = self.work_plane(plan_level);
        for axis in self.document().grid_axes() {
            if axis.level_id != plan_level {
                continue;
            }
            if let Ok(overlay) = axis.overlay_geometry(&work_plane) {
                push_segment_lines(&mut out, "GRID", &overlay.line_segments);
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
            if let Ok(overlay) = space.overlay_geometry(&work_plane) {
                push_segment_lines(&mut out, "SPACE", &overlay.line_segments);
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
