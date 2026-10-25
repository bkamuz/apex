import type { AnnotationKindRegistration } from './types';
import type { Tool, ToolContext } from '../tools/Tool';
import { ApexIcons } from '../tools/icons';
import { ApexTabs } from '../tools/tabs';
import type { AnnotationAnchorDto, Vec3 } from '../types';
import { hitTestLineSegments } from './hitTest';

const MIN_PICK_SPACING = 0.1;
const DEFAULT_OFFSET = 0.35;

function farEnough(a: Vec3, b: Vec3): boolean {
  return Math.hypot(b[0] - a[0], b[2] - a[2]) >= MIN_PICK_SPACING;
}

function anchorWorld(anchor: AnnotationAnchorDto): Vec3 | null {
  if (anchor.kind === 'world') return anchor.point;
  return null;
}

function createLinearDimensionTool(): Tool {
  const picks: AnnotationAnchorDto[] = [];

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
        : `Dimension: click ${remaining} more point${remaining === 1 ? '' : 's'} (snaps to walls/grids)`;
    },

    onPointerDown(e, ctx) {
      const viewId = ctx.activeViewId();
      if (!viewId) {
        ctx.setError('Open a saved plan view (or activate a sheet viewport) to dimension.');
        return true;
      }
      ctx.setError(null);
      ctx.setTouchOrbitEnabled(false);
      const lastWorld =
        picks.length > 0 ? anchorWorld(picks[picks.length - 1]!) ?? ctx.resolvePoint(e.clientX, e.clientY, e.shift, null) : null;
      const anchorWorldPoint =
        lastWorld ??
        (picks.length > 0
          ? ctx.resolvePoint(e.clientX, e.clientY, e.shift, null)
          : null);
      const world = ctx.resolvePoint(e.clientX, e.clientY, e.shift, anchorWorldPoint);
      const picked = ctx.pickAnnotationAnchor(e.clientX, e.clientY, world);
      if (!picked) return true;
      ctx.showSnapMarker(world, e.shift);
      if (lastWorld && world && !farEnough(lastWorld, world) && picked.kind === 'world') {
        return true;
      }

      picks.push(picked);
      const previewPts: Vec3[] = [];
      for (const p of picks) {
        const w = anchorWorld(p);
        if (w) previewPts.push(w);
      }
      if (world && previewPts.length === 1) previewPts.push(world);
      ctx.setPending(previewPts);
      ctx.showPreviewLine(previewPts.length >= 2 ? previewPts : null);

      if (picks.length >= 2) {
        ctx.createViewAnnotation(viewId, {
          kind: 'linear_dimension',
          a: picks[0]!,
          b: picks[1]!,
          offset: DEFAULT_OFFSET,
        });
        reset(ctx);
      }
      return true;
    },

    onPointerMove(e, ctx) {
      const anchorWorldPoint =
        picks.length > 0 ? anchorWorld(picks[picks.length - 1]!) : null;
      const point = ctx.resolvePoint(e.clientX, e.clientY, e.shift, anchorWorldPoint);
      if (!point) return;
      ctx.showSnapMarker(point, e.shift);
      if (picks.length === 0) return;
      const first = anchorWorld(picks[0]!);
      if (first) ctx.showPreviewLine([first, point]);
    },

    cancel(ctx) {
      reset(ctx);
    },
  };
}

export function builtinLinearDimensionKind(): AnnotationKindRegistration {
  return {
    kind: 'linear_dimension',
    displayName: 'Linear dimension',
    tools: [createLinearDimensionTool()],
    serialize: (kind) => kind,
    deserialize: (payload) => payload as import('../types').ViewAnnotationKindDto,
    hitTest(annotation, clientX, clientY, renderer) {
      return hitTestLineSegments(renderer, clientX, clientY, annotation.line_segments ?? [], 10);
    },
  };
}
