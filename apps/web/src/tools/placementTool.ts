import type { ComponentDto } from '../types';
import type { Vec3 } from '../viewport/ViewportRenderer';
import { requiredPoints, toolIdForComponent, type Tool, type ToolContext } from './Tool';

/** Below this the picks are effectively the same spot and the core will reject them. */
const MIN_PICK_SPACING = 0.1;

function farEnough(a: Vec3, b: Vec3): boolean {
  return Math.hypot(b[0] - a[0], b[2] - a[2]) >= MIN_PICK_SPACING;
}

/**
 * One tool implementation for every component.
 *
 * The gesture comes from the component's own `placement`, so adding a
 * component adds a toolbar button and nothing else. There is no per-component
 * branch anywhere in this file.
 */
export function createPlacementTool(component: ComponentDto): Tool {
  const needed = requiredPoints(component.placement);
  const picks: Vec3[] = [];

  const reset = (ctx: ToolContext) => {
    picks.length = 0;
    ctx.setPending([]);
    ctx.clearPreview();
    ctx.showPreviewLine(null);
    ctx.setTouchOrbitEnabled(true);
  };

  return {
    id: toolIdForComponent(component),
    label: component.display_name,
    componentId: component.id,

    hint(pendingCount) {
      if (needed === null) {
        return pendingCount === 0
          ? `${component.display_name}: click to start · double-click to finish`
          : `${component.display_name}: ${pendingCount} picked · double-click to finish`;
      }
      const remaining = needed - pendingCount;
      return remaining <= 0
        ? `${component.display_name}: placing…`
        : `${component.display_name}: ${remaining} more click${remaining === 1 ? '' : 's'} · Shift snap · Esc`;
    },

    onClick(e, ctx) {
      const anchor = picks.length > 0 ? picks[picks.length - 1] : null;
      const point = ctx.resolvePoint(e.clientX, e.clientY, e.shift, anchor);
      if (!point) return;

      // A repeated pick would only produce a degenerate placement.
      if (anchor && !farEnough(anchor, point)) {
        ctx.setError(`Pick farther than ${MIN_PICK_SPACING} m from the previous point.`);
        return;
      }

      picks.push(point);
      ctx.setError(null);
      ctx.setPending([...picks]);
      ctx.setTouchOrbitEnabled(false);

      if (needed !== null && picks.length >= needed) {
        const points = [...picks];
        reset(ctx);
        ctx.createElement(component.id, points);
      }
    },

    onPointerMove(e, ctx) {
      const anchor = picks.length > 0 ? picks[picks.length - 1] : null;
      const point = ctx.resolvePoint(e.clientX, e.clientY, e.shift, anchor);
      if (!point) {
        ctx.showSnapMarker(null, e.shift);
        return;
      }
      ctx.showSnapMarker(point, e.shift);
      if (picks.length === 0) return;

      const provisional = [...picks, point];
      ctx.showPreviewLine(provisional);
      // Only ask the core for a ghost once enough picks exist to define one.
      if (needed !== null && provisional.length === needed) {
        ctx.showPreview(component.id, provisional);
      } else if (needed === null && provisional.length >= 2) {
        ctx.showPreview(component.id, provisional);
      } else {
        ctx.clearPreview();
      }
    },

    cancel(ctx) {
      reset(ctx);
    },
  };
}

/** Finish a variable-length gesture (polyline) on double-click. */
export function finishOpenGesture(tool: Tool, picks: Vec3[], ctx: ToolContext): boolean {
  if (!tool.componentId || picks.length < 2) return false;
  ctx.createElement(tool.componentId, picks);
  tool.cancel?.(ctx);
  return true;
}
