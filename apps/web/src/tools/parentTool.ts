import { apexSelectElement, apexSetElementParent } from '../wasm/apex';
import { ApexIcons } from './icons';
import type { Tool } from './Tool';

export const PARENT_TOOL_ID = 'apex.parent';
export const DETACH_TOOL_ID = 'apex.detach';

/**
 * Set a parent by picking one: child first, then parent.
 *
 * Not a per-type tool on purpose — any element can parent any other, so the
 * choice is the gesture, not the component. Walls, beams and slabs are the
 * common case, nothing is special-cased. Nesting is unbounded: a child can
 * itself be a parent.
 */
export function createParentTool(): Tool {
  let childId: string | null = null;

  return {
    id: PARENT_TOOL_ID,
    label: 'Parent',
    group: 'transform',
    icon: ApexIcons.parent,
    // No letter hotkey: P toggles the plan view.

    hint() {
      return childId ? 'Click the parent element' : 'Click the element to attach';
    },

    onClick(e, ctx) {
      if (childId) {
        const parentId = ctx.pickElementId(e.clientX, e.clientY);
        if (!parentId) {
          ctx.setError('Click an element to use as parent');
          return;
        }
        if (parentId === childId) {
          ctx.setError('An element cannot be its own parent');
          return;
        }
        // The core refuses cycles; let it report the reason verbatim.
        const child = childId;
        childId = null;
        ctx.setPending([]);
        try {
          ctx.applyScene(apexSetElementParent(child, parentId));
          ctx.setError(null);
        } catch (err) {
          ctx.setError(err instanceof Error ? err.message : String(err));
        }
        // Leave the child selected so Properties shows its new parent.
        ctx.applyScene(apexSelectElement(child));
        return;
      }

      const picked = ctx.pickElementId(e.clientX, e.clientY);
      if (!picked) {
        ctx.setError('Click an element to attach');
        return;
      }
      childId = picked;
      ctx.setError(null);
      // Highlight the child while the parent is being picked.
      ctx.applyScene(apexSelectElement(picked));
      ctx.setPending([ctx.anchorOf(picked)]);
    },

    cancel(ctx) {
      childId = null;
      ctx.setPending([]);
      ctx.setError(null);
    },
  };
}

/**
 * Detach the selected element from its parent.
 *
 * The element stays where it is: its own level becomes effective again, and any
 * children stay attached to it.
 */
export function createDetachTool(): Tool {
  return {
    id: DETACH_TOOL_ID,
    label: 'Detach',
    group: 'transform',
    icon: ApexIcons.detach,

    hint() {
      return 'Select one element, then click Detach';
    },

    onClick(_e, ctx) {
      const selection = ctx.selectedElementIds();
      if (selection.length !== 1) {
        ctx.setError(
          selection.length === 0 ? 'Select an element first' : 'Select one element',
        );
        return;
      }
      const id = selection[0];
      if (!ctx.elementParentId(id)) {
        ctx.setError('That element has no parent');
        return;
      }
      try {
        ctx.applyScene(apexSetElementParent(id, null));
        ctx.setError(null);
      } catch (err) {
        ctx.setError(err instanceof Error ? err.message : String(err));
      }
    },
  };
}
