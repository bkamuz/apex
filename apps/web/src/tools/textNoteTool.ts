import { ApexIcons } from './icons';
import type { Tool } from './Tool';
import { ApexTabs } from './tabs';

/** Place a text note at one pick on the active saved view. */
export function createTextNoteTool(): Tool {
  return {
    id: 'apex.text_note',
    label: 'Text',
    group: 'create',
    tab: ApexTabs.annotate,
    icon: ApexIcons.refPoint,
    shortcut: 'N',

    hint() {
      return 'Text: click to place a note';
    },

    onPointerDown(e, ctx) {
      const viewId = ctx.activeViewId();
      if (!viewId) {
        ctx.setError('Open a saved plan view to add text.');
        return true;
      }
      ctx.setError(null);
      const point = ctx.resolvePoint(e.clientX, e.clientY, e.shift, null);
      if (!point) return true;
      ctx.showSnapMarker(point, e.shift);
      const text = window.prompt('Note text', 'Note');
      if (!text?.trim()) return true;
      ctx.createViewAnnotation(viewId, {
        kind: 'text_note',
        position: { kind: 'world', point },
        text: text.trim(),
      });
      ctx.showSnapMarker(null, false);
      return true;
    },

    cancel(ctx) {
      ctx.showSnapMarker(null, false);
    },
  };
}
