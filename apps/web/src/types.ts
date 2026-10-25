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
