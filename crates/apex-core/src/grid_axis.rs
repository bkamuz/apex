//! Plan grid axes (Revit-style): a vertical datum plane through a level segment.
//!
//! The segment between two picks lies on the active level (horizontal XZ).
//! Semantically the axis defines a **vertical plane** containing that segment
//! and world up — the usual BIM grid plane for plan coordination.

use std::collections::BTreeMap;
use std::f32::consts::TAU;
use std::str::FromStr;

use apex_geometry::{Curve, Frame, MIN_CURVE_LENGTH};
use glam::Vec3;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use crate::annotation::{AnnotationLabel, PlanAnnotation};
use crate::level::LevelId;
use crate::param::{ParamBinding, ParamKind, ParamMap, ParamSpec, ParamValue};
use crate::placement::{Placement, PlacementError};

pub type GridAxisLibrary = BTreeMap<GridAxisId, GridAxis>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct GridAxisId(Uuid);

impl GridAxisId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for GridAxisId {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Display for GridAxisId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl FromStr for GridAxisId {
    type Err = uuid::Error;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Ok(Self(Uuid::parse_str(s)?))
    }
}

#[derive(Debug, Clone, PartialEq, Error)]
pub enum GridAxisError {
    #[error(transparent)]
    Placement(#[from] PlacementError),
    #[error("grid axis needs a two-point line placement")]
    NeedsLine,
}

/// Parameter schema for every grid axis instance.
pub fn grid_axis_param_specs() -> Vec<ParamSpec> {
    vec![
        ParamSpec {
            id: "label".to_string(),
            label: "Label".to_string(),
            kind: ParamKind::Text,
            default: ParamValue::Text("1".to_string()),
            min: None,
            max: None,
            unit: None,
            binding: ParamBinding::Instance,
        },
        ParamSpec {
            id: "show_bubble_start".to_string(),
            label: "Bubble at start".to_string(),
            kind: ParamKind::Bool,
            default: ParamValue::Bool(true),
            min: None,
            max: None,
            unit: None,
            binding: ParamBinding::Instance,
        },
        ParamSpec {
            id: "show_bubble_end".to_string(),
            label: "Bubble at end".to_string(),
            kind: ParamKind::Bool,
            default: ParamValue::Bool(true),
            min: None,
            max: None,
            unit: None,
            binding: ParamBinding::Instance,
        },
        ParamSpec::length("extension", "Extension", 0.5),
        ParamSpec::length("bubble_radius", "Bubble radius", 0.25),
    ]
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GridAxis {
    pub id: GridAxisId,
    pub name: String,
    pub level_id: LevelId,
    pub placement: Placement,
    pub params: ParamMap,
}

impl GridAxis {
    pub fn new(
        name: impl Into<String>,
        level_id: LevelId,
        placement: Placement,
        params: ParamMap,
    ) -> Self {
        Self {
            id: GridAxisId::new(),
            name: name.into(),
            level_id,
            placement,
            params,
        }
    }

    pub fn resolved_params(&self) -> ParamMap {
        self.params
            .resolve(&grid_axis_param_specs())
            .unwrap_or_else(|_| self.params.clone())
    }

    /// Vertical grid plane: X along the segment, Y up, Z horizontal normal.
    pub fn vertical_plane_frame(&self, work_plane: &Frame) -> Result<Frame, GridAxisError> {
        let curve = self.placement.curve().ok_or(GridAxisError::NeedsLine)?;
        let Curve::Line { a, b } = curve else {
            return Err(GridAxisError::NeedsLine);
        };
        let origin = *a;
        let mut x_dir = *b - *a;
        x_dir.y = 0.0;
        let x = if x_dir.length_squared() > MIN_CURVE_LENGTH * MIN_CURVE_LENGTH {
            x_dir.normalize()
        } else {
            work_plane.x
        };
        let y = Vec3::Y;
        let z = x.cross(y).normalize();
        Ok(Frame::new(origin, x, y, z))
    }

    pub fn overlay_geometry(&self, work_plane: &Frame) -> Result<GridAxisOverlay, GridAxisError> {
        let curve = self.placement.curve().ok_or(GridAxisError::NeedsLine)?;
        let Curve::Line { a, b } = curve else {
            return Err(GridAxisError::NeedsLine);
        };
        let params = self.resolved_params();
        let extension = params.number("extension").unwrap_or(0.5) as f32;
        let bubble_radius = params.number("bubble_radius").unwrap_or(0.25) as f32;
        let label = params.text("label").unwrap_or("1").to_string();
        let show_start = params.bool("show_bubble_start").unwrap_or(true);
        let show_end = params.bool("show_bubble_end").unwrap_or(true);

        let mut dir = *b - *a;
        dir.y = 0.0;
        if dir.length_squared() < MIN_CURVE_LENGTH * MIN_CURVE_LENGTH {
            dir = work_plane.x;
        } else {
            dir = dir.normalize();
        }

        let start = *a;
        let end = *b;
        let ext_start = start - dir * extension;
        let ext_end = end + dir * extension;

        let line_segments = vec![ext_start, ext_end];
        let mut bubble_segments = Vec::new();
        let mut labels = Vec::new();

        if show_start {
            bubble_segments.extend(circle_segments(ext_start, bubble_radius, 24));
            labels.push(AnnotationLabel {
                position: ext_start,
                text: label.clone(),
            });
        }
        if show_end {
            bubble_segments.extend(circle_segments(ext_end, bubble_radius, 24));
            labels.push(AnnotationLabel {
                position: ext_end,
                text: label,
            });
        }

        let _ = self.vertical_plane_frame(work_plane)?;
        Ok(GridAxisOverlay {
            line_segments,
            bubble_segments,
            labels,
        })
    }
}

fn grid_axis_specs_static() -> &'static [ParamSpec] {
    static SPECS: std::sync::OnceLock<Vec<ParamSpec>> = std::sync::OnceLock::new();
    SPECS.get_or_init(grid_axis_param_specs)
}

impl PlanAnnotation for GridAxis {
    fn param_specs() -> &'static [ParamSpec] {
        grid_axis_specs_static()
    }

    fn resolved_params(&self) -> ParamMap {
        GridAxis::resolved_params(self)
    }

    fn overlay_line_segments(&self, work_plane: &Frame) -> Vec<Vec3> {
        self.overlay_geometry(work_plane)
            .map(|overlay| {
                let mut segments = overlay.line_segments;
                segments.extend(overlay.bubble_segments);
                segments
            })
            .unwrap_or_default()
    }

    fn overlay_labels(&self, work_plane: &Frame) -> Vec<AnnotationLabel> {
        self.overlay_geometry(work_plane)
            .map(|overlay| overlay.labels)
            .unwrap_or_default()
    }
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct GridAxisOverlay {
    pub line_segments: Vec<Vec3>,
    pub bubble_segments: Vec<Vec3>,
    pub labels: Vec<AnnotationLabel>,
}

fn circle_segments(center: Vec3, radius: f32, segments: u32) -> Vec<Vec3> {
    let mut out = Vec::with_capacity(segments as usize * 2);
    let mut prev = center + Vec3::new(radius, 0.0, 0.0);
    for i in 1..=segments {
        let t = (i as f32 / segments as f32) * TAU;
        let next = center + Vec3::new(t.cos() * radius, 0.0, t.sin() * radius);
        out.push(prev);
        out.push(next);
        prev = next;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::placement::Placement;

    fn ground() -> Frame {
        Frame::horizontal(0.0)
    }

    #[test]
    fn vertical_plane_is_upright_and_along_segment() {
        let axis = GridAxis::new(
            "Grid 1",
            LevelId::new(),
            Placement::line(Vec3::ZERO, Vec3::new(6.0, 0.0, 0.0)),
            ParamMap::new(),
        );
        let frame = axis.vertical_plane_frame(&ground()).expect("frame");
        assert!((frame.y - Vec3::Y).length() < 1e-5);
        assert!((frame.x - Vec3::X).length() < 1e-5);
    }

    #[test]
    fn overlay_extends_beyond_endpoints() {
        let axis = GridAxis::new(
            "Grid 1",
            LevelId::new(),
            Placement::line(Vec3::ZERO, Vec3::new(4.0, 0.0, 0.0)),
            ParamMap::new().with("extension", ParamValue::Length(1.0)),
        );
        let overlay = axis.overlay_geometry(&ground()).expect("overlay");
        assert_eq!(overlay.line_segments.len(), 2);
        assert!((overlay.line_segments[0].x + 1.0).abs() < 1e-4);
        assert!((overlay.line_segments[1].x - 5.0).abs() < 1e-4);
        assert_eq!(overlay.labels.len(), 2);
    }

    #[test]
    fn bubble_visibility_respects_params() {
        let axis = GridAxis::new(
            "Grid 1",
            LevelId::new(),
            Placement::line(Vec3::ZERO, Vec3::new(4.0, 0.0, 0.0)),
            ParamMap::new()
                .with("show_bubble_start", ParamValue::Bool(false))
                .with("show_bubble_end", ParamValue::Bool(true)),
        );
        let overlay = axis.overlay_geometry(&ground()).expect("overlay");
        assert_eq!(overlay.labels.len(), 1);
        assert!((overlay.labels[0].position.x - 4.5).abs() < 1e-3);
    }
}
