//! Section-cut MVP: a vertical cutting plane through a two-point plan segment.
//!
//! Semantics match grid axes (segment on the level + world up). This phase only
//! stores the entity and draws a plan overlay (cut line + optional fill hint).
//! Full 3D scene clip / 2D section views come later.

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

pub type SectionCutLibrary = BTreeMap<SectionCutId, SectionCut>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct SectionCutId(Uuid);

impl SectionCutId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for SectionCutId {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Display for SectionCutId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl FromStr for SectionCutId {
    type Err = uuid::Error;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Ok(Self(Uuid::parse_str(s)?))
    }
}

#[derive(Debug, Clone, PartialEq, Error)]
pub enum SectionCutError {
    #[error(transparent)]
    Placement(#[from] PlacementError),
    #[error("section cut needs a two-point line placement")]
    NeedsLine,
}

/// Parameter schema for every section cut instance.
pub fn section_cut_param_specs() -> Vec<ParamSpec> {
    vec![
        ParamSpec {
            id: "label".to_string(),
            label: "Label".to_string(),
            kind: ParamKind::Text,
            default: ParamValue::Text("A".to_string()),
            min: None,
            max: None,
            unit: None,
            binding: ParamBinding::Instance,
        },
        ParamSpec::length("extension", "Extension", 0.5),
        ParamSpec::length("fill_height", "Fill height", 2.5),
        ParamSpec {
            id: "show_fill".to_string(),
            label: "Show fill hint".to_string(),
            kind: ParamKind::Bool,
            default: ParamValue::Bool(true),
            min: None,
            max: None,
            unit: None,
            binding: ParamBinding::Instance,
        },
    ]
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SectionCut {
    pub id: SectionCutId,
    pub name: String,
    pub level_id: LevelId,
    pub placement: Placement,
    pub params: ParamMap,
}

impl SectionCut {
    pub fn new(
        name: impl Into<String>,
        level_id: LevelId,
        placement: Placement,
        params: ParamMap,
    ) -> Self {
        Self {
            id: SectionCutId::new(),
            name: name.into(),
            level_id,
            placement,
            params,
        }
    }

    pub fn resolved_params(&self) -> ParamMap {
        self.params
            .resolve(&section_cut_param_specs())
            .unwrap_or_else(|_| self.params.clone())
    }

    /// Vertical cut plane: X along the segment, Y up, Z horizontal normal.
    pub fn vertical_plane_frame(&self, work_plane: &Frame) -> Result<Frame, SectionCutError> {
        let curve = self.placement.curve().ok_or(SectionCutError::NeedsLine)?;
        let Curve::Line { a, b } = curve else {
            return Err(SectionCutError::NeedsLine);
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

    pub fn overlay_geometry(
        &self,
        work_plane: &Frame,
    ) -> Result<SectionCutOverlay, SectionCutError> {
        let curve = self.placement.curve().ok_or(SectionCutError::NeedsLine)?;
        let Curve::Line { a, b } = curve else {
            return Err(SectionCutError::NeedsLine);
        };
        let params = self.resolved_params();
        let extension = params.number("extension").unwrap_or(0.5) as f32;
        let fill_height = params.number("fill_height").unwrap_or(2.5) as f32;
        let show_fill = params.bool("show_fill").unwrap_or(true);
        let label = params.text("label").unwrap_or("A").to_string();

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
        let mut fill_segments = Vec::new();
        if show_fill && fill_height > 0.0 {
            let top_start = ext_start + Vec3::Y * fill_height;
            let top_end = ext_end + Vec3::Y * fill_height;
            // Rectangle outline on the cut plane as a fill hint.
            fill_segments.extend_from_slice(&[
                ext_start, top_start, top_start, top_end, top_end, ext_end, ext_end, ext_start,
            ]);
        }

        let mid = (ext_start + ext_end) * 0.5;
        let labels = vec![AnnotationLabel {
            position: mid + Vec3::Y * 0.15,
            text: label,
        }];

        let _ = self.vertical_plane_frame(work_plane)?;
        Ok(SectionCutOverlay {
            line_segments,
            fill_segments,
            labels,
        })
    }
}

fn section_cut_specs_static() -> &'static [ParamSpec] {
    static SPECS: std::sync::OnceLock<Vec<ParamSpec>> = std::sync::OnceLock::new();
    SPECS.get_or_init(section_cut_param_specs)
}

impl PlanAnnotation for SectionCut {
    fn param_specs() -> &'static [ParamSpec] {
        section_cut_specs_static()
    }

    fn resolved_params(&self) -> ParamMap {
        SectionCut::resolved_params(self)
    }

    fn overlay_line_segments(&self, work_plane: &Frame) -> Vec<Vec3> {
        self.overlay_geometry(work_plane)
            .map(|overlay| {
                let mut segments = overlay.line_segments;
                segments.extend(overlay.fill_segments);
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
pub struct SectionCutOverlay {
    pub line_segments: Vec<Vec3>,
    pub fill_segments: Vec<Vec3>,
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
    fn vertical_plane_is_upright_and_along_segment() {
        let cut = SectionCut::new(
            "Section A",
            LevelId::new(),
            Placement::line(Vec3::ZERO, Vec3::new(6.0, 0.0, 0.0)),
            ParamMap::new(),
        );
        let frame = cut.vertical_plane_frame(&ground()).expect("frame");
        assert!((frame.y - Vec3::Y).length() < 1e-5);
        assert!((frame.x - Vec3::X).length() < 1e-5);
    }

    #[test]
    fn overlay_includes_fill_hint_when_enabled() {
        let cut = SectionCut::new(
            "Section A",
            LevelId::new(),
            Placement::line(Vec3::ZERO, Vec3::new(4.0, 0.0, 0.0)),
            ParamMap::new()
                .with("fill_height", ParamValue::Length(3.0))
                .with("show_fill", ParamValue::Bool(true)),
        );
        let overlay = cut.overlay_geometry(&ground()).expect("overlay");
        assert_eq!(overlay.line_segments.len(), 2);
        assert_eq!(overlay.fill_segments.len(), 8);
        assert_eq!(overlay.labels.len(), 1);
        assert_eq!(overlay.labels[0].text, "A");
    }

    #[test]
    fn fill_hint_respects_show_fill() {
        let cut = SectionCut::new(
            "Section A",
            LevelId::new(),
            Placement::line(Vec3::ZERO, Vec3::new(4.0, 0.0, 0.0)),
            ParamMap::new().with("show_fill", ParamValue::Bool(false)),
        );
        let overlay = cut.overlay_geometry(&ground()).expect("overlay");
        assert!(overlay.fill_segments.is_empty());
    }
}
