import type { ComponentDto } from '../types';
import type { Vec3 } from '../viewport/ViewportRenderer';
import { COMPONENT_ICON_BY_ID } from './icons';
import { toolIdForComponent, type Tool, type ToolContext, type ToolTab } from './Tool';
import { ApexTabs } from './tabs';

/** How far (CSS px) from a host's centerline the cursor may be and still snap. */
export const HOST_SNAP_PX = 28;

interface HostSnap {
  hostId: string;
  /** Insertion point, projected onto the host's centerline. */
  point: Vec3;
  /** Screen distance from the cursor to that centerline. */
  distance: number;
}

function closestOnSegment(p: Vec3, a: Vec3, b: Vec3): Vec3 {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const len2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
  if (len2 < 1e-12) return [...a] as Vec3;
  let t = ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / len2;
  t = Math.max(0, Math.min(1, t));
  return [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t];
}

/**
 * Nearest eligible host to the cursor, measured on screen against each host's
 * pick polyline (a wall's centerline). Data-driven: eligibility comes from the
 * component's `host_cut.host_categories`, not from per-type checks.
 */
export function findHostSnap(
  ctx: ToolContext,
  clientX: number,
  clientY: number,
  ground: Vec3 | null,
  allowed: readonly string[],
  tolerancePx = HOST_SNAP_PX,
): HostSnap | null {
  const hit = ctx.pickElementId(clientX, clientY);
  let best: HostSnap | null = null;
  for (const host of ctx.hostCandidates()) {
    if (allowed.length > 0 && !allowed.includes(host.category)) continue;
    if (host.anchors.length < 2) continue;
    for (let i = 0; i + 1 < host.anchors.length; i += 1) {
      const a = host.anchors[i];
      const b = host.anchors[i + 1];
      const sa = ctx.worldToClient(a);
      const sb = ctx.worldToClient(b);
      if (!sa || !sb) continue;
      const dx = sb[0] - sa[0];
      const dy = sb[1] - sa[1];
      const len2 = dx * dx + dy * dy;
      let t = len2 < 1e-9 ? 0 : ((clientX - sa[0]) * dx + (clientY - sa[1]) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const distance = Math.hypot(sa[0] + dx * t - clientX, sa[1] + dy * t - clientY);
      // A direct hit on the host's body always counts, however far the
      // centerline is on screen (tall walls in 3D).
      const within = distance <= tolerancePx || hit === host.id;
      if (!within) continue;
      const effective = hit === host.id ? Math.min(distance, 0) : distance;
      if (best && effective >= best.distance) continue;
      const point = ground
        ? closestOnSegment(ground, a, b)
        : ([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t] as Vec3);
      best = { hostId: host.id, point, distance: effective };
    }
  }
  return best;
}

/**
 * Place an opening on a host element in one click: the cursor snaps to the
 * nearest eligible host within a screen tolerance, the ghost previews there,
 * and the click places the opening as the host's child so the host-cut seam
 * punches a void.
 */
export function createHostedPlacementTool(
  component: ComponentDto,
  tab: ToolTab = ApexTabs.building,
): Tool {
  const allowed = component.host_cut?.host_categories ?? [];
  const hostLabel = allowed.join('/') || 'host';

  const clear = (ctx: ToolContext) => {
    ctx.setPending([]);
    ctx.clearPreview();
    ctx.showPreviewLine(null);
    ctx.showSnapMarker(null, false);
  };

  const snapAt = (clientX: number, clientY: number, ctx: ToolContext) =>
    findHostSnap(ctx, clientX, clientY, ctx.resolvePoint(clientX, clientY, false, null), allowed);

  return {
    id: toolIdForComponent(component),
    label: component.display_name,
    group: 'create',
    tab,
    icon: COMPONENT_ICON_BY_ID[component.id],
    componentId: component.id,
    placementKind: () => 'point',

    hint() {
      return `${component.display_name}: move near a ${hostLabel} and click to place · Esc`;
    },

    onClick(e, ctx) {
      const snap = snapAt(e.clientX, e.clientY, ctx);
      if (!snap) {
        ctx.setError(`No ${hostLabel} nearby — move the cursor closer to a ${hostLabel}.`);
        return;
      }
      clear(ctx);
      ctx.setError(null);
      ctx.createElementWithParent(component.id, [snap.point], snap.hostId, 'point');
    },

    onPointerMove(e, ctx) {
      const snap = snapAt(e.clientX, e.clientY, ctx);
      if (!snap) {
        clear(ctx);
        return;
      }
      ctx.showSnapMarker(snap.point, true);
      ctx.showPreview(component.id, [snap.point], 'point');
    },

    cancel(ctx) {
      clear(ctx);
      ctx.setTouchOrbitEnabled(true);
    },
  };
}
