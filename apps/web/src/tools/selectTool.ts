import { t } from '../i18n';
import type { Vec3 } from '../viewport/ViewportRenderer';
import { ApexIcons } from './icons';
import { resolveJoinablePoint } from './joinableSnap';
import type { Tool, ToolContext } from './Tool';

export const SELECT_TOOL_ID = 'select';

interface AnchorDrag {
  index: number;
  anchors: Vec3[];
  moved: boolean;
}

type Candidate = { id: string; name: string; category: string; pickId: number };

/**
 * Depth order from the GPU, but slabs last — floors underlie everything and
 * would otherwise steal the default hover when the ray grazes the deck.
 */
export function rankSelectCandidates(all: Candidate[]): Candidate[] {
  return [
    ...all.filter((c) => c.category !== 'slab'),
    ...all.filter((c) => c.category === 'slab'),
  ];
}

/**
 * Pick elements and drag their anchors.
 *
 * Anchors are whatever the element's placement reports, so this drags a wall's
 * two ends, an arc wall's three picks and a column's single point identically.
 *
 * Revit-like under-cursor pick: hover pre-highlights the top hit; Tab /
 * Shift+Tab cycles the multi-hit stack; click commits the highlighted candidate.
 */
export function createSelectTool(): Tool {
  let drag: AnchorDrag | null = null;
  let shapeDrag = false;
  let candidates: Candidate[] = [];
  let index = 0;
  /** True after the user Tab-cycled since the last candidate-stack change. */
  let tabbed = false;
  let lastPointer: { x: number; y: number } | null = null;
  let lastHintKey = '';

  const current = (): Candidate | null =>
    candidates.length === 0 ? null : (candidates[index % candidates.length] ?? null);

  const syncHover = (ctx: ToolContext) => {
    const cur = current();
    ctx.setHoverPickIds(cur ? [cur.pickId] : []);
    const hintKey =
      candidates.length === 0
        ? ''
        : `${cur?.id ?? ''}:${index}:${candidates.length}`;
    if (hintKey !== lastHintKey) {
      lastHintKey = hintKey;
      ctx.refreshToolUi();
    }
  };

  const refreshCandidates = (ctx: ToolContext, clientX: number, clientY: number) => {
    const next = rankSelectCandidates(ctx.pickElementCandidates(clientX, clientY));
    const same =
      next.length === candidates.length && next.every((c, i) => c.id === candidates[i]?.id);
    if (!same) {
      candidates = next;
      index = 0;
      tabbed = false;
    }
  };

  const cycleHint = () => {
    if (candidates.length === 0) return '';
    const cur = current();
    if (!cur) return '';
    if (candidates.length === 1) return ` · ${cur.name}`;
    return ` · ${cur.name} (${(index % candidates.length) + 1}/${candidates.length}, Tab)`;
  };

  return {
    id: SELECT_TOOL_ID,
    label: 'Select',
    descriptor: {
      purpose:
        'Select elements by click or box; hover pre-highlights; Tab cycles stacked hits; Shift/Ctrl adds to the selection.',
    },
    group: 'select',
    icon: ApexIcons.select,

    hint() {
      return t('tool.select.hint') + cycleHint();
    },

    onPointerDown(e, ctx) {
      const shapeIndex = ctx.hitShapeHandle?.(e.clientX, e.clientY) ?? null;
      if (shapeIndex !== null) {
        shapeDrag = true;
        ctx.beginShapeDrag?.(shapeIndex, e.clientX, e.clientY);
        ctx.setTouchOrbitEnabled(false);
        return true;
      }
      const anchors = ctx.selectedAnchors();
      if (!anchors) return false;
      const indexHandle = ctx.hitEditHandle(e.clientX, e.clientY);
      if (indexHandle === null) return false;

      drag = { index: indexHandle, anchors: anchors.map((p) => [...p] as Vec3), moved: false };
      ctx.beginUndoGroup();
      ctx.setTouchOrbitEnabled(false);
      return true;
    },

    onPointerMove(e, ctx) {
      lastPointer = { x: e.clientX, y: e.clientY };
      if (shapeDrag) {
        ctx.moveShapeDrag?.(e.clientX, e.clientY);
        return;
      }
      if (!drag) {
        const point = ctx.resolvePoint(e.clientX, e.clientY, e.shift, null);
        ctx.showSnapMarker(point, e.shift);
        refreshCandidates(ctx, e.clientX, e.clientY);
        syncHover(ctx);
        return;
      }

      // Constrain against a neighbouring anchor so Shift-ortho has a reference.
      const neighbour = drag.anchors[drag.index === 0 ? drag.anchors.length - 1 : 0] ?? null;
      const joinableId = ctx.selectedJoinableComponentId();
      let point: Vec3 | null = null;
      let joinSnapped = false;
      if (joinableId) {
        const hit = resolveJoinablePoint(ctx, e.clientX, e.clientY, e.shift, neighbour, joinableId);
        point = hit?.point ?? null;
        joinSnapped = !!hit?.snapped;
      } else {
        point = ctx.resolvePoint(e.clientX, e.clientY, e.shift, neighbour);
      }
      if (!point) return;

      ctx.showSnapMarker(point, e.shift || joinSnapped);
      drag.anchors[drag.index] = point;
      drag.moved = true;
      ctx.previewAnchors(drag.anchors);
    },

    onPointerUp(_e, ctx) {
      if (shapeDrag) {
        shapeDrag = false;
        ctx.setTouchOrbitEnabled(true);
        ctx.endShapeDrag?.();
        return;
      }
      const currentDrag = drag;
      drag = null;
      ctx.setTouchOrbitEnabled(true);
      if (currentDrag?.moved) ctx.commitAnchors(currentDrag.anchors);
    },

    onKey(e, ctx) {
      // Always claim Tab while Select is active so browser focus does not walk
      // the toolbar. Cycle only when a multi-hit stack is under the cursor.
      if (e.key !== 'Tab') return false;
      if (lastPointer) {
        refreshCandidates(ctx, lastPointer.x, lastPointer.y);
      }
      if (candidates.length >= 2) {
        const len = candidates.length;
        index = (index + (e.shiftKey ? len - 1 : 1)) % len;
        tabbed = true;
        syncHover(ctx);
      }
      return true;
    },

    onClick(e, ctx) {
      // A click on a handle should edit, not deselect.
      if (ctx.hitEditHandle(e.clientX, e.clientY) !== null) return;
      if ((ctx.hitShapeHandle?.(e.clientX, e.clientY) ?? null) !== null) return;

      lastPointer = { x: e.clientX, y: e.clientY };
      refreshCandidates(ctx, e.clientX, e.clientY);
      const cur = current();
      // Plan: un-cycled top slab still routes through selectAt so a room
      // under the floor can be named without hunting the boundary.
      const deferSlabToRoom = !!cur && !tabbed && index === 0 && cur.category === 'slab';
      if (cur && !deferSlabToRoom) {
        ctx.selectElementId(cur.id, e.multi);
        syncHover(ctx);
        return;
      }
      ctx.selectAt(e.clientX, e.clientY, e.multi);
      refreshCandidates(ctx, e.clientX, e.clientY);
      syncHover(ctx);
    },

    cancel(ctx) {
      drag = null;
      shapeDrag = false;
      candidates = [];
      index = 0;
      tabbed = false;
      lastPointer = null;
      lastHintKey = '';
      ctx.setHoverPickIds([]);
      ctx.setTouchOrbitEnabled(true);
      ctx.refreshToolUi();
    },
  };
}
