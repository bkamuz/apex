import { describeFromComponent } from '../descriptor';
import { componentDisplayName, modeDisplayLabel, pluralS, t } from '../i18n';
import type { ComponentDto, PlacementKind } from '../types';
import type { Vec3 } from '../viewport/ViewportRenderer';
import { COMPONENT_ICON_BY_ID, type ToolIcon } from './icons';
import {
  requiredPoints,
  toolIdForComponent,
  type Tool,
  type ToolContext,
  type ToolMode,
  type ToolTab,
} from './Tool';

/** Below this the picks are effectively the same spot and the core will reject them. */
const MIN_PICK_SPACING = 0.1;

function farEnough(a: Vec3, b: Vec3): boolean {
  return Math.hypot(b[0] - a[0], b[2] - a[2]) >= MIN_PICK_SPACING;
}

function nearPoint(a: Vec3, b: Vec3, tolerance = MIN_PICK_SPACING): boolean {
  return Math.hypot(b[0] - a[0], b[2] - a[2]) < tolerance;
}

export interface PlacementToolOptions {
  /** Drawable modes. When set, the tool is one toolbar button with a switcher. */
  modes?: ToolMode[];
  defaultMode?: string;
  /** Prefer `ApexTabs.building` / `ApexTabs.engineering`; custom `{ id, label }` creates a new tab. */
  tab?: ToolTab;
  /** Prefer `ApexIcons.*`; falls back to the component→icon map when omitted. */
  icon?: ToolIcon;
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
  /** First point of an open/closed chain (joinable two-point walls). */
  let chainStart: Vec3 | null = null;
  /** Extra world-Y for free-elevation routes (MEP risers). */
  let elevationOffset = 0;
  const freeElevation = component.placement_options?.seat_on_level === false;

  const activeKind = (): PlacementKind =>
    modes.find((mode) => mode.id === modeId)?.placement ?? component.placement;

  const activeMode = (): ToolMode | undefined => modes.find((mode) => mode.id === modeId);

  const applyElevation = (point: Vec3): Vec3 =>
    freeElevation ? [point[0], point[1] + elevationOffset, point[2]] : point;

  const chainWalls = (): boolean =>
    component.joinable === true && activeKind() === 'two_point';

  const reset = (ctx: ToolContext) => {
    picks.length = 0;
    chainStart = null;
    ctx.setPending([]);
    ctx.clearPreview();
    ctx.showPreviewLine(null);
    ctx.setTouchOrbitEnabled(true);
  };

  const toolName = () => {
    const base = componentDisplayName(component.id, component.display_name);
    const mode = activeMode();
    return mode ? `${base} · ${modeDisplayLabel(mode)}` : base;
  };

  return {
    id: toolIdForComponent(component),
    label: component.display_name,
    descriptor: describeFromComponent(component),
    group: 'create',
    tab: options.tab,
    icon: options.icon ?? COMPONENT_ICON_BY_ID[component.id],
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
      const elev =
        freeElevation && elevationOffset !== 0
          ? t('placement.elevOffset', {
              offset: `${elevationOffset >= 0 ? '+' : ''}${elevationOffset.toFixed(2)}`,
            })
          : freeElevation
            ? t('placement.elevNudge')
            : '';
      if (chainWalls() && pendingCount >= 1) {
        return t('placement.chainNext', { name, elev });
      }
      if (needed === null) {
        return pendingCount === 0
          ? t('placement.pathStart', { name, elev })
          : t('placement.pathContinue', { name, n: pendingCount, elev });
      }
      const remaining = needed - pendingCount;
      return remaining <= 0
        ? t('placement.placing', { name })
        : t('placement.moreClicks', {
            name,
            n: remaining,
            s: pluralS(remaining),
            elev,
          });
    },

    onClick(e, ctx) {
      const needed = requiredPoints(activeKind());
      const anchor = picks.length > 0 ? picks[picks.length - 1] : null;
      // Element snaps (including joinable peers) live inside resolvePoint.
      const resolved = ctx.resolvePoint(e.clientX, e.clientY, e.shift, anchor);
      if (!resolved) return;
      const point = applyElevation(resolved);

      if (
        chainWalls() &&
        chainStart &&
        anchor &&
        nearPoint(point, chainStart) &&
        !nearPoint(point, anchor)
      ) {
        ctx.setError(null);
        const segment: Vec3[] = [anchor, chainStart];
        ctx.createElement(component.id, segment, activeKind());
        reset(ctx);
        return;
      }

      // A repeated pick would only produce a degenerate placement.
      if (anchor && !farEnough(anchor, point) && Math.abs(anchor[1] - point[1]) < MIN_PICK_SPACING) {
        ctx.setError(`Pick farther than ${MIN_PICK_SPACING} m from the previous point.`);
        return;
      }

      if (picks.length === 0) chainStart = point;
      picks.push(point);
      ctx.setError(null);
      ctx.setPending([...picks]);
      ctx.setTouchOrbitEnabled(false);

      if (needed !== null && picks.length >= needed) {
        const points = [...picks];
        const kind = activeKind();
        if (chainWalls() && needed === 2) {
          ctx.createElement(component.id, points, kind);
          const last = points[points.length - 1]!;
          picks.length = 0;
          picks.push(last);
          ctx.setPending([...picks]);
          ctx.showPreviewLine(null);
          ctx.clearPreview();
          return;
        }
        reset(ctx);
        ctx.createElement(component.id, points, kind);
      }
    },

    onPointerMove(e, ctx) {
      const needed = requiredPoints(activeKind());
      const anchor = picks.length > 0 ? picks[picks.length - 1] : null;
      const resolved = ctx.resolvePoint(e.clientX, e.clientY, e.shift, anchor);
      if (!resolved) {
        ctx.showSnapMarker(null, e.shift);
        return;
      }
      const point = applyElevation(resolved);
      // Element snaps show the marker without requiring Shift (grid still does).
      ctx.showSnapMarker(point, e.shift);
      if (picks.length === 0) return;

      const provisional = [...picks, point];
      ctx.showPreviewLine(provisional);
      const previewNeeded =
        chainWalls() && needed === 2 ? 2 : needed;
      if (previewNeeded !== null && provisional.length === previewNeeded) {
        ctx.showPreview(component.id, provisional, activeKind());
      } else if (previewNeeded === null && provisional.length >= 2) {
        ctx.showPreview(component.id, provisional, activeKind());
      } else if (chainWalls() && provisional.length >= 2) {
        ctx.showPreview(component.id, provisional.slice(-2), activeKind());
      } else {
        ctx.clearPreview();
      }
    },

    cancel(ctx) {
      reset(ctx);
    },

    nudgeElevation: freeElevation
      ? (delta) => {
          elevationOffset = Math.round((elevationOffset + delta) * 100) / 100;
        }
      : undefined,
  };
}

/** Finish a variable-length gesture (polyline) on double-click. */
export function finishOpenGesture(
  tool: Tool,
  picks: Vec3[],
  ctx: ToolContext,
  component?: ComponentDto | null,
): boolean {
  if (!tool.componentId || picks.length < 2) return false;
  const min = finishMinPoints(component ?? null);
  if (picks.length < min) {
    ctx.setError(`Need at least ${min} points to finish.`);
    return false;
  }
  ctx.createElement(tool.componentId, picks, tool.placementKind?.());
  tool.cancel?.(ctx);
  return true;
}

/** Minimum picks for an open gesture, from definition metadata (never by id). */
export function finishMinPoints(component: ComponentDto | null | undefined): number {
  const options = component?.placement_options;
  if (options?.min_points != null) return options.min_points;
  if (options?.closed) return 3;
  return 2;
}
