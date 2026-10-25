import type { SceneDto, Vec3 } from '../types';

/** Flatten view-annotation overlay segments for a saved view. */
export function viewAnnotationSegments(scene: SceneDto, viewId: string): Vec3[] {
  const segs: Vec3[] = [];
  for (const ann of scene.view_annotations ?? []) {
    if (ann.view_id !== viewId) continue;
    const raw = ann.line_segments ?? [];
    for (const p of raw) {
      segs.push(p);
    }
  }
  return segs;
}
