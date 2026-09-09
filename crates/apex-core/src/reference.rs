//! Reference points and planes — construction geometry stored in the document.
//!
//! These are first-class entities (not component instances) that recipes can
//! resolve through [`crate::component::FrameSource::Ref`].

use std::collections::BTreeMap;
use std::str::FromStr;

use apex_geometry::{Curve, Frame, MIN_CURVE_LENGTH};
use glam::Vec3;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use crate::level::LevelId;
use crate::placement::{Placement, PlacementError, PlacementKind};

pub type ReferenceLibrary = BTreeMap<RefId, Reference>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct RefId(Uuid);

impl RefId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for RefId {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Display for RefId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl FromStr for RefId {
    type Err = uuid::Error;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Ok(Self(Uuid::parse_str(s)?))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReferenceKind {
    Point,
    Plane,
}

impl ReferenceKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Point => "point",
            Self::Plane => "plane",
        }
    }

    pub fn display_name(self) -> &'static str {
        match self {
            Self::Point => "Ref point",
            Self::Plane => "Ref plane",
        }
    }

    pub fn placement_kind(self) -> PlacementKind {
        match self {
            Self::Point => PlacementKind::Point,
            Self::Plane => PlacementKind::TwoPoint,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReferenceFilter {
    Point,
    Plane,
    Any,
}

#[derive(Debug, Clone, PartialEq, Error)]
pub enum ReferenceError {
    #[error(transparent)]
    Placement(#[from] PlacementError),
    #[error("reference plane needs a two-point line placement")]
    NeedsLine,
    #[error("reference '{id}' is a {actual}, expected {expected}")]
    KindMismatch {
        id: String,
        expected: &'static str,
        actual: &'static str,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Reference {
    pub id: RefId,
    pub name: String,
    pub level_id: LevelId,
    pub kind: ReferenceKind,
    pub placement: Placement,
}

impl Reference {
    pub fn new(
        name: impl Into<String>,
        level_id: LevelId,
        kind: ReferenceKind,
        placement: Placement,
    ) -> Self {
        Self {
            id: RefId::new(),
            name: name.into(),
            level_id,
            kind,
            placement,
        }
    }

    /// Resolve this reference to a world frame on its level.
    pub fn frame(&self, work_plane: &Frame) -> Result<Frame, ReferenceError> {
        match self.kind {
            ReferenceKind::Point => self.placement.frame_at(0.0, work_plane).map_err(Into::into),
            ReferenceKind::Plane => plane_frame(&self.placement, work_plane),
        }
    }

    pub fn accepts_filter(&self, filter: ReferenceFilter) -> bool {
        match filter {
            ReferenceFilter::Any => true,
            ReferenceFilter::Point => self.kind == ReferenceKind::Point,
            ReferenceFilter::Plane => self.kind == ReferenceKind::Plane,
        }
    }

    /// Outline segments for viewport gizmos (pairs of world points).
    pub fn gizmo_segments(&self, work_plane: &Frame) -> Result<Vec<Vec3>, ReferenceError> {
        match self.kind {
            ReferenceKind::Point => {
                let origin = self.placement.origin();
                Ok(point_cross(origin, 0.35))
            }
            ReferenceKind::Plane => {
                let frame = self.frame(work_plane)?;
                Ok(plane_square(&frame, 1.0))
            }
        }
    }
}

fn plane_frame(placement: &Placement, work_plane: &Frame) -> Result<Frame, ReferenceError> {
    let curve = placement.curve().ok_or(ReferenceError::NeedsLine)?;
    let Curve::Line { a, b } = curve else {
        return Err(ReferenceError::NeedsLine);
    };
    let origin = *a;
    let mut x_dir = *b - *a;
    x_dir.y = 0.0;
    let x = if x_dir.length_squared() > MIN_CURVE_LENGTH * MIN_CURVE_LENGTH {
        x_dir.normalize()
    } else {
        work_plane.x
    };
    let z = work_plane.z;
    let y = z.cross(x).normalize();
    Ok(Frame::new(origin, x, y, z))
}

fn point_cross(origin: Vec3, half: f32) -> Vec<Vec3> {
    vec![
        origin + Vec3::new(-half, 0.0, 0.0),
        origin + Vec3::new(half, 0.0, 0.0),
        origin + Vec3::new(0.0, 0.0, -half),
        origin + Vec3::new(0.0, 0.0, half),
    ]
}

fn plane_square(frame: &Frame, half: f32) -> Vec<Vec3> {
    let corners = [
        frame.point(-half, -half),
        frame.point(half, -half),
        frame.point(half, half),
        frame.point(-half, half),
    ];
    vec![
        corners[0], corners[1], corners[1], corners[2], corners[2], corners[3], corners[3],
        corners[0],
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::placement::Placement;

    fn ground() -> Frame {
        Frame::horizontal(0.0)
    }

    #[test]
    fn ref_point_frame_follows_work_plane() {
        let reference = Reference::new(
            "P1",
            LevelId::new(),
            ReferenceKind::Point,
            Placement::point(Vec3::new(2.0, 0.0, 3.0)),
        );
        let frame = reference.frame(&ground()).expect("frame");
        assert!((frame.origin - Vec3::new(2.0, 0.0, 3.0)).length() < 1e-5);
        assert!((frame.z - Vec3::Y).length() < 1e-5);
    }

    #[test]
    fn ref_plane_frame_is_horizontal_and_oriented() {
        let reference = Reference::new(
            "PL1",
            LevelId::new(),
            ReferenceKind::Plane,
            Placement::line(Vec3::ZERO, Vec3::new(4.0, 0.0, 0.0)),
        );
        let frame = reference.frame(&ground()).expect("frame");
        assert!((frame.z - Vec3::Y).length() < 1e-5);
        assert!((frame.x - Vec3::X).length() < 1e-5);
    }

    #[test]
    fn ref_plane_rejects_non_line_placement() {
        let reference = Reference::new(
            "PL1",
            LevelId::new(),
            ReferenceKind::Plane,
            Placement::point(Vec3::ZERO),
        );
        assert!(reference.frame(&ground()).is_err());
    }
}
