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

/** Values are bare scalars; the spec says how to interpret them. */
export type ParamValue = number | boolean | string;

export interface ParamSpecDto {
  id: string;
  label: string;
  kind: ParamKind;
  /** Present when `kind` is `choice`. */
  options?: string[];
  default: ParamValue;
  min?: number;
  max?: number;
  unit?: string;
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
}

export interface ElementListDto {
  id: string;
  name: string;
  component_id: string;
  category: string;
  pick_id: number;
  level_id: string;
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
