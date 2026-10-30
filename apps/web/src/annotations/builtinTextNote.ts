import type { AnnotationKindRegistration } from './types';
import { t } from '../i18n';
import type { Tool } from '../tools/Tool';
import { ApexIcons } from '../tools/icons';
import { ApexTabs } from '../tools/tabs';
import { hitTestLineSegments } from './hitTest';

function createTextNoteTool(): Tool {
  return {
    id: 'apex.text_note',
    label: 'Text',
    descriptor: { purpose: 'Place a text note in a plan view.' },
    group: 'create',
    tab: ApexTabs.annotate,
    icon: ApexIcons.refPoint,
    shortcut: 'N',

    hint() {
      return t('tool.apex.text_note.hint');
    },

    onPointerDown(e, ctx) {
      const viewId = ctx.activeViewId();
      if (!viewId) {
        ctx.setError(t('tool.apex.text_note.needView'));
        return true;
      }
      ctx.setError(null);
      const world = ctx.resolvePoint(e.clientX, e.clientY, e.shift, null);
      const position = ctx.pickAnnotationAnchor(e.clientX, e.clientY, world);
      if (!position) return true;
      ctx.showSnapMarker(world, e.shift);
      const text = window.prompt('Note text', 'Note');
      if (!text?.trim()) return true;
      ctx.createViewAnnotation(viewId, {
        kind: 'text_note',
        position,
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

export function builtinTextNoteKind(): AnnotationKindRegistration {
  return {
    kind: 'text_note',
    displayName: 'Text note',
    descriptor: { purpose: 'Text note: free text placed at a world point or element anchor on a saved view.' },
    tools: [createTextNoteTool()],
    serialize: (kind) => kind,
    deserialize: (payload) => payload as import('../types').ViewAnnotationKindDto,
    hitTest(annotation, clientX, clientY, renderer) {
      for (const label of annotation.labels ?? []) {
        const p = renderer.worldToClient(label.position);
        if (!p) continue;
        if (Math.hypot(p[0] - clientX, p[1] - clientY) <= 12) return true;
      }
      return hitTestLineSegments(renderer, clientX, clientY, annotation.line_segments ?? [], 10);
    },
  };
}
