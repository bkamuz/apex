//! Parametric wall: centerline from start→end on the XZ plane (Y up).

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::level::LevelId;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ElementId(Uuid);

impl ElementId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }

    pub fn as_u64(&self) -> u64 {
        let bytes = self.0.as_bytes();
        u64::from_le_bytes(bytes[0..8].try_into().expect("uuid slice"))
    }

    pub fn to_string(&self) -> String {
        self.0.to_string()
    }
}

impl Default for ElementId {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Display for ElementId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::str::FromStr for ElementId {
    type Err = uuid::Error;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Ok(Self(Uuid::parse_str(s)?))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ElementCategory {
    Wall,
    Slab,
    Beam,
    Column,
    Other,
}

impl ElementCategory {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Wall => "wall",
            Self::Slab => "slab",
            Self::Beam => "beam",
            Self::Column => "column",
            Self::Other => "other",
        }
    }
}

/// Parametric wall along a centerline. World axes: X right, Y up, Z depth.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WallParams {
    pub start: [f32; 3],
    pub end: [f32; 3],
    pub height: f32,
    pub thickness: f32,
}

impl WallParams {
    pub fn length(&self) -> f32 {
        let dx = self.end[0] - self.start[0];
        let dy = self.end[1] - self.start[1];
        let dz = self.end[2] - self.start[2];
        (dx * dx + dy * dy + dz * dz).sqrt()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Element {
    pub id: ElementId,
    pub name: String,
    pub category: ElementCategory,
    pub level_id: LevelId,
    pub wall: Option<WallParams>,
}

impl Element {
    pub fn wall(name: impl Into<String>, level_id: LevelId, wall: WallParams) -> Self {
        Self {
            id: ElementId::new(),
            name: name.into(),
            category: ElementCategory::Wall,
            level_id,
            wall: Some(wall),
        }
    }
}
