//! Saved project views (plan, 3D, optional section).

use std::collections::BTreeMap;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use crate::level::LevelId;
use crate::section_cut::SectionCutId;

pub type ViewLibrary = BTreeMap<ViewId, View>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct ViewId(Uuid);

impl ViewId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for ViewId {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Display for ViewId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl FromStr for ViewId {
    type Err = uuid::Error;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Ok(Self(Uuid::parse_str(s)?))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DetailLevel {
    Coarse,
    #[default]
    Medium,
    Fine,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EdgeStyle {
    Hidden,
    #[default]
    Simple,
    Detailed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StoredProjection {
    Perspective,
    #[default]
    Orthographic,
}

/// Orbit camera persisted from the WebGL shell.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StoredCamera {
    pub target: [f32; 3],
    pub distance: f32,
    pub yaw: f32,
    pub pitch: f32,
}

impl Default for StoredCamera {
    fn default() -> Self {
        Self {
            target: [0.0, 1.2, 0.0],
            distance: 18.0,
            yaw: 0.7,
            pitch: 0.55,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ViewKind {
    Plan {
        level_id: LevelId,
        cut_height: f32,
        view_range_top: f32,
        view_range_bottom: f32,
    },
    ThreeD {
        camera: StoredCamera,
        projection: StoredProjection,
    },
    Section {
        section_cut_id: SectionCutId,
        camera: StoredCamera,
    },
}

impl ViewKind {
    pub fn type_label(&self) -> &'static str {
        match self {
            ViewKind::Plan { .. } => "Plan",
            ViewKind::ThreeD { .. } => "3D",
            ViewKind::Section { .. } => "Section",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ViewSettings {
    /// Drawing scale denominator (1:scale).
    pub scale: f32,
    /// When false, geometry in that category is hidden in this view.
    pub category_visible: BTreeMap<String, bool>,
    pub detail_level: DetailLevel,
    pub edge_style: EdgeStyle,
}

impl Default for ViewSettings {
    fn default() -> Self {
        Self {
            scale: 100.0,
            category_visible: BTreeMap::new(),
            detail_level: DetailLevel::Medium,
            edge_style: EdgeStyle::Simple,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct View {
    pub id: ViewId,
    pub name: String,
    pub kind: ViewKind,
    pub settings: ViewSettings,
}

impl View {
    pub fn new(name: impl Into<String>, kind: ViewKind) -> Self {
        Self {
            id: ViewId::new(),
            name: name.into(),
            kind,
            settings: ViewSettings::default(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Error)]
pub enum ViewError {
    #[error("view not found")]
    NotFound,
    #[error("level not found")]
    LevelNotFound,
    #[error("section cut not found")]
    SectionCutNotFound,
    #[error("duplicate view name")]
    DuplicateName,
}
