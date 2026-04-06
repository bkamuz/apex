import * as THREE from 'three';
import type { Document } from '../../core/document';
import { createElementId } from '../../core/document';

export interface RegisterNativeMeshOptions {
  category: string;
  name?: string;
  levelId: string | null;
}

/**
 * Registers a scene mesh in the document and sets userData for selection / queries.
 */
export function registerNativeMesh(
  document: Document,
  mesh: THREE.Mesh,
  opts: RegisterNativeMeshOptions
): string {
  const id = createElementId();
  mesh.userData.elementId = id;
  mesh.userData.apexKind = 'native';

  document.upsert({
    id,
    kind: 'native',
    category: opts.category,
    name: opts.name ?? opts.category,
    levelId: opts.levelId,
    parameters: {},
    geometry: { kind: 'native', objectUuid: mesh.uuid },
  });

  return id;
}

export function unregisterNativeMesh(document: Document, mesh: THREE.Mesh): void {
  const id = mesh.userData.elementId as string | undefined;
  if (id) {
    document.remove(id);
  }
  delete mesh.userData.elementId;
  delete mesh.userData.apexKind;
}
