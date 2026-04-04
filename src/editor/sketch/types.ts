export type SketchToolType = 
  | 'select'
  | 'wall'
  | 'beam' 
  | 'column'
  | 'slab'
  | 'arcWall'
  | 'equipment';

export type DrawMode = 'point' | 'line' | 'polyline' | 'arc';

export interface SketchPoint {
  x: number;
  y: number; // Elevation (height)
  z: number;
}

export interface SketchOptions {
  gridSize: number;
  snapToGrid: boolean;
  orthoMode: boolean;
  elevation: number; // Y coordinate
}

export const DEFAULT_SKETCH_OPTIONS: SketchOptions = {
  gridSize: 1.0,
  snapToGrid: true,
  orthoMode: false,
  elevation: 0,
};

export const WALL_HEIGHT = 3.0;
export const WALL_THICKNESS = 0.2;
export const BEAM_WIDTH = 0.3;
export const BEAM_HEIGHT = 0.6;
export const COLUMN_SIZE = 0.4;
export const SLAB_THICKNESS = 0.2;
