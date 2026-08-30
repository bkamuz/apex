import type { Vec3 } from '../viewport/ViewportRenderer';
import type { Tool } from './Tool';

export const SELECT_TOOL_ID = 'select';

interface AnchorDrag {
  index: number;
  anchors: Vec3[];
  moved: boolean;
}

/**
 * Pick elements and drag their anchors.
 *
 * Anchors are whatever the element's placement reports, so this drags a wall's
 * two ends, an arc wall's three picks and a column's single point identically.
 */
export function createSelectTool(): Tool {
  let drag: AnchorDrag | null = null;

  return {
    id: SELECT_TOOL_ID,
    label: 'Select',
    group: 'select',

    hint() {
      return 'MMB pan · RMB orbit · wheel zoom · dbl-click a level to activate it';
    },

    onPointerDown(e, ctx) {
      const anchors = ctx.selectedAnchors();
      if (!anchors) return false;
      const index = ctx.hitEditHandle(e.clientX, e.clientY);
      if (index === null) return false;

      drag = { index, anchors: anchors.map((p) => [...p] as Vec3), moved: false };
      ctx.setTouchOrbitEnabled(false);
      return true;
    },

    onPointerMove(e, ctx) {
      if (!drag) {
        const point = ctx.resolvePoint(e.clientX, e.clientY, e.shift, null);
        ctx.showSnapMarker(point, e.shift);
        return;
      }

      // Constrain against a neighbouring anchor so Shift-ortho has a reference.
      const neighbour = drag.anchors[drag.index === 0 ? drag.anchors.length - 1 : 0] ?? null;
      const point = ctx.resolvePoint(e.clientX, e.clientY, e.shift, neighbour);
      if (!point) return;

      ctx.showSnapMarker(point, e.shift);
      drag.anchors[drag.index] = point;
      drag.moved = true;
      ctx.previewAnchors(drag.anchors);
    },

    onPointerUp(_e, ctx) {
      const current = drag;
      drag = null;
      ctx.setTouchOrbitEnabled(true);
      if (current?.moved) ctx.commitAnchors(current.anchors);
    },

    onClick(e, ctx) {
      // A click on a handle should edit, not deselect.
      if (ctx.hitEditHandle(e.clientX, e.clientY) !== null) return;
      ctx.selectByPick(ctx.pick(e.clientX, e.clientY), e.multi);
    },

    cancel(ctx) {
      drag = null;
      ctx.setTouchOrbitEnabled(true);
    },
  };
}
