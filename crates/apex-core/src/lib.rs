//! Apex document model: elements, levels, and change notifications.

mod component;
mod document;
mod element;
mod expr;
mod level;
mod param;
mod placement;
mod project;
mod registry;

pub use component::{
    evaluate_recipe, ComponentDefinition, ComponentSource, DefinitionError, FrameSource,
    GeometryRecipe, MeshBuilder, ModuleId, ProfileId, ProfileLibrary, ProfileSpec, ProfileType,
    RecipeContext, RecipeError,
};
pub use document::{Document, DocumentChange, DocumentChangeKind, ElementSceneEntry, SceneBuffers};
pub use element::{ComponentId, Element, ElementId};
pub use expr::{Expr, ExprError};
pub use level::{Level, LevelId};
pub use param::{ParamBinding, ParamError, ParamId, ParamKind, ParamMap, ParamSpec, ParamValue};
pub use placement::{Placement, PlacementError, PlacementKind};
pub use project::Project;
pub use registry::{builtin_components, ComponentRegistry, RegistryError};

/// Geometry primitives the document is expressed in, re-exported for convenience.
pub use apex_geometry::{Curve, Frame, GeometryError, Justification, Profile, TriangleMesh};
