import { apexCreateElement } from '../wasm/apex';
import { ApexIcons } from './icons';
import type { Tool } from './Tool';

export const BOOLEAN_TOOL_ID = 'apex.booleanTool';

/**
 * Solid boolean between any two elements: click A, click B.
 *
 * Creates a parametric `apex.boolean` element (default A − B). Its Operation
 * (subtract / union / intersect) is edited in Properties; moving or editing
 * either operand recomputes it, and undo/redo work like any other edit.
 * Operands stop rendering while consumed; delete the boolean to get them back.
 */
export function createBooleanTool(): Tool {
  let first: string | null = null;
  return {
    id: BOOLEAN_TOOL_ID,
    label: 'Boolean',
    group: 'transform',
    icon: ApexIcons.boolean,

    hint() {
      return first
        ? 'Click solid B (result A − B; change Operation in Properties)'
        : 'Click solid A';
    },

    onClick(e, ctx) {
      const picked = ctx.pickElementId(e.clientX, e.clientY);
      if (!picked) {
        ctx.setError(first ? 'Click solid B' : 'Click solid A');
        return;
      }
      if (!first) {
        first = picked;
        ctx.setError(null);
        ctx.setPending([ctx.anchorOf(picked)]);
        return;
      }
      if (picked === first) {
        ctx.setError('Pick a different solid for B');
        return;
      }
      const a = first;
      first = null;
      ctx.setPending([]);
      try {
        ctx.applyScene(
          apexCreateElement('apex.boolean', [[0, 0, 0]], {
            operand_a: a,
            operand_b: picked,
            operation: 'subtract',
          }),
        );
        ctx.setError(null);
      } catch (err) {
        ctx.setError(err instanceof Error ? err.message : String(err));
      }
    },

    cancel(ctx) {
      first = null;
      ctx.setPending([]);
      ctx.setError(null);
    },
  };
}
