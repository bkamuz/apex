import { t } from '../i18n';
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
type Candidate = { id: string; name: string; category: string };

/**
 * Solids under the cursor in pick priority: nearest non-slab solids first,
 * slabs last (they underlie everything in plan), and never `exclude`.
 */
export function rankCandidates(all: Candidate[], exclude: string | null): Candidate[] {
  const usable = all.filter((c) => c.id !== exclude);
  return [
    ...usable.filter((c) => c.category !== 'slab'),
    ...usable.filter((c) => c.category === 'slab'),
  ];
}

export function createBooleanTool(): Tool {
  let first: string | null = null;
  let candidates: Candidate[] = [];
  let index = 0;
  const current = () => candidates[index % Math.max(1, candidates.length)] ?? null;
  const cycleHint = () =>
    candidates.length > 1
      ? ` — ${current()?.name ?? ''} (${(index % candidates.length) + 1}/${candidates.length}, Tab: next)`
      : '';
  return {
    id: BOOLEAN_TOOL_ID,
    label: 'Boolean',
    descriptor: { purpose: 'Combine two solids: pick A then B; Tab cycles union / subtract / intersect.', constraints: ['both operands must be solid elements'] },
    group: 'transform',
    icon: ApexIcons.boolean,

    hint() {
      return (
        (first ? t('tool.apex.booleanTool.hintB') : t('tool.apex.booleanTool.hintA')) + cycleHint()
      );
    },

    onPointerMove(e, ctx) {
      const next = rankCandidates(ctx.pickElementCandidates(e.clientX, e.clientY), first);
      const same =
        next.length === candidates.length && next.every((c, i) => c.id === candidates[i]?.id);
      if (!same) {
        candidates = next;
        index = 0;
      }
    },

    onKey(e, ctx) {
      if (e.key !== 'Tab' || candidates.length < 2) return false;
      index = (index + (e.shiftKey ? candidates.length - 1 : 1)) % candidates.length;
      const c = current();
      if (c) {
        const pts = first ? [ctx.anchorOf(first), ctx.anchorOf(c.id)] : [ctx.anchorOf(c.id)];
        ctx.setPending(pts);
        ctx.setError(null);
      }
      return true;
    },

    onClick(e, ctx) {
      const fresh = rankCandidates(ctx.pickElementCandidates(e.clientX, e.clientY), first);
      const keep =
        fresh.length === candidates.length && fresh.every((c, i) => c.id === candidates[i]?.id);
      if (!keep) {
        candidates = fresh;
        index = 0;
      }
      const picked = current()?.id ?? null;
      if (!picked) {
        ctx.setError(first ? 'Pick a different solid for B' : 'Click solid A');
        return;
      }
      if (!first) {
        first = picked;
        candidates = [];
        index = 0;
        ctx.setError(null);
        ctx.setPending([ctx.anchorOf(picked)]);
        return;
      }
      const a = first;
      first = null;
      candidates = [];
      index = 0;
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
      candidates = [];
      index = 0;
      ctx.setPending([]);
      ctx.setError(null);
    },
  };
}
