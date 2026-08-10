//! Apex document model: elements, levels, and change notifications.

mod document;
mod element;
mod level;

pub use document::{Document, DocumentChange, DocumentChangeKind, ElementSceneEntry, SceneBuffers};
pub use element::{Element, ElementCategory, ElementId};
pub use level::{Level, LevelId};

/// Geometry primitives the document is expressed in, re-exported for convenience.
pub use apex_geometry::{
    Curve, Frame, GeometryError, Justification, Profile, TriangleMesh, WallParams,
};
