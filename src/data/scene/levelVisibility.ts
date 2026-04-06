import * as THREE from 'three';
import type { Document } from '../../core/document';

/**
 * Updates visibility of native meshes based on active level filter.
 * When activeLevelId is null, all native elements are visible.
 */
export function applyNativeLevelVisibility(
  scene: THREE.Scene,
  document: Document,
  activeLevelId: string | null
): void {
  scene.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    if (obj.userData.apexKind !== 'native') return;
    const id = obj.userData.elementId as string | undefined;
    if (!id) return;

    const rec = document.get(id);
    if (!rec || rec.kind !== 'native') return;

    if (activeLevelId === null) {
      obj.visible = true;
      return;
    }
    obj.visible = rec.levelId === activeLevelId;
  });
}
