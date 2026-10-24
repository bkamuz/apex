import type { TransformOriginal } from './transformTypes';
import type { Vec3 } from '../viewport/ViewportRenderer';

/** Minimal scene fields needed to extract a translated selection ghost. */
export interface GhostSceneSource {
  positions: ArrayLike<number>;
  normals: ArrayLike<number>;
  indices: ArrayLike<number>;
  pick_ids: ArrayLike<number>;
  elements: { id: string; pick_id: number }[];
}

export interface GhostMesh {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
}

/**
 * Build a translucent ghost of selected element solids, translated by `delta`.
 * Does not touch the document — preview-only overlay geometry.
 *
 * Non-element targets (refs, grids, annotations) have no solid mesh here; the
 * transform tool still draws a preview line for those.
 */
export function buildTranslatedGhostMesh(
  scene: GhostSceneSource,
  originals: TransformOriginal[],
  delta: Vec3,
): GhostMesh | null {
  const pickIds = new Set<number>();
  for (const original of originals) {
    if (original.kind !== 'element') continue;
    const entry = scene.elements.find((el) => el.id === original.id);
    if (entry) pickIds.add(entry.pick_id);
  }
  if (pickIds.size === 0) return null;

  const srcPos = scene.positions;
  const srcNrm = scene.normals;
  const srcIdx = scene.indices;
  const srcPick = scene.pick_ids;
  const triCount = Math.floor(srcIdx.length / 3);

  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const vertexMap = new Map<number, number>();

  const mapVertex = (oldIndex: number): number => {
    const existing = vertexMap.get(oldIndex);
    if (existing !== undefined) return existing;
    const next = positions.length / 3;
    const i3 = oldIndex * 3;
    positions.push(srcPos[i3] + delta[0], srcPos[i3 + 1] + delta[1], srcPos[i3 + 2] + delta[2]);
    normals.push(srcNrm[i3] ?? 0, srcNrm[i3 + 1] ?? 0, srcNrm[i3 + 2] ?? 0);
    vertexMap.set(oldIndex, next);
    return next;
  };

  for (let t = 0; t < triCount; t++) {
    if (!pickIds.has(Number(srcPick[t] ?? 0))) continue;
    const i0 = Number(srcIdx[t * 3]);
    const i1 = Number(srcIdx[t * 3 + 1]);
    const i2 = Number(srcIdx[t * 3 + 2]);
    indices.push(mapVertex(i0), mapVertex(i1), mapVertex(i2));
  }

  if (indices.length === 0) return null;
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
  };
}
