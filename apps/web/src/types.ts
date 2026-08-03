export interface WallParamsView {
  start: [number, number, number];
  end: [number, number, number];
  height: number;
  thickness: number;
}

export interface ElementDto {
  id: string;
  name: string;
  category: string;
  level_id: string;
  length?: number | null;
  height?: number | null;
  thickness?: number | null;
  start?: [number, number, number] | null;
  end?: [number, number, number] | null;
}

export interface ElementListDto {
  id: string;
  name: string;
  category: string;
  pick_id: number;
}

export interface SceneDto {
  positions: Float32Array | number[];
  normals: Float32Array | number[];
  indices: Uint32Array | number[];
  pick_ids: Float64Array | number[];
  edge_positions?: Float32Array | number[];
  elements: ElementListDto[];
  version: number;
  selected_id: string | null;
}

export type ToolMode = 'select' | 'wall';
