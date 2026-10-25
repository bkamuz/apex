import type { Vec3 } from '../types';
import type { ViewportRenderer } from '../viewport/ViewportRenderer';

function distPointToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-6) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * dx;
  const qy = ay + t * dy;
  return Math.hypot(px - qx, py - qy);
}

export function hitTestLineSegments(
  renderer: ViewportRenderer,
  clientX: number,
  clientY: number,
  segments: Vec3[],
  radiusPx: number,
): boolean {
  for (let i = 0; i + 1 < segments.length; i += 2) {
    const a = renderer.worldToClient(segments[i]!);
    const b = renderer.worldToClient(segments[i + 1]!);
    if (!a || !b) continue;
    if (distPointToSegment(clientX, clientY, a[0], a[1], b[0], b[1]) <= radiusPx) {
      return true;
    }
  }
  return false;
}
