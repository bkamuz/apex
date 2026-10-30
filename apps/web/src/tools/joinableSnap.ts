import type { Vec3 } from '../viewport/ViewportRenderer';
import type { ToolContext } from './Tool';

/** Screen tolerance (CSS px) for snapping to joinable peer points while placing. */
export const JOINABLE_SNAP_PX = 22;

export type JoinableSnapKind = 'end' | 'mid' | 'vertex';

export interface JoinableSnapTarget {
  point: Vec3;
  kind: JoinableSnapKind;
  element_id: string;
}

/**
 * Nearest joinable snap target under the cursor, measured in screen space
 * (same idea as host-opening snap). Prefers ends over vertices over mids.
 */
export function findJoinableSnap(
  ctx: ToolContext,
  clientX: number,
  clientY: number,
  targets: readonly JoinableSnapTarget[],
  tolerancePx = JOINABLE_SNAP_PX,
): JoinableSnapTarget | null {
  let best: { target: JoinableSnapTarget; score: number } | null = null;
  for (const target of targets) {
    const screen = ctx.worldToClient(target.point);
    if (!screen) continue;
    const dist = Math.hypot(screen[0] - clientX, screen[1] - clientY);
    if (dist > tolerancePx) continue;
    const rank = target.kind === 'end' ? 0 : target.kind === 'vertex' ? 1 : 2;
    const score = dist + rank * 0.01;
    if (best && score >= best.score) continue;
    best = { target, score };
  }
  return best?.target ?? null;
}

/** Resolve a ground point, then snap to a joinable peer when close enough. */
export function resolveJoinablePoint(
  ctx: ToolContext,
  clientX: number,
  clientY: number,
  shift: boolean,
  anchor: Vec3 | null,
  componentId: string,
): { point: Vec3; snapped: JoinableSnapTarget | null } | null {
  const ground = ctx.resolvePoint(clientX, clientY, shift, anchor);
  if (!ground) return null;
  const targets = ctx.joinableSnapTargets(componentId);
  const snapped = findJoinableSnap(ctx, clientX, clientY, targets);
  if (!snapped) return { point: ground, snapped: null };
  // Keep work-plane elevation from the ground hit; snap only XZ.
  return {
    point: [snapped.point[0], ground[1], snapped.point[2]] as Vec3,
    snapped,
  };
}
