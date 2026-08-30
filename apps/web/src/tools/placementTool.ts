import type { ComponentDto, PlacementKind } from '../types';
import type { Vec3 } from '../viewport/ViewportRenderer';
import {
  requiredPoints,
  toolIdForComponent,
  type Tool,
  type ToolContext,
  type ToolMode,
} from './Tool';

/** Below this the picks are effectively the same spot and the core will reject them. */
const MIN_PICK_SPACING = 0.1;

function farEnough(a: Vec3, b: Vec3): boolean {
  return Math.hypot(b[0] - a[0], b[2] - a[2]) >= MIN_PICK_SPACING;
}

export interface PlacementToolOptions {
  /** Drawable modes. When set, the tool is one toolbar button with a switcher. */
  modes?: ToolMode[];
  defaultMode?: string;
}

/**
 * One tool implementation for every component.
 *
 * The gesture comes from the component's own `placement`, or from the active
 * mode when the plugin offers more than one (wall line / arc / polyline).
 */
export function createPlacementTool(
  component: ComponentDto,
  options: PlacementToolOptions = {},
): Tool {
  const modes = options.modes ?? [];
  let modeId = options.defaultMode ?? modes[0]?.id;
  const picks: Vec3[] = [];

  const activeKind = (): PlacementKind =>
    modes.find((mode) => mode.id === modeId)?.placement ?? component.placement;

  const modeLabel = (): string | undefined => modes.find((mode) => mode.id === modeId)?.label;

  const reset = (ctx: ToolContext) => {
    picks.length = 0;
    ctx.setPending([]);
    ctx.clearPreview();
    ctx.showPreviewLine(null);
    ctx.setTouchOrbitEnabled(true);
  };

  const toolName = () => {
    const mode = modeLabel();
    return mode ? `${component.display_name} · ${mode}` : component.display_name;
  };

  return {
    id: toolIdForComponent(component),
    label: component.display_name,
    group: 'create',
    componentId: component.id,
    modes: modes.length > 0 ? modes : undefined,
    getMode: modes.length > 0 ? () => modeId ?? modes[0].id : undefined,
    setMode:
      modes.length > 0
        ? (id) => {
            if (modes.some((mode) => mode.id === id)) modeId = id;
          }
        : undefined,
    placementKind: () => activeKind(),

    hint(pendingCount) {
      const needed = requiredPoints(activeKind());
      const name = toolName();
      if (needed === null) {
        return pendingCount === 0
          ? `${name}: click to start · double-click to finish`
          : `${name}: ${pendingCount} picked · double-click to finish`;
      }
      const remaining = needed - pendingCount;
      return remaining <= 0
        ? `${name}: placing…`
        : `${name}: ${remaining} more click${remaining === 1 ? '' : 's'} · Shift snap · Esc`;
    },

    onClick(e, ctx) {
      const needed = requiredPoints(activeKind());
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
        const kind = activeKind();
        reset(ctx);
        ctx.createElement(component.id, points, kind);
      }
    },

    onPointerMove(e, ctx) {
      const needed = requiredPoints(activeKind());
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
        ctx.showPreview(component.id, provisional, activeKind());
      } else if (needed === null && provisional.length >= 2) {
        ctx.showPreview(component.id, provisional, activeKind());
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
  ctx.createElement(tool.componentId, picks, tool.placementKind?.());
  tool.cancel?.(ctx);
  return true;
}
