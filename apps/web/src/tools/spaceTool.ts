import type { Vec3 } from '../viewport/ViewportRenderer';
import { ApexIcons } from './icons';
import type { Tool, ToolContext, ToolTab } from './Tool';
import { ApexTabs } from './tabs';

const MIN_PICK_SPACING = 0.1;
const MIN_POINTS = 3;

function farEnough(a: Vec3, b: Vec3): boolean {
  return Math.hypot(b[0] - a[0], b[2] - a[2]) >= MIN_PICK_SPACING;
}

function finishSpace(picks: Vec3[], ctx: ToolContext, reset: (ctx: ToolContext) => void): boolean {
  if (picks.length < MIN_POINTS) {
    ctx.setError(`Need at least ${MIN_POINTS} points to close a space.`);
    return false;
  }
  ctx.createSpace([...picks]);
  reset(ctx);
  return true;
}

/** Place a closed plan space (room) with a polyline gesture on the Spaces tab. */
export function createSpaceTool(tab: ToolTab = ApexTabs.spaces): Tool {
  const picks: Vec3[] = [];

  const reset = (ctx: ToolContext) => {
    picks.length = 0;
    ctx.setPending([]);
    ctx.clearPreview();
    ctx.showPreviewLine(null);
    ctx.setTouchOrbitEnabled(true);
  };

  return {
    id: 'space',
    label: 'Space',
    descriptor: { purpose: 'Outline a room/space as a closed polygon on the active level.' },
    group: 'create',
    tab,
    icon: ApexIcons.space,
    placementKind: () => 'polyline',

    hint(pendingCount) {
      if (pendingCount === 0) {
        return 'Space: click to start · double-click or Enter to close (≥3)';
      }
      if (pendingCount < MIN_POINTS) {
        return `Space: ${pendingCount} picked · need ${MIN_POINTS - pendingCount} more · Enter/double-click to close`;
      }
      return `Space: ${pendingCount} picked · double-click or Enter to close`;
    },

    onPointerDown(e, ctx) {
      ctx.setTouchOrbitEnabled(false);
      const anchor = picks.length > 0 ? picks[picks.length - 1] : null;
      const point = ctx.resolvePoint(e.clientX, e.clientY, e.shift, anchor);
      if (!point) return true;
      ctx.showSnapMarker(point, e.shift);
      if (anchor && !farEnough(anchor, point)) return true;

      picks.push(point);
      ctx.setError(null);
      ctx.setPending([...picks]);
      // Preview open chain; closing edge is implied on finish.
      ctx.showPreviewLine(picks.length >= 2 ? [...picks] : null);
      return true;
    },

    onPointerMove(e, ctx) {
      const anchor = picks.length > 0 ? picks[picks.length - 1] : null;
      const point = ctx.resolvePoint(e.clientX, e.clientY, e.shift, anchor);
      if (!point) return;
      ctx.showSnapMarker(point, e.shift);
      if (picks.length === 0) return;
      const provisional = [...picks, point];
      // Show closing edge back to first once we have enough vertices for a ring.
      if (provisional.length >= MIN_POINTS) {
        ctx.showPreviewLine([...provisional, picks[0]]);
      } else {
        ctx.showPreviewLine(provisional);
      }
    },

    finishGesture(pendingPicks, ctx) {
      const source = pendingPicks.length >= picks.length ? pendingPicks : picks;
      return finishSpace(source, ctx, reset);
    },

    cancel(ctx) {
      reset(ctx);
    },
  };
}
