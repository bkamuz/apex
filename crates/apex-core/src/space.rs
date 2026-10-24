//! Plan spaces: closed polylines on the active level (rooms / areas).
//!
//! Spaces are plan annotations, not mesh components. Overlay draws the closed
//! boundary; the label sits at the centroid. An optional height param is stored
//! for a future volume extrusion and is unused for mesh this phase.

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

pub type SpaceLibrary = BTreeMap<SpaceId, Space>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct SpaceId(Uuid);

impl SpaceId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for SpaceId {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Display for SpaceId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl FromStr for SpaceId {
    type Err = uuid::Error;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Ok(Self(Uuid::parse_str(s)?))
    }
}

#[derive(Debug, Clone, PartialEq, Error)]
pub enum SpaceError {
    #[error(transparent)]
    Placement(#[from] PlacementError),
    #[error("space needs a closed polyline with at least 3 points")]
    NeedsClosedPolyline,
}

/// Parameter schema for every space instance.
pub fn space_param_specs() -> Vec<ParamSpec> {
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
        // Stored for a future 3D volume; unused for mesh / solid fill this phase.
        ParamSpec::length("height", "Height", 2.5),
    ]
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Space {
    pub id: SpaceId,
    pub name: String,
    pub level_id: LevelId,
    pub placement: Placement,
    pub params: ParamMap,
}

impl Space {
    pub fn new(
        name: impl Into<String>,
        level_id: LevelId,
        placement: Placement,
        params: ParamMap,
    ) -> Self {
        Self {
            id: SpaceId::new(),
            name: name.into(),
            level_id,
            placement,
            params,
        }
    }

    pub fn resolved_params(&self) -> ParamMap {
        self.params
            .resolve(&space_param_specs())
            .unwrap_or_else(|_| self.params.clone())
    }

    fn boundary_points(&self) -> Result<&[Vec3], SpaceError> {
        let curve = self
            .placement
            .curve()
            .ok_or(SpaceError::NeedsClosedPolyline)?;
        let Curve::Polyline { points } = curve else {
            return Err(SpaceError::NeedsClosedPolyline);
        };
        if points.len() < 3 {
            return Err(SpaceError::NeedsClosedPolyline);
        }
        Ok(points)
    }

    /// Planar centroid of the closed ring (average of vertices).
    pub fn centroid(points: &[Vec3]) -> Vec3 {
        let n = points.len() as f32;
        let sum = points.iter().copied().fold(Vec3::ZERO, |acc, p| acc + p);
        sum / n
    }

    pub fn overlay_geometry(&self, _work_plane: &Frame) -> Result<SpaceOverlay, SpaceError> {
        let points = self.boundary_points()?;
        // Drop a trailing duplicate of the first point if the author closed the
        // ring in the stored polyline; overlay always closes explicitly.
        let ring: Vec<Vec3> = if points.len() > 3 && points.first() == points.last() {
            points[..points.len() - 1].to_vec()
        } else {
            points.to_vec()
        };
        if ring.len() < 3 {
            return Err(SpaceError::NeedsClosedPolyline);
        }

        let mut perimeter = 0.0_f32;
        for i in 0..ring.len() {
            let a = ring[i];
            let b = ring[(i + 1) % ring.len()];
            perimeter += (b - a).length();
        }
        if perimeter < MIN_CURVE_LENGTH {
            return Err(SpaceError::NeedsClosedPolyline);
        }

        // Edge pairs for WebGL thick-line overlay + hit testing.
        let mut line_segments = Vec::with_capacity(ring.len() * 2);
        for i in 0..ring.len() {
            line_segments.push(ring[i]);
            line_segments.push(ring[(i + 1) % ring.len()]);
        }

        let params = self.resolved_params();
        let label_text = params.text("label").unwrap_or("").trim().to_string();
        let text = if label_text.is_empty() {
            self.name.clone()
        } else {
            label_text
        };
        let labels = vec![AnnotationLabel {
            position: Self::centroid(&ring),
            text,
        }];

        Ok(SpaceOverlay {
            line_segments,
            labels,
        })
    }
}

fn space_specs_static() -> &'static [ParamSpec] {
    static SPECS: std::sync::OnceLock<Vec<ParamSpec>> = std::sync::OnceLock::new();
    SPECS.get_or_init(space_param_specs)
}

impl PlanAnnotation for Space {
    fn param_specs() -> &'static [ParamSpec] {
        space_specs_static()
    }

    fn resolved_params(&self) -> ParamMap {
        Space::resolved_params(self)
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
pub struct SpaceOverlay {
    pub line_segments: Vec<Vec3>,
    pub labels: Vec<AnnotationLabel>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::placement::PlacementKind;

    fn ground() -> Frame {
        Frame::horizontal(0.0)
    }

    fn square_space(label: &str) -> Space {
        let points = [
            Vec3::ZERO,
            Vec3::new(4.0, 0.0, 0.0),
            Vec3::new(4.0, 0.0, 3.0),
            Vec3::new(0.0, 0.0, 3.0),
        ];
        let placement = PlacementKind::Polyline
            .build(&points, 0.0, &ground())
            .expect("placement");
        Space::new(
            "Space 1",
            LevelId::new(),
            placement,
            ParamMap::new().with("label", ParamValue::Text(label.into())),
        )
    }

    #[test]
    fn closed_overlay_has_four_edges() {
        let space = square_space("");
        let overlay = space.overlay_geometry(&ground()).expect("overlay");
        assert_eq!(overlay.line_segments.len(), 8);
        assert_eq!(overlay.labels.len(), 1);
        assert_eq!(overlay.labels[0].text, "Space 1");
        let c = overlay.labels[0].position;
        assert!((c.x - 2.0).abs() < 1e-4);
        assert!((c.z - 1.5).abs() < 1e-4);
    }

    #[test]
    fn label_param_overrides_name() {
        let space = square_space("Kitchen");
        let overlay = space.overlay_geometry(&ground()).expect("overlay");
        assert_eq!(overlay.labels[0].text, "Kitchen");
    }

    #[test]
    fn two_points_are_rejected() {
        let placement = Placement::line(Vec3::ZERO, Vec3::new(4.0, 0.0, 0.0));
        let space = Space::new("Space 1", LevelId::new(), placement, ParamMap::new());
        assert!(matches!(
            space.overlay_geometry(&ground()),
            Err(SpaceError::NeedsClosedPolyline)
        ));
    }
}
