export type Vec3 = [number, number, number];

/** Mirrors `PlacementKind` in apex-core. */
export type PlacementKind =
  | 'point'
  | 'two_point'
  | 'three_point_arc'
  | 'polyline'
  | 'path'
  | 'free';

/** Mirrors `ParamKind` in apex-core. */
export type ParamKind =
  | 'length'
  | 'angle'
  | 'number'
  | 'bool'
  | 'text'
  | 'choice'
  | 'profile'
  | 'reference';

export type ReferenceKind = 'point' | 'plane';

/** Whether a parameter lives on the profile/component type or on one element. */
export type ParamBinding = 'type' | 'instance';

/** Values are bare scalars; the spec says how to interpret them. */
export type ParamValue = number | boolean | string;

export interface ParamSpecDto {
  id: string;
  label: string;
  kind: ParamKind;
  /** Present when `kind` is `choice` or `profile`. */
  options?: string[];
  default: ParamValue;
  min?: number;
  max?: number;
  unit?: string;
  /** Omitted in JSON means instance, matching the core default. */
  binding?: ParamBinding;
}

/** Mirrors `Expr` in apex-core. */
export type ExprDto =
  | { op: 'const'; value: number }
  | { op: 'param'; id: string }
  | { op: 'add' | 'sub' | 'mul' | 'div' | 'min' | 'max'; lhs: ExprDto; rhs: ExprDto }
  | { op: 'neg'; value: ExprDto };

/** Mirrors `ProfileSpec` in apex-core. */
export type ProfileSpecDto =
  | { shape: 'rectangle'; width: ExprDto; height: ExprDto }
  | { shape: 'hollow_rectangle'; width: ExprDto; height: ExprDto; wall: ExprDto }
  | { shape: 'circle'; radius: ExprDto; segments?: number }
  | { shape: 'hollow_circle'; radius: ExprDto; wall: ExprDto; segments?: number }
  | { shape: 'polygon'; points: [ExprDto, ExprDto][] }
  | { shape: 'named'; id: string }
  | { shape: 'from_param'; param: string }
  | { shape: 'from_placement' };

/** Mirrors `PlacementOptions` in apex-core. */
export interface PlacementOptionsDto {
  min_points?: number;
  closed?: boolean;
  /** Default true — MEP 3D routes set false. */
  seat_on_level?: boolean;
}

/** Mirrors `HostCutSpec` in apex-core. */
export interface HostCutSpecDto {
  host_categories: string[];
}

/** Mirrors `FrameSource` in apex-core. */
export type FrameSourceDto =
  | { from: 'work_plane' }
  | { from: 'placement_curve'; t: ExprDto }
  | { from: 'ref'; id: string }
  | { from: 'ref_param'; param: string; t?: ExprDto };

/** Mirrors sweep justification in apex-geometry. */
export type JustificationDto = 'center' | 'base_center' | 'top_center';

/** Mirrors `GeometryRecipe` in apex-core. */
export type GeometryRecipeDto =
  | {
      op: 'sweep';
      profile: ProfileSpecDto;
      justification?: JustificationDto;
      start_offset?: ExprDto;
      end_offset?: ExprDto;
    }
  | {
      op: 'extrude';
      profile: ProfileSpecDto;
      frame?: FrameSourceDto;
      height: ExprDto;
    }
  | { op: 'group'; steps: GeometryRecipeDto[] }
  | { op: 'custom'; builder_id: string };

/** A reusable section: shape plus type/instance parameters. */
export interface ProfileTypeDto {
    id: string;
    display_name: string;
    category: string;
    params: ParamSpecDto[];
    spec: ProfileSpecDto;
    type_values: Record<string, ParamValue>;
    formulas?: Record<string, ExprDto>;
    /** Mouse-drawn outline. When present the core compiles it into `spec`. */
    sketch?: ProfileSketchDto;
}

export interface SketchDimensionDto {
    edge: number;
    param: string;
}

export type SketchConstraintDto =
  | { kind: 'equal_length'; edges: number[]; param: string }
  | { kind: 'horizontal'; edge: number }
  | { kind: 'vertical'; edge: number };

export interface ProfileSketchDto {
    vertices: [number, number][];
    dimensions?: SketchDimensionDto[];
    constraints?: SketchConstraintDto[];
    /** Inner loops (holes), fixed geometry in profile XY. */
    holes?: [number, number][][];
}

export interface ProfilePreviewDto {
  outer: [number, number][];
  holes: [number, number][][];
}

/** A component definition as published by the core. Drives toolbar and inspector. */
export interface ComponentDto {
  id: string;
  display_name: string;
  category: string;
  source: 'built_in' | 'visual' | { module: { id: string } };
  placement: PlacementKind;
  placement_options?: PlacementOptionsDto;
  params: ParamSpecDto[];
  recipe: GeometryRecipeDto;
  host_cut?: HostCutSpecDto | null;
  level_height_params?: string[];
  ifc_entity?: string | null;
  /** Opt into universal path joins (corner miters / T-junctions). */
  joinable?: boolean;
  /** Mandatory in core; what the element type is for. */
  descriptor?: import('./descriptor').Descriptor;
  /** Opening families (doors, windows): parametric frame/sash/leaf recipe. */
  opening?: OpeningRecipeDto | null;
  /** Typed families: the type new instances get. */
  default_type?: string | null;
}

/** Mirrors `OpeningRecipe` in apex-core; every number is an `Expr`. */
export interface OpeningRecipeDto {
  width?: ExprDto;
  height?: ExprDto;
  sill?: ExprDto;
  arch_rise?: ExprDto;
  frame_width?: ExprDto;
  frame_depth?: ExprDto | null;
  threshold?: boolean;
  columns?: ExprDto;
  rows?: ExprDto;
  mullion_width?: ExprDto;
  transom_height?: ExprDto;
  infill?: 'glass' | 'leaf';
  sash_width?: ExprDto;
  sash_depth?: ExprDto;
  bars_x?: ExprDto;
  bars_y?: ExprDto;
  bar_width?: ExprDto;
  leaf_thickness?: ExprDto;
  plan_symbol?: 'window' | 'swing' | 'none';
  generator?: string | null;
}

/** A named type of a family (`list_family_types`). */
export interface FamilyTypeDto {
  id: string;
  family: string;
  name: string;
  values: Record<string, ParamValue>;
  default: boolean;
  instances: number;
}

export interface ElementDto {
  id: string;
  name: string;
  component_id: string;
  category: string;
  /** The element's own level. */
  level_id: string;
  /** The level it actually sits on, following parent inheritance. */
  effective_level_id: string;
  /** The element this one is attached to, if any. */
  parent_id?: string | null;
  /** Direct children, so the tree needs no second call. */
  child_ids: string[];
  /** The picks that defined this element; one draggable handle each. */
  anchors: Vec3[];
  length?: number | null;
  params: Record<string, ParamValue>;
  profile_id?: string | null;
  type_values?: Record<string, ParamValue>;
  /** Path-join sweep extensions (metres). */
  join_start?: number;
  join_end?: number;
}

export interface ElementListDto {
  id: string;
  name: string;
  component_id: string;
  category: string;
  pick_id: number;
  level_id: string;
  effective_level_id: string;
  parent_id?: string | null;
  profile_id?: string | null;
}

export interface ReferenceDto {
  id: string;
  name: string;
  kind: ReferenceKind;
  level_id: string;
  anchors: Vec3[];
  gizmo_segments: Vec3[];
  origin?: Vec3;
  normal?: Vec3;
  offset?: number;
}

export interface RoomDetectReportDto {
  created: number;
  loops_found: number;
}

export interface GridAxisLabelDto {
  position: Vec3;
  text: string;
}

export interface GridAxisDto {
  id: string;
  name: string;
  level_id: string;
  anchors: Vec3[];
  line_segments: Vec3[];
  bubble_segments: Vec3[];
  labels: GridAxisLabelDto[];
  params: Record<string, ParamValue>;
  param_specs: ParamSpecDto[];
}

export interface ConstructionLineDto {
  id: string;
  name: string;
  level_id: string;
  anchors: Vec3[];
  line_segments: Vec3[];
  labels: GridAxisLabelDto[];
  params: Record<string, ParamValue>;
  param_specs: ParamSpecDto[];
}

export interface SectionCutDto {
  id: string;
  name: string;
  level_id: string;
  anchors: Vec3[];
  line_segments: Vec3[];
  fill_segments: Vec3[];
  labels: GridAxisLabelDto[];
  params: Record<string, ParamValue>;
  param_specs: ParamSpecDto[];
}

export interface SpaceDto {
  id: string;
  name: string;
  level_id: string;
  anchors: Vec3[];
  line_segments: Vec3[];
  labels: GridAxisLabelDto[];
  params: Record<string, ParamValue>;
  param_specs: ParamSpecDto[];
}

export interface LevelDto {
  id: string;
  name: string;
  elevation: number;
}

export type DetailLevel = 'coarse' | 'medium' | 'fine';
export type EdgeStyle = 'hidden' | 'simple' | 'detailed';
export type StoredProjection = 'perspective' | 'orthographic';
export type PaperSize = 'A4' | 'A3' | 'A2' | 'A1' | 'A0' | 'custom';
export type PaperOrientation = 'portrait' | 'landscape';

export interface StoredCameraDto {
  target: Vec3;
  distance: number;
  yaw: number;
  pitch: number;
}

export type ViewKindDto =
  | {
      kind: 'plan';
      level_id: string;
      cut_height: number;
      view_range_top: number;
      view_range_bottom: number;
    }
  | {
      kind: 'three_d';
      camera: StoredCameraDto;
      projection: StoredProjection;
    }
  | {
      kind: 'section';
      section_cut_id: string;
      camera: StoredCameraDto;
    };

export interface ViewSettingsDto {
  scale: number;
  category_visible: Record<string, boolean>;
  detail_level: DetailLevel;
  edge_style: EdgeStyle;
}

export interface ViewDto {
  id: string;
  name: string;
  type_label: string;
  kind: ViewKindDto;
  settings: ViewSettingsDto;
}

export interface SheetViewportDto {
  id: string;
  view_id: string;
  center_x_mm: number;
  center_y_mm: number;
  width_mm: number;
  height_mm: number;
  anchor_x_m?: number;
  anchor_z_m?: number;
  camera?: StoredCameraDto | null;
  lock_navigation?: boolean;
  /** Normalized crop ring (u,v) within frame; default full rectangle. */
  crop_polygon?: CropUvDto[];
}

export type CropUvDto = [number, number];

export interface ViewAnnotationDto {
  id: string;
  view_id: string;
  category: string;
  kind: ViewAnnotationKindDto;
  line_segments: Vec3[];
  labels: GridAxisLabelDto[];
}

export type ViewAnnotationKindDto =
  | {
      kind: 'linear_dimension';
      a: AnnotationAnchorDto;
      b: AnnotationAnchorDto;
      offset: number;
    }
  | { kind: 'text_note'; position: AnnotationAnchorDto; text: string }
  | {
      kind: 'leader_tag';
      head: AnnotationAnchorDto;
      tail: AnnotationAnchorDto;
      text: string;
    };

export type AnnotationAnchorDto =
  | { kind: 'world'; point: Vec3 }
  | { kind: 'element_anchor'; element_id: string; anchor_index: number }
  | { kind: 'grid_axis_end'; grid_axis_id: string; end: 'start' | 'end' };

export interface VectorLine2dDto {
  layer: string;
  a: [number, number];
  b: [number, number];
}

export interface VectorText2dDto {
  layer: string;
  position: [number, number];
  height: number;
  text: string;
  /** Centre the text on `position` (room tags, grid bubbles). */
  centered?: boolean;
}

export interface VectorFill2dDto {
  layer: string;
  ring: [number, number][];
}

export interface VectorDimension2dDto {
  layer: string;
  extension_a: [number, number];
  extension_b: [number, number];
  dim_a: [number, number];
  dim_b: [number, number];
  text_position: [number, number];
  text: string;
}

export interface VectorDrawing2d {
  units: 'metres' | 'millimetres';
  scale_denominator: number;
  lines: VectorLine2dDto[];
  texts: VectorText2dDto[];
  dimensions: VectorDimension2dDto[];
  fills?: VectorFill2dDto[];
}

export interface SheetDto {
  id: string;
  number: string;
  name: string;
  paper: PaperSize;
  orientation: PaperOrientation;
  custom_width_mm?: number;
  custom_height_mm?: number;
  width_mm: number;
  height_mm: number;
  viewports: SheetViewportDto[];
}

export interface MeshDto {
  positions: Float32Array | number[];
  normals: Float32Array | number[];
  indices: Uint32Array | number[];
  edge_positions: Float32Array | number[];
}

export interface SceneDto {
  positions: Float32Array | number[];
  normals: Float32Array | number[];
  indices: Uint32Array | number[];
  pick_ids: Float64Array | number[];
  edge_positions?: Float32Array | number[];
  elements: ElementListDto[];
  references?: ReferenceDto[];
  grid_axes?: GridAxisDto[];
  construction_lines?: ConstructionLineDto[];
  section_cuts?: SectionCutDto[];
  spaces?: SpaceDto[];
  views?: ViewDto[];
  sheets?: SheetDto[];
  view_annotations?: ViewAnnotationDto[];
  /** Door swing / window glazing segment pairs on the active level. */
  plan_symbols?: Vec3[];
  levels: LevelDto[];
  active_level_id: string | null;
  version: number;
  selected_ids: string[];
  /** Primary / first selected id; null when empty. */
  selected_id: string | null;
  selected_ref_id?: string | null;
  selected_grid_axis_id?: string | null;
  selected_construction_line_id?: string | null;
  selected_section_cut_id?: string | null;
  selected_space_id?: string | null;
  can_undo?: boolean;
  can_redo?: boolean;
  fit_bounds_min?: Vec3 | null;
  fit_bounds_max?: Vec3 | null;
  room_detect_report?: RoomDetectReportDto | null;
}

/** A slab's sub-element shape: Z offsets per vertex, interior points, creases. */
export interface SlabShapeDto {
  z: number[];
  /** Interior points: [x, z, dz]. */
  points: [number, number, number][];
  /** Crease index pairs: boundary vertices first, then points. */
  creases: [number, number][];
}

export interface SlabShapeHandleDto {
  kind: 'vertex' | 'point';
  index: number;
  crease_index: number;
  position: Vec3;
  offset: number;
}

export interface SlabShapeInfoDto {
  shape: SlabShapeDto;
  handles: SlabShapeHandleDto[];
  creases: [Vec3, Vec3][];
  thickness: number;
}
