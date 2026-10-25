/** Normalized crop UV within a viewport frame (u right, v up from bottom-left). */
export type CropUv = [number, number];

export const DEFAULT_CROP_RECT: CropUv[] = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

export function cloneCrop(points: CropUv[]): CropUv[] {
  return points.map((p) => [p[0], p[1]] as CropUv);
}

export function dist2(a: CropUv, b: CropUv): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
}

export function nearestVertexIndex(points: CropUv[], u: number, v: number, threshold = 0.04): number | null {
  let best: number | null = null;
  let bestD = threshold * threshold;
  points.forEach((p, i) => {
    const d = dist2(p, [u, v]);
    if (d <= bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

/** Closest point on segment ab to p; returns t in [0,1]. */
function closestTOnSegment(p: CropUv, a: CropUv, b: CropUv): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-12) return 0;
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq;
  return Math.max(0, Math.min(1, t));
}

export function nearestEdgeInsertion(
  points: CropUv[],
  u: number,
  v: number,
  threshold = 0.035,
): { index: number; point: CropUv } | null {
  if (points.length < 2) return null;
  const p: CropUv = [u, v];
  let best: { index: number; point: CropUv; d: number } | null = null;
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length;
    const a = points[i]!;
    const b = points[j]!;
    const t = closestTOnSegment(p, a, b);
    const q: CropUv = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const d = dist2(p, q);
    if (d <= threshold * threshold && (!best || d < best.d)) {
      best = { index: j, point: [q[0], q[1]], d };
    }
  }
  return best ? { index: best.index, point: best.point } : null;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

export function insertVertex(points: CropUv[], index: number, point: CropUv): CropUv[] {
  const next = cloneCrop(points);
  next.splice(index, 0, [clamp01(point[0]), clamp01(point[1])]);
  return next;
}

export function removeVertex(points: CropUv[], index: number): CropUv[] | null {
  if (points.length <= 3) return null;
  return points.filter((_, i) => i !== index);
}

/** CSS clip-path polygon() percentages (top-left origin). */
export function cropToCssClipPath(points: CropUv[]): string {
  const parts = points.map(([u, v]) => {
    const x = u * 100;
    const y = (1 - v) * 100;
    return `${x.toFixed(3)}% ${y.toFixed(3)}%`;
  });
  return `polygon(${parts.join(', ')})`;
}
