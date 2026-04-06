import * as THREE from 'three';

export interface SelectedObject {
  /** Document element id when registered; otherwise mesh uuid */
  id: string;
  object: THREE.Object3D;
  originalColor?: THREE.Color;
  ifcType?: string;
  elementId?: string | null;
}

export interface EditOperation {
  type: 'move' | 'rotate' | 'scale' | 'boolean' | 'create' | 'delete';
  timestamp: number;
  data: any;
}

export type ToolType = 'select' | 'move' | 'rotate' | 'scale' | 'create' | 'boolean';

export type BooleanOperationType = 'union' | 'subtract' | 'intersect';

export const SELECTION_COLOR = 0x00ff00;
export const HOVER_COLOR = 0xffff00;
