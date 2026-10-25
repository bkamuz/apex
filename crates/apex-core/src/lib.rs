//! Apex document model: elements, levels, and change notifications.

mod annotation;
mod builders;
mod component;
mod construction_line;
mod document;
mod element;
mod expr;
mod grid_axis;
mod history;
mod level;
mod param;
mod path_join;
mod placement;
mod project;
mod project_views;
mod reference;
mod registry;
mod room_detect;
mod section_cut;
mod sheet;
mod sketch;
mod space;
mod view;

pub use annotation::{AnnotationLabel, PlanAnnotation};
pub use component::{
    evaluate_recipe, ComponentDefinition, ComponentSource, DefinitionError, FrameSource,
    GeometryRecipe, HostCutSpec, MeshBuilder, ModuleId, PlacementOptions, ProfileId,
    ProfileLibrary, ProfileSpec, ProfileType, RecipeContext, RecipeError,
};
pub use construction_line::{
    construction_line_param_specs, ConstructionLine, ConstructionLineError, ConstructionLineId,
    ConstructionLineLibrary, ConstructionLineOverlay,
};
pub use document::{Document, DocumentChange, DocumentChangeKind, ElementSceneEntry, SceneBuffers};
pub use element::{ComponentId, Element, ElementId};
pub use expr::{Expr, ExprError};
pub use grid_axis::{
    grid_axis_param_specs, GridAxis, GridAxisError, GridAxisId, GridAxisLibrary, GridAxisOverlay,
};
pub use history::History;
pub use level::{Level, LevelId};
pub use param::{ParamBinding, ParamError, ParamId, ParamKind, ParamMap, ParamSpec, ParamValue};
pub use path_join::{
    joinable_segment, peers_for, plan_joins, profile_half_width, JoinUpdate, JoinableSegment,
    PATH_JOIN_SNAP,
};
pub use placement::{Placement, PlacementError, PlacementKind};
pub use project::Project;
pub use project::ProjectSnapshot;
pub use reference::{
    RefId, Reference, ReferenceError, ReferenceFilter, ReferenceKind, ReferenceLibrary,
};
pub use registry::{builtin_components, ComponentRegistry, RegistryError};
pub use room_detect::{detect_room_polygons, wall_centerline_segments, ENDPOINT_SNAP};
pub use section_cut::{
    section_cut_param_specs, SectionCut, SectionCutError, SectionCutId, SectionCutLibrary,
    SectionCutOverlay,
};
pub use sheet::{
    PaperOrientation, PaperSize, Sheet, SheetError, SheetId, SheetLibrary, SheetViewport,
    SheetViewportId,
};
pub use sketch::{ProfileSketch, SketchConstraint, SketchDimension, SketchError};
pub use space::{
    space_is_auto, space_param_specs, Space, SpaceError, SpaceId, SpaceLibrary, SpaceOverlay,
};
pub use view::{
    DetailLevel, EdgeStyle, StoredCamera, StoredProjection, View, ViewError, ViewId, ViewKind,
    ViewLibrary, ViewSettings,
};

/// Geometry primitives the document is expressed in, re-exported for convenience.
pub use apex_geometry::{Curve, Frame, GeometryError, Justification, Profile, TriangleMesh};
