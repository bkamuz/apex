import type { AnnotationAnchorDto, ElementDto, GridAxisDto, SceneDto, Vec3 } from '../types';
import type { ViewportRenderer } from '../viewport/ViewportRenderer';

const POINT_RADIUS_PX = 14;

function screenDist(
  renderer: ViewportRenderer,
  clientX: number,
  clientY: number,
  world: Vec3,
): number {
  const p = renderer.worldToClient(world);
  if (!p) return Number.POSITIVE_INFINITY;
  return Math.hypot(p[0] - clientX, p[1] - clientY);
}

function pickGridAxisEnd(
  renderer: ViewportRenderer,
  clientX: number,
  clientY: number,
  axes: GridAxisDto[],
): AnnotationAnchorDto | null {
  let best: { dist: number; anchor: AnnotationAnchorDto } | null = null;
  for (const axis of axes) {
    const anchors = axis.anchors ?? [];
    if (anchors.length < 2) continue;
    const candidates: { end: 'start' | 'end'; point: Vec3 }[] = [
      { end: 'start', point: anchors[0]! },
      { end: 'end', point: anchors[anchors.length - 1]! },
    ];
    for (const { end, point } of candidates) {
      const dist = screenDist(renderer, clientX, clientY, point);
      if (dist > POINT_RADIUS_PX) continue;
      if (!best || dist < best.dist) {
        best = {
          dist,
          anchor: { kind: 'grid_axis_end', grid_axis_id: axis.id, end },
        };
      }
    }
  }
  return best?.anchor ?? null;
}

function pickElementAnchor(
  renderer: ViewportRenderer,
  pickId: number | null,
  scene: SceneDto,
  elementsWithAnchors: ElementDto[],
  clientX: number,
  clientY: number,
): AnnotationAnchorDto | null {
  if (pickId == null) return null;
  const listEl = scene.elements.find((el) => el.pick_id === pickId);
  if (!listEl) return null;
  const element = elementsWithAnchors.find((el) => el.id === listEl.id);
  if (!element?.anchors?.length) return null;
  let bestIdx = 0;
  let bestDist = Number.POSITIVE_INFINITY;
  element.anchors.forEach((anchor, index) => {
    const dist = screenDist(renderer, clientX, clientY, anchor);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = index;
    }
  });
  if (bestDist > POINT_RADIUS_PX) return null;
  return { kind: 'element_anchor', element_id: element.id, anchor_index: bestIdx };
}

/** Prefer grid/endpoints and element anchors; fall back to a world point on the work plane. */
export function pickAnnotationAnchor(
  renderer: ViewportRenderer,
  scene: SceneDto,
  elementsWithAnchors: ElementDto[],
  clientX: number,
  clientY: number,
  worldFallback: Vec3 | null,
): AnnotationAnchorDto | null {
  const grid = pickGridAxisEnd(renderer, clientX, clientY, scene.grid_axes ?? []);
  if (grid) return grid;
  const pickId = renderer.pick(clientX, clientY);
  const element = pickElementAnchor(
    renderer,
    pickId,
    scene,
    elementsWithAnchors,
    clientX,
    clientY,
  );
  if (element) return element;
  if (worldFallback) return { kind: 'world', point: worldFallback };
  return null;
}
