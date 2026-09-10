import type { Vec3 } from '../viewport/ViewportRenderer';
import type { Tool } from './Tool';
import { deltaVec3, type TransformMode, type TransformOriginal } from './transformTypes';

export const MOVE_TOOL_ID = 'apex.move';
export const COPY_TOOL_ID = 'apex.copy';

/**
 * Classic CAD move / copy: base point → target point.
 *
 * Move previews live geometry; copy shows a construction line until confirm.
 */
export function createTransformTool(mode: TransformMode): Tool {
  let base: Vec3 | null = null;
  let originals: TransformOriginal[] | null = null;
  let previewing = false;

  const id = mode === 'move' ? MOVE_TOOL_ID : COPY_TOOL_ID;
  const label = mode === 'move' ? 'Move' : 'Copy';
  const verb = mode === 'move' ? 'move' : 'copy';

  return {
    id,
    label,
    group: 'transform',
    shortcut: mode === 'move' ? 'M' : 'C',

    hint(pendingCount) {
      if (pendingCount === 0) {
        return `Select objects, then pick base point (${verb})`;
      }
      return `Pick target point to ${verb}`;
    },

    onClick(e, ctx) {
      const point = ctx.resolvePoint(e.clientX, e.clientY, e.shift, base);
      if (!point) return;

      if (!base) {
        const selection = ctx.getTransformSelection();
        if (!selection || selection.length === 0) {
          ctx.setError(`Select something to ${verb} first`);
          return;
        }
        base = point;
        originals = selection;
        ctx.setPending([base]);
        ctx.beginUndoGroup();
        ctx.setError(null);
        return;
      }

      const delta = deltaVec3(base, point);
      ctx.commitTransform(originals!, delta, mode);
      base = null;
      originals = null;
      previewing = false;
      ctx.setPending([]);
      ctx.showPreviewLine(null);
    },

    onPointerMove(e, ctx) {
      if (!base || !originals) {
        const hover = ctx.resolvePoint(e.clientX, e.clientY, e.shift, null);
        ctx.showSnapMarker(hover, e.shift);
        return;
      }

      const point = ctx.resolvePoint(e.clientX, e.clientY, e.shift, base);
      if (!point) return;
      ctx.showSnapMarker(point, e.shift);
      ctx.showPreviewLine([base, point]);

      if (mode === 'move') {
        const delta = deltaVec3(base, point);
        ctx.previewTransform(originals, delta);
        previewing = true;
      }
    },

    cancel(ctx) {
      if (previewing && originals) {
        ctx.restoreTransformOriginals(originals);
      }
      base = null;
      originals = null;
      previewing = false;
      ctx.setPending([]);
      ctx.showPreviewLine(null);
    },
  };
}
