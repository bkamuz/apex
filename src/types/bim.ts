import * as THREE from 'three';
import type * as OBC from '@thatopen/components';

/** ThatOpen loaded IFC / fragments model: metadata + visibility mapping. */
export interface IfcFragmentModelHandle {
  name?: string;
  properties?: Record<string, Record<string, unknown>>;
  getFragmentMap: (ids: Set<number>) => OBC.ModelIdMap;
}

export interface LoadedModel {
  id: string;
  name: string;
  object: THREE.Object3D;
  box: THREE.Box3;
  fragmentModel?: IfcFragmentModelHandle;
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
