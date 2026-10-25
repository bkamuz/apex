import type { Vec3 } from '../viewport/ViewportRenderer';
import { ApexIcons } from './icons';
import type { Tool, ToolContext } from './Tool';
import { ApexTabs } from './tabs';

const MIN_PICK_SPACING = 0.1;
const DEFAULT_OFFSET = 0.35;

function farEnough(a: Vec3, b: Vec3): boolean {
  return Math.hypot(b[0] - a[0], b[2] - a[2]) >= MIN_PICK_SPACING;
}

function worldAnchor(point: Vec3) {
  return { kind: 'world' as const, point };
}

/** Linear plan dimension between two picks on the active saved view. */
export function createDimensionTool(): Tool {
  const picks: Vec3[] = [];

  const reset = (ctx: ToolContext) => {
    picks.length = 0;
    ctx.setPending([]);
    ctx.showPreviewLine(null);
    ctx.setTouchOrbitEnabled(true);
  };

  return {
    id: 'apex.dimension',
    label: 'Dimension',
    group: 'create',
    tab: ApexTabs.annotate,
    icon: ApexIcons.sectionCut,
    shortcut: 'D',

    hint(pendingCount) {
      const remaining = 2 - pendingCount;
      return remaining <= 0
        ? 'Dimension: placing…'
        : `Dimension: click ${remaining} more point${remaining === 1 ? '' : 's'}`;
    },

    onPointerDown(e, ctx) {
      const viewId = ctx.activeViewId();
      if (!viewId) {
        ctx.setError('Open a saved plan view to add dimensions.');
        return true;
      }
      ctx.setError(null);
      ctx.setTouchOrbitEnabled(false);
      const anchor = picks.length > 0 ? picks[picks.length - 1] : null;
      const point = ctx.resolvePoint(e.clientX, e.clientY, e.shift, anchor);
      if (!point) return true;
      ctx.showSnapMarker(point, e.shift);
      if (anchor && !farEnough(anchor, point)) return true;

      picks.push(point);
      ctx.setPending([...picks]);
      ctx.showPreviewLine([...picks]);

      if (picks.length >= 2) {
        ctx.createViewAnnotation(viewId, {
          kind: 'linear_dimension',
          a: worldAnchor(picks[0]!),
          b: worldAnchor(picks[1]!),
          offset: DEFAULT_OFFSET,
        });
        reset(ctx);
      }
      return true;
    },

    onPointerMove(e, ctx) {
      const anchor = picks.length > 0 ? picks[picks.length - 1] : null;
      const point = ctx.resolvePoint(e.clientX, e.clientY, e.shift, anchor);
      if (!point) return;
      ctx.showSnapMarker(point, e.shift);
      if (picks.length === 0) return;
      ctx.showPreviewLine([...picks, point]);
    },

    cancel(ctx) {
      reset(ctx);
    },
  };
}
