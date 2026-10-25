//! Drawing sheets and viewports (Revit-style sheet layout).

use std::collections::BTreeMap;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use crate::view::{StoredCamera, ViewId};

pub type SheetLibrary = BTreeMap<SheetId, Sheet>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct SheetId(Uuid);

impl SheetId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for SheetId {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Display for SheetId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl FromStr for SheetId {
    type Err = uuid::Error;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Ok(Self(Uuid::parse_str(s)?))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PaperSize {
    A4,
    #[default]
    A3,
    A2,
    A1,
    A0,
}

impl PaperSize {
    /// ISO width × height in millimetres (portrait).
    pub fn dimensions_mm(self) -> (f32, f32) {
        match self {
            PaperSize::A4 => (210.0, 297.0),
            PaperSize::A3 => (297.0, 420.0),
            PaperSize::A2 => (420.0, 594.0),
            PaperSize::A1 => (594.0, 841.0),
            PaperSize::A0 => (841.0, 1189.0),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PaperOrientation {
    Portrait,
    #[default]
    Landscape,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct SheetViewportId(Uuid);

impl SheetViewportId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for SheetViewportId {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Display for SheetViewportId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl FromStr for SheetViewportId {
    type Err = uuid::Error;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Ok(Self(Uuid::parse_str(s)?))
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SheetViewport {
    pub id: SheetViewportId,
    pub view_id: ViewId,
    /// Centre of the viewport on the sheet, millimetres from bottom-left.
    pub center_x_mm: f32,
    pub center_y_mm: f32,
    /// Viewport frame size on the sheet (mm).
    pub width_mm: f32,
    pub height_mm: f32,
    /// Per-sheet viewport camera override (live on sheet).
    #[serde(default)]
    pub camera: Option<StoredCamera>,
    /// When true, pan/zoom is disabled for this viewport on the sheet.
    #[serde(default)]
    pub lock_navigation: bool,
}

impl SheetViewport {
    pub fn new(
        view_id: ViewId,
        center_x_mm: f32,
        center_y_mm: f32,
        width_mm: f32,
        height_mm: f32,
    ) -> Self {
        Self {
            id: SheetViewportId::new(),
            view_id,
            center_x_mm,
            center_y_mm,
            width_mm,
            height_mm,
            camera: None,
            lock_navigation: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Sheet {
    pub id: SheetId,
    pub number: String,
    pub name: String,
    pub paper: PaperSize,
    pub orientation: PaperOrientation,
    pub viewports: Vec<SheetViewport>,
}

impl Sheet {
    pub fn new(number: impl Into<String>, name: impl Into<String>) -> Self {
        Self {
            id: SheetId::new(),
            number: number.into(),
            name: name.into(),
            paper: PaperSize::default(),
            orientation: PaperOrientation::default(),
            viewports: Vec::new(),
        }
    }

    pub fn paper_size_mm(&self) -> (f32, f32) {
        let (w, h) = self.paper.dimensions_mm();
        match self.orientation {
            PaperOrientation::Portrait => (w, h),
            PaperOrientation::Landscape => (h, w),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Error)]
pub enum SheetError {
    #[error("sheet not found")]
    NotFound,
    #[error("view not found")]
    ViewNotFound,
    #[error("viewport not found")]
    ViewportNotFound,
    #[error("view is already placed on sheet {0}")]
    ViewAlreadyPlaced(String),
}
