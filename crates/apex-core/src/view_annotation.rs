//! View-specific annotations (dimensions, notes) — owned by a saved [`View`], not model geometry.

use std::collections::BTreeMap;
use std::str::FromStr;

use glam::Vec3;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use crate::annotation::AnnotationLabel;
use crate::element::ElementId;
use crate::grid_axis::GridAxisId;
use crate::param::{ParamKind, ParamSpec, ParamValue};
use crate::view::ViewId;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct ViewAnnotationId(Uuid);

impl ViewAnnotationId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for ViewAnnotationId {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Display for ViewAnnotationId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl FromStr for ViewAnnotationId {
    type Err = uuid::Error;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Ok(Self(Uuid::parse_str(s)?))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GridAxisEnd {
    Start,
    End,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AnnotationAnchor {
    World {
        point: [f32; 3],
    },
    ElementAnchor {
        element_id: ElementId,
        anchor_index: u32,
    },
    GridAxisEnd {
        grid_axis_id: GridAxisId,
        end: GridAxisEnd,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ViewAnnotationKind {
    LinearDimension {
        a: AnnotationAnchor,
        b: AnnotationAnchor,
        /// Perpendicular offset from the measured segment (metres, plan XZ).
        offset: f32,
    },
    TextNote {
        position: AnnotationAnchor,
        text: String,
    },
    LeaderTag {
        head: AnnotationAnchor,
        tail: AnnotationAnchor,
        text: String,
    },
}

impl ViewAnnotationKind {
    pub fn category(&self) -> &'static str {
        match self {
            ViewAnnotationKind::LinearDimension { .. } => "dimension",
            ViewAnnotationKind::TextNote { .. } => "text",
            ViewAnnotationKind::LeaderTag { .. } => "tag",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ViewAnnotation {
    pub id: ViewAnnotationId,
    pub view_id: ViewId,
    pub kind: ViewAnnotationKind,
}

impl ViewAnnotation {
    pub fn new(view_id: ViewId, kind: ViewAnnotationKind) -> Self {
        Self {
            id: ViewAnnotationId::new(),
            view_id,
            kind,
        }
    }
}

pub type ViewAnnotationLibrary = BTreeMap<ViewAnnotationId, ViewAnnotation>;

#[allow(dead_code)] // Inspector DTO seam; wired when annotation selection lands in the shell.
pub fn view_annotation_param_specs(kind: &ViewAnnotationKind) -> Vec<ParamSpec> {
    match kind {
        ViewAnnotationKind::LinearDimension { .. } => {
            vec![ParamSpec::length("offset", "Offset", 0.5)]
        }
        ViewAnnotationKind::TextNote { text, .. } | ViewAnnotationKind::LeaderTag { text, .. } => {
            vec![ParamSpec {
                id: "text".to_string(),
                label: "Text".to_string(),
                kind: ParamKind::Text,
                default: ParamValue::Text(text.clone()),
                min: None,
                max: None,
                unit: None,
                binding: crate::param::ParamBinding::Instance,
            }]
        }
    }
}

#[derive(Debug, Clone, PartialEq, Error)]
pub enum ViewAnnotationError {
    #[error("annotation not found")]
    NotFound,
    #[error("view not found")]
    ViewNotFound,
    #[error("could not resolve anchor")]
    UnresolvedAnchor,
}

/// Resolved overlay segments for the viewport / sheet export.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ViewAnnotationOverlay {
    pub line_segments: Vec<Vec3>,
    pub labels: Vec<AnnotationLabel>,
}

pub fn linear_dimension_overlay(a: Vec3, b: Vec3, offset: f32) -> ViewAnnotationOverlay {
    let mut out = ViewAnnotationOverlay::default();
    let ab = b - a;
    let len = ab.length();
    if len < 1e-6 {
        out.labels.push(AnnotationLabel {
            position: a,
            text: "0".into(),
        });
        return out;
    }
    let dir = ab / len;
    let mut perp = Vec3::new(-dir.z, 0.0, dir.x);
    if perp.length_squared() < 1e-8 {
        perp = Vec3::new(1.0, 0.0, 0.0);
    }
    perp = perp.normalize();
    let shift = perp * offset;
    let a2 = a + shift;
    let b2 = b + shift;
    push_segment(&mut out.line_segments, a, a2);
    push_segment(&mut out.line_segments, b, b2);
    push_segment(&mut out.line_segments, a2, b2);
    let mid = (a2 + b2) * 0.5;
    out.labels.push(AnnotationLabel {
        position: mid + Vec3::Y * 0.05,
        text: format!("{:.2}", len),
    });
    out
}

fn push_segment(segments: &mut Vec<Vec3>, p0: Vec3, p1: Vec3) {
    segments.push(p0);
    segments.push(p1);
}
