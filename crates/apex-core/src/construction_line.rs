//! Plan construction lines: two-point drafting segments on the active level.
//!
//! Unlike grid axes, these are infinite-feel guides without bubble labels and
//! do not define a BIM datum plane — they are pure plan annotations.

use std::collections::BTreeMap;
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

pub type ConstructionLineLibrary = BTreeMap<ConstructionLineId, ConstructionLine>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct ConstructionLineId(Uuid);

impl ConstructionLineId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for ConstructionLineId {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Display for ConstructionLineId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl FromStr for ConstructionLineId {
    type Err = uuid::Error;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Ok(Self(Uuid::parse_str(s)?))
    }
}

#[derive(Debug, Clone, PartialEq, Error)]
pub enum ConstructionLineError {
    #[error(transparent)]
    Placement(#[from] PlacementError),
    #[error("construction line needs a two-point line placement")]
    NeedsLine,
}

/// Parameter schema for every construction line instance.
pub fn construction_line_param_specs() -> Vec<ParamSpec> {
    vec![
        ParamSpec {
            id: "label".to_string(),
            label: "Label".to_string(),
            kind: ParamKind::Text,
            default: ParamValue::Text(String::new()),
            min: None,
            max: None,
            unit: None,
            binding: ParamBinding::Instance,
        },
        ParamSpec::length("extension", "Extension", 1.0),
    ]
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ConstructionLine {
    pub id: ConstructionLineId,
    pub name: String,
    pub level_id: LevelId,
    pub placement: Placement,
    pub params: ParamMap,
}

impl ConstructionLine {
    pub fn new(
        name: impl Into<String>,
        level_id: LevelId,
        placement: Placement,
        params: ParamMap,
    ) -> Self {
        Self {
            id: ConstructionLineId::new(),
            name: name.into(),
            level_id,
            placement,
            params,
        }
    }

    pub fn resolved_params(&self) -> ParamMap {
        self.params
            .resolve(&construction_line_param_specs())
            .unwrap_or_else(|_| self.params.clone())
    }

    pub fn overlay_geometry(
        &self,
        work_plane: &Frame,
    ) -> Result<ConstructionLineOverlay, ConstructionLineError> {
        let curve = self
            .placement
            .curve()
            .ok_or(ConstructionLineError::NeedsLine)?;
        let Curve::Line { a, b } = curve else {
            return Err(ConstructionLineError::NeedsLine);
        };
        let params = self.resolved_params();
        let extension = params.number("extension").unwrap_or(1.0) as f32;
        let label = params.text("label").unwrap_or("").to_string();

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

        let mut labels = Vec::new();
        if !label.is_empty() {
            let mid = (ext_start + ext_end) * 0.5;
            labels.push(AnnotationLabel {
                position: mid,
                text: label,
            });
        }

        Ok(ConstructionLineOverlay {
            line_segments: vec![ext_start, ext_end],
            labels,
        })
    }
}

fn construction_line_specs_static() -> &'static [ParamSpec] {
    static SPECS: std::sync::OnceLock<Vec<ParamSpec>> = std::sync::OnceLock::new();
    SPECS.get_or_init(construction_line_param_specs)
}

impl PlanAnnotation for ConstructionLine {
    fn param_specs() -> &'static [ParamSpec] {
        construction_line_specs_static()
    }

    fn resolved_params(&self) -> ParamMap {
        ConstructionLine::resolved_params(self)
    }

    fn overlay_line_segments(&self, work_plane: &Frame) -> Vec<Vec3> {
        self.overlay_geometry(work_plane)
            .map(|overlay| overlay.line_segments)
            .unwrap_or_default()
    }

    fn overlay_labels(&self, work_plane: &Frame) -> Vec<AnnotationLabel> {
        self.overlay_geometry(work_plane)
            .map(|overlay| overlay.labels)
            .unwrap_or_default()
    }
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct ConstructionLineOverlay {
    pub line_segments: Vec<Vec3>,
    pub labels: Vec<AnnotationLabel>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::placement::Placement;

    fn ground() -> Frame {
        Frame::horizontal(0.0)
    }

    #[test]
    fn overlay_extends_beyond_endpoints() {
        let line = ConstructionLine::new(
            "CL 1",
            LevelId::new(),
            Placement::line(Vec3::ZERO, Vec3::new(4.0, 0.0, 0.0)),
            ParamMap::new().with("extension", ParamValue::Length(2.0)),
        );
        let overlay = line.overlay_geometry(&ground()).expect("overlay");
        assert_eq!(overlay.line_segments.len(), 2);
        assert!((overlay.line_segments[0].x + 2.0).abs() < 1e-4);
        assert!((overlay.line_segments[1].x - 6.0).abs() < 1e-4);
        assert!(overlay.labels.is_empty());
    }

    #[test]
    fn label_appears_when_set() {
        let line = ConstructionLine::new(
            "CL 1",
            LevelId::new(),
            Placement::line(Vec3::ZERO, Vec3::new(4.0, 0.0, 0.0)),
            ParamMap::new().with("label", ParamValue::Text("CL-A".into())),
        );
        let overlay = line.overlay_geometry(&ground()).expect("overlay");
        assert_eq!(overlay.labels.len(), 1);
        assert_eq!(overlay.labels[0].text, "CL-A");
    }
}
