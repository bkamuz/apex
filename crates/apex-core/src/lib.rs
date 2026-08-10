//! Apex document model: elements, levels, and change notifications.

mod document;
mod element;
mod expr;
mod level;
mod param;

pub use document::{Document, DocumentChange, DocumentChangeKind, ElementSceneEntry, SceneBuffers};
pub use element::{Element, ElementCategory, ElementId};
pub use expr::{Expr, ExprError};
pub use level::{Level, LevelId};
pub use param::{ParamError, ParamId, ParamKind, ParamMap, ParamSpec, ParamValue};

/// Geometry primitives the document is expressed in, re-exported for convenience.
pub use apex_geometry::{
    Curve, Frame, GeometryError, Justification, Profile, TriangleMesh, WallParams,
};
