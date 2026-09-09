//! Seam for future 2D plan annotations (grid labels, dimensions, symbols).
//!
//! Grid axes are the first entity here. A universal family editor can later
//! author profiles and annotation graphics through the same param + overlay path.

use apex_geometry::Frame;
use glam::Vec3;

use crate::param::{ParamMap, ParamSpec};

/// Shared contract for plan-view annotation entities with data-driven params.
///
/// Future text blocks, dimensions, and profile-based symbols should implement
/// this trait so placement, inspector fields, and viewport overlays stay uniform.
pub trait PlanAnnotation {
    fn param_specs() -> &'static [ParamSpec];
    fn resolved_params(&self) -> ParamMap;
    /// Line segments (consecutive point pairs) for WebGL thick-line overlay.
    fn overlay_line_segments(&self, work_plane: &Frame) -> Vec<Vec3>;
    /// Optional label bubbles: world position and text when visible.
    fn overlay_labels(&self, work_plane: &Frame) -> Vec<AnnotationLabel>;
}

#[derive(Debug, Clone, PartialEq)]
pub struct AnnotationLabel {
    pub position: Vec3,
    pub text: String,
}
