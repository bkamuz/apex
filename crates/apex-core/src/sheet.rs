//! Drawing sheets and viewports (Revit-style sheet layout).

use std::collections::BTreeMap;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use crate::view::{StoredCamera, ViewId};
use crate::viewport_crop::default_crop_polygon_uv;

fn default_lock_navigation() -> bool {
    true
}

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
    Custom,
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
            PaperSize::Custom => (420.0, 297.0),
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
    /// Per-sheet viewport camera override (legacy; sheet viewports use true scale, no pan/zoom).
    #[serde(default)]
    pub camera: Option<StoredCamera>,
    /// World X (metres) shown at viewport centre on sheet.
    #[serde(default)]
    pub anchor_x_m: f32,
    /// World Z (metres) shown at viewport centre on sheet.
    #[serde(default)]
    pub anchor_z_m: f32,
    /// When true, pan/zoom is disabled for this viewport on the sheet.
    #[serde(default = "default_lock_navigation")]
    pub lock_navigation: bool,
    /// Visible crop boundary in normalized frame coordinates (u,v), bottom-left origin.
    #[serde(default = "default_crop_polygon_uv")]
    pub crop_polygon: Vec<[f32; 2]>,
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
            anchor_x_m: 0.0,
            anchor_z_m: 0.0,
            lock_navigation: true,
            crop_polygon: default_crop_polygon_uv(),
        }
    }

    /// Crop ring in sheet mm (bottom-left origin).
    pub fn crop_polygon_mm(&self) -> Vec<[f64; 2]> {
        let left = self.center_x_mm as f64 - self.width_mm as f64 * 0.5;
        let bottom = self.center_y_mm as f64 - self.height_mm as f64 * 0.5;
        let w = self.width_mm as f64;
        let h = self.height_mm as f64;
        self.crop_polygon
            .iter()
            .map(|[u, v]| [left + (*u as f64) * w, bottom + (*v as f64) * h])
            .collect()
    }

    pub fn crop_bbox_mm(&self) -> ([f64; 2], [f64; 2]) {
        let poly = self.crop_polygon_mm();
        crate::viewport_crop::bbox_2d(&poly).unwrap_or_else(|| {
            let left = self.center_x_mm as f64 - self.width_mm as f64 * 0.5;
            let bottom = self.center_y_mm as f64 - self.height_mm as f64 * 0.5;
            (
                [left, bottom],
                [left + self.width_mm as f64, bottom + self.height_mm as f64],
            )
        })
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Sheet {
    pub id: SheetId,
    pub number: String,
    pub name: String,
    pub paper: PaperSize,
    pub orientation: PaperOrientation,
    /// Used when `paper` is [`PaperSize::Custom`].
    #[serde(default = "default_custom_width_mm")]
    pub custom_width_mm: f32,
    #[serde(default = "default_custom_height_mm")]
    pub custom_height_mm: f32,
    pub viewports: Vec<SheetViewport>,
}

fn default_custom_width_mm() -> f32 {
    420.0
}

fn default_custom_height_mm() -> f32 {
    297.0
}

impl Sheet {
    pub fn new(number: impl Into<String>, name: impl Into<String>) -> Self {
        Self {
            id: SheetId::new(),
            number: number.into(),
            name: name.into(),
            paper: PaperSize::default(),
            orientation: PaperOrientation::default(),
            custom_width_mm: default_custom_width_mm(),
            custom_height_mm: default_custom_height_mm(),
            viewports: Vec::new(),
        }
    }

    pub fn paper_size_mm(&self) -> (f32, f32) {
        let (w, h) = match self.paper {
            PaperSize::Custom => (
                self.custom_width_mm.max(10.0),
                self.custom_height_mm.max(10.0),
            ),
            other => other.dimensions_mm(),
        };
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
    #[error("invalid viewport crop polygon")]
    InvalidCrop,
}
