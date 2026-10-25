//! Per-end path join overrides (Revit-style disallow join / join type).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum JoinStyle {
    #[default]
    Miter,
    Butt,
    Square,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct JoinEndSettings {
    /// When false, this end will not participate in automatic joins.
    #[serde(default = "default_allow_join")]
    pub allow_join: bool,
    #[serde(default)]
    pub style: JoinStyle,
}

fn default_allow_join() -> bool {
    true
}

impl Default for JoinEndSettings {
    fn default() -> Self {
        Self {
            allow_join: true,
            style: JoinStyle::Miter,
        }
    }
}

impl JoinEndSettings {
    pub fn is_default(&self) -> bool {
        *self == Self::default()
    }
}

impl JoinStyle {
    pub fn from_name(name: &str) -> Self {
        match name.trim().to_ascii_lowercase().as_str() {
            "butt" => Self::Butt,
            "square" => Self::Square,
            _ => Self::Miter,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Miter => "miter",
            Self::Butt => "butt",
            Self::Square => "square",
        }
    }
}
