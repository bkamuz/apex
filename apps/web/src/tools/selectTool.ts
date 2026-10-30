import { t } from '../i18n';
import type { Vec3 } from '../viewport/ViewportRenderer';
import { ApexIcons } from './icons';
import { resolveJoinablePoint } from './joinableSnap';
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
  let shapeDrag = false;

  return {
    id: SELECT_TOOL_ID,
    label: 'Select',
    descriptor: { purpose: 'Select elements by click or box; Shift/Ctrl adds to the selection.' },
    group: 'select',
    icon: ApexIcons.select,

    hint() {
      return t('tool.select.hint');
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
      const index = ctx.hitEditHandle(e.clientX, e.clientY);
      if (index === null) return false;

      drag = { index, anchors: anchors.map((p) => [...p] as Vec3), moved: false };
      ctx.beginUndoGroup();
      ctx.setTouchOrbitEnabled(false);
      return true;
    },

    onPointerMove(e, ctx) {
      if (shapeDrag) {
        ctx.moveShapeDrag?.(e.clientX, e.clientY);
        return;
      }
      if (!drag) {
        const point = ctx.resolvePoint(e.clientX, e.clientY, e.shift, null);
        ctx.showSnapMarker(point, e.shift);
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
      const current = drag;
      drag = null;
      ctx.setTouchOrbitEnabled(true);
      if (current?.moved) ctx.commitAnchors(current.anchors);
    },

    onClick(e, ctx) {
      // A click on a handle should edit, not deselect.
      if (ctx.hitEditHandle(e.clientX, e.clientY) !== null) return;
      if ((ctx.hitShapeHandle?.(e.clientX, e.clientY) ?? null) !== null) return;
      ctx.selectAt(e.clientX, e.clientY, e.multi);
    },

    cancel(ctx) {
      drag = null;
      shapeDrag = false;
      ctx.setTouchOrbitEnabled(true);
    },
  };
}
