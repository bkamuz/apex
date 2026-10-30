import type { TransformOriginal } from './transformTypes';
import type { Vec3 } from '../viewport/ViewportRenderer';

/** Minimal scene fields needed to extract a translated selection ghost. */
export interface GhostSceneSource {
  positions: ArrayLike<number>;
  normals: ArrayLike<number>;
  indices: ArrayLike<number>;
  pick_ids: ArrayLike<number>;
  elements: { id: string; pick_id: number; parent_id?: string | null }[];
}

export interface GhostMesh {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
}

/**
 * Expand element originals with descendants (doors/windows on a moved wall)
 * so the Move ghost keeps hosted children attached without remeshing.
 */
export function expandTransformOriginals(
  originals: TransformOriginal[],
  elements: { id: string; parent_id?: string | null }[],
): TransformOriginal[] {
  const selected = new Set<string>();
  for (const original of originals) {
    if (original.kind === 'element') selected.add(original.id);
  }
  if (selected.size === 0) return originals;

  let grew = true;
  while (grew) {
    grew = false;
    for (const el of elements) {
      if (!el.parent_id || selected.has(el.id) || !selected.has(el.parent_id)) continue;
      selected.add(el.id);
      grew = true;
    }
  }

  const out: TransformOriginal[] = originals.filter(
    (o) => o.kind !== 'element' || selected.has(o.id),
  );
  for (const el of elements) {
    if (!selected.has(el.id)) continue;
    if (out.some((o) => o.kind === 'element' && o.id === el.id)) continue;
    out.push({ kind: 'element', id: el.id, anchors: [] });
  }
  return out;
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

  // First pass: count matching triangles so we can preallocate.
  let matchTris = 0;
  for (let t = 0; t < triCount; t++) {
    if (pickIds.has(Number(srcPick[t] ?? 0))) matchTris += 1;
  }
  if (matchTris === 0) return null;

  const positions: number[] = [];
  const normals: number[] = [];
  const indices = new Uint32Array(matchTris * 3);
  const vertexMap = new Map<number, number>();
  let indexWrite = 0;

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
    indices[indexWrite++] = mapVertex(Number(srcIdx[t * 3]));
    indices[indexWrite++] = mapVertex(Number(srcIdx[t * 3 + 1]));
    indices[indexWrite++] = mapVertex(Number(srcIdx[t * 3 + 2]));
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices,
  };
}

/** Append two ghost meshes (mover translate + stretch-peer remesh). */
export function mergeGhostMeshes(a: GhostMesh | null, b: GhostMesh | null): GhostMesh | null {
  if (!a) return b;
  if (!b) return a;
  const base = a.positions.length / 3;
  const positions = new Float32Array(a.positions.length + b.positions.length);
  const normals = new Float32Array(a.normals.length + b.normals.length);
  const indices = new Uint32Array(a.indices.length + b.indices.length);
  positions.set(a.positions, 0);
  positions.set(b.positions, a.positions.length);
  normals.set(a.normals, 0);
  normals.set(b.normals, a.normals.length);
  indices.set(a.indices, 0);
  for (let i = 0; i < b.indices.length; i++) {
    indices[a.indices.length + i] = b.indices[i] + base;
  }
  return { positions, normals, indices };
}
