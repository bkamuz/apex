import type { Vec3 } from '../viewport/ViewportRenderer';
import type {
  ElementSnapGeometryDto,
  ElementSnapKindDto,
  ElementSnapTargetDto,
} from '../wasm/apex';
import type { ToolContext } from './Tool';

/** Screen tolerance (CSS px) for element snaps while placing / editing. */
export const ELEMENT_SNAP_PX = 22;

/** Prefer discrete kinds over edge when scores are close. */
function kindRank(kind: ElementSnapKindDto): number {
  switch (kind) {
    case 'end':
    case 'point':
      return 0;
    case 'vertex':
      return 1;
    case 'mid':
      return 2;
    case 'edge':
      return 3;
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

export interface ElementSnapHit {
  point: Vec3;
  kind: ElementSnapKindDto;
  element_id: string;
}

/**
 * Closest point on segment a→b to p in plan (XZ). Returns null for degenerate
 * segments. Y is lerped along the segment.
 */
export function closestOnSegmentXz(a: Vec3, b: Vec3, p: Vec3): { point: Vec3; t: number } | null {
  const abx = b[0] - a[0];
  const abz = b[2] - a[2];
  const lenSq = abx * abx + abz * abz;
  if (lenSq < 1e-10) return null;
  const apx = p[0] - a[0];
  const apz = p[2] - a[2];
  const t = Math.min(1, Math.max(0, (apx * abx + apz * abz) / lenSq));
  return {
    point: [a[0] + abx * t, a[1] + (b[1] - a[1]) * t, a[2] + abz * t],
    t,
  };
}

/**
 * Nearest element snap under the cursor in screen space. Discrete ends /
 * vertices / mids / points beat edge closest-points. Joinable peer ends are
 * already included in `geometry` from the core collector.
 */
export function findElementSnap(
  ctx: Pick<ToolContext, 'worldToClient'>,
  clientX: number,
  clientY: number,
  geometry: ElementSnapGeometryDto,
  cursorWorld: Vec3,
  tolerancePx = ELEMENT_SNAP_PX,
): ElementSnapHit | null {
  let best: { hit: ElementSnapHit; score: number } | null = null;

  const consider = (target: ElementSnapTargetDto) => {
    const screen = ctx.worldToClient(target.point);
    if (!screen) return;
    const dist = Math.hypot(screen[0] - clientX, screen[1] - clientY);
    if (dist > tolerancePx) return;
    const score = dist + kindRank(target.kind) * 0.01;
    if (best && score >= best.score) return;
    best = {
      hit: {
        point: [...target.point] as Vec3,
        kind: target.kind,
        element_id: target.element_id,
      },
      score,
    };
  };

  for (const target of geometry.points) {
    consider(target);
  }

  for (const seg of geometry.segments) {
    const closest = closestOnSegmentXz(seg.a, seg.b, cursorWorld);
    if (!closest) continue;
    // Endpoints are covered by discrete End/Vertex/Point targets.
    if (closest.t < 0.05 || closest.t > 0.95) continue;
    const screen = ctx.worldToClient(closest.point);
    if (!screen) continue;
    const dist = Math.hypot(screen[0] - clientX, screen[1] - clientY);
    if (dist > tolerancePx) continue;
    const score = dist + kindRank('edge') * 0.01;
    if (best && score >= best.score) continue;
    best = {
      hit: {
        point: closest.point,
        kind: 'edge',
        element_id: seg.element_id,
      },
      score,
    };
  }

  return best?.hit ?? null;
}

export function snapKindLabel(kind: ElementSnapKindDto): string {
  switch (kind) {
    case 'end':
      return 'end';
    case 'mid':
      return 'mid';
    case 'vertex':
      return 'vertex';
    case 'point':
      return 'point';
    case 'edge':
      return 'edge';
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}
