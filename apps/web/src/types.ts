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
export type ParamKind = 'length' | 'angle' | 'number' | 'bool' | 'text' | 'choice' | 'profile';

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
  | { shape: 'circle'; radius: ExprDto; segments?: number }
  | { shape: 'polygon'; points: [ExprDto, ExprDto][] }
  | { shape: 'named'; id: string }
  | { shape: 'from_param'; param: string };

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

export interface ProfileSketchDto {
    vertices: [number, number][];
    dimensions?: SketchDimensionDto[];
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
  params: ParamSpecDto[];
  /** Opaque here: only the core evaluates recipes. */
  recipe: unknown;
}

export interface ElementDto {
  id: string;
  name: string;
  component_id: string;
  category: string;
  level_id: string;
  /** The picks that defined this element; one draggable handle each. */
  anchors: Vec3[];
  length?: number | null;
  params: Record<string, ParamValue>;
  profile_id?: string | null;
  type_values?: Record<string, ParamValue>;
}

export interface ElementListDto {
  id: string;
  name: string;
  component_id: string;
  category: string;
  pick_id: number;
  level_id: string;
  profile_id?: string | null;
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
  levels: LevelDto[];
  active_level_id: string | null;
  version: number;
  selected_ids: string[];
  /** Primary / first selected id; null when empty. */
  selected_id: string | null;
}
