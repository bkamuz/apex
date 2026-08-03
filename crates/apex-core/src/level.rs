use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct LevelId(Uuid);

impl LevelId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }

    pub fn to_string(&self) -> String {
        self.0.to_string()
    }
}

impl Default for LevelId {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Display for LevelId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::str::FromStr for LevelId {
    type Err = uuid::Error;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Ok(Self(Uuid::parse_str(s)?))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Level {
    pub id: LevelId,
    pub name: String,
    /// World Y elevation of the level plane.
    pub elevation: f32,
}

impl Level {
    pub fn new(name: impl Into<String>, elevation: f32) -> Self {
        Self {
            id: LevelId::new(),
            name: name.into(),
            elevation,
        }
    }
}
