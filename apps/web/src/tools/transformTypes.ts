import type { Vec3 } from '../viewport/ViewportRenderer';

/** What can be moved or copied with the transform tools. */
export type TransformTargetKind = 'element' | 'reference' | 'grid_axis';

/** Placement anchors captured before a transform gesture begins. */
export interface TransformOriginal {
  kind: TransformTargetKind;
  id: string;
  anchors: Vec3[];
}

export type TransformMode = 'move' | 'copy';

export function deltaVec3(from: Vec3, to: Vec3): Vec3 {
  return [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
}

export function addVec3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function translatedAnchors(anchors: Vec3[], delta: Vec3): Vec3[] {
  return anchors.map((anchor) => addVec3(anchor, delta));
}
