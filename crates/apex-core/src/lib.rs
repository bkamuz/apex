//! Apex document model: elements, levels, and change notifications.

mod annotation;
mod builders;
mod component;
mod construction_line;
mod descriptor;
mod document;
mod dxf_export;
mod element;
mod expr;
mod family;
mod grid_axis;
mod history;
mod level;
mod param;
mod path_join;
mod placement;
mod plan_symbols;
mod project;
mod project_view_annotations;
mod project_views;
mod reference;
mod registry;
mod render3d;
mod room_detect;
mod section_cut;
mod sheet;
mod sheet_scale;
mod sketch;
mod space;
mod svg_export;
mod vector_export;
mod view;
mod view_annotation;
mod viewport_crop;

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
pub use descriptor::{
    param_json_schema, params_json_schema, Descriptor, DescriptorExample, PublishedDescriptor,
    DEFAULT_UNITS,
};
pub use document::{Document, DocumentChange, DocumentChangeKind, ElementSceneEntry, SceneBuffers};
pub use dxf_export::drawing_to_dxf;
pub use element::{ComponentId, Element, ElementId};
pub use expr::{Expr, ExprError};
pub use family::{
    build_opening, emit_opening, FamilyType, OpeningGenerator, OpeningGeometry, OpeningInfill,
    OpeningPart, OpeningPlanSymbol, OpeningRecipe, TYPE_PARAM,
};
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
pub use plan_symbols::opening_plan_symbols;
pub use project::commands::{
    annotation_descriptors, api_catalog, command_descriptors, component_catalog, conventions,
    query_descriptors, Command, CommandError, Query,
};
pub use project::ProjectSnapshot;
pub use project::{boolean_params, Project, ShapeHandle, ShapeInfo, SlabShape};
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
pub use sheet_scale::{
    map_view_drawing_to_sheet_mm, mm_per_model_metre, model_metres_to_paper_mm, plan_bounds_center,
    viewport_size_mm_for_bounds, PAPER_TEXT_HEIGHT_MM, STANDARD_VIEW_SCALES,
};
pub use sketch::{ProfileSketch, SketchConstraint, SketchDimension, SketchError};
pub use space::{
    space_is_auto, space_param_specs, Space, SpaceError, SpaceId, SpaceLibrary, SpaceOverlay,
};
pub use svg_export::drawing_to_svg;
pub use vector_export::{
    mesh_section_loops, ExportUnits, VectorDimension2d, VectorDrawing2d, VectorLine2d, VectorText2d,
};
pub use view::{
    DetailLevel, EdgeStyle, StoredCamera, StoredProjection, View, ViewError, ViewId, ViewKind,
    ViewLibrary, ViewSettings,
};
pub use view_annotation::{
    AnnotationAnchor, GridAxisEnd, ViewAnnotation, ViewAnnotationError, ViewAnnotationId,
    ViewAnnotationKind, ViewAnnotationLibrary, ViewAnnotationOverlay,
};
pub use viewport_crop::{
    clip_segment_to_polygon, default_crop_polygon_uv, normalize_crop_polygon, point_in_polygon,
    CropError,
};

/// Geometry primitives the document is expressed in, re-exported for convenience.
pub use apex_geometry::{Curve, Frame, GeometryError, Justification, Profile, TriangleMesh};
