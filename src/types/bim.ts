import * as THREE from 'three';
import type * as OBC from '@thatopen/components';

export interface LoadedModel {
  id: string;
  name: string;
  object: THREE.Object3D;
  box: THREE.Box3;
}

export interface ViewerState {
  isLoaderReady: boolean;
  isLoading: boolean;
  error: string | null;
}

export interface IfcLoaderConfig {
  wasm: {
    path: string;
    absolute: boolean;
  };
  autoSetWasm: boolean;
}

export type WorldType = OBC.World;
