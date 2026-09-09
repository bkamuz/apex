import type { ReferenceKind } from '../types';
import type { Vec3 } from '../viewport/ViewportRenderer';
import type { Tool, ToolContext } from './Tool';

const MIN_PICK_SPACING = 0.1;

function farEnough(a: Vec3, b: Vec3): boolean {
  return Math.hypot(b[0] - a[0], b[2] - a[2]) >= MIN_PICK_SPACING;
}

/** Place a document reference point or plane on the active level. */
export function createReferenceTool(kind: ReferenceKind, label: string): Tool {
  const required = kind === 'point' ? 1 : 2;
  const picks: Vec3[] = [];

  const reset = (ctx: ToolContext) => {
    picks.length = 0;
    ctx.setPending([]);
    ctx.clearPreview();
    ctx.showPreviewLine(null);
    ctx.setTouchOrbitEnabled(true);
  };

  return {
    id: kind === 'point' ? 'ref-point' : 'ref-plane',
    label,
    group: 'create',

    hint(pendingCount) {
      const remaining = required - pendingCount;
      return remaining <= 0
        ? `${label}: placing…`
        : `${label}: click ${remaining} more point${remaining === 1 ? '' : 's'}`;
    },

    onPointerDown(e, ctx) {
      ctx.setTouchOrbitEnabled(false);
      const anchor = picks.length > 0 ? picks[picks.length - 1] : null;
      const point = ctx.resolvePoint(e.clientX, e.clientY, e.shift, anchor);
      if (!point) return true;
      ctx.showSnapMarker(point, e.shift);
      if (anchor && !farEnough(anchor, point)) return true;

      picks.push(point);
      ctx.setPending([...picks]);
      ctx.showPreviewLine([...picks]);

      if (picks.length >= required) {
        ctx.createReference(kind, [...picks]);
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
