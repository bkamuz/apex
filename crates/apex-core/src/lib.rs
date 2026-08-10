//! Apex document model: elements, levels, and change notifications.

mod document;
mod element;
mod expr;
mod level;
mod param;
mod placement;

pub use document::{Document, DocumentChange, DocumentChangeKind, ElementSceneEntry, SceneBuffers};
pub use element::{ComponentId, Element, ElementId};
pub use expr::{Expr, ExprError};
pub use level::{Level, LevelId};
pub use param::{ParamError, ParamId, ParamKind, ParamMap, ParamSpec, ParamValue};
pub use placement::{Placement, PlacementError, PlacementKind};

/// Geometry primitives the document is expressed in, re-exported for convenience.
pub use apex_geometry::{
    Curve, Frame, GeometryError, Justification, Profile, TriangleMesh, WallParams,
};
