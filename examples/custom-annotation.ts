/**
 * Example: register a custom view-annotation kind via `window.apex.registerAnnotationKind`.
 * Built-in linear dimensions and text notes use the same hook in first-party plugins.
 */
import type { AnnotationKindRegistration } from '../apps/web/src/annotations/types';
import type { Tool } from '../apps/web/src/tools/Tool';
import { ApexTabs } from '../apps/web/src/tools/tabs';

const stampTool: Tool = {
  id: 'acme.stamp',
  label: 'Stamp',
  group: 'create',
  tab: ApexTabs.annotate,
  hint: () => 'Stamp: click to place a note on the open plan view',
  onPointerDown(e, ctx) {
    const viewId = ctx.activeViewId();
    if (!viewId) {
      ctx.setError('Open a saved plan view first.');
      return true;
    }
    const world = ctx.resolvePoint(e.clientX, e.clientY, e.shift, null);
    const position = ctx.pickAnnotationAnchor(e.clientX, e.clientY, world);
    if (!position) return true;
    ctx.createViewAnnotation(viewId, {
      kind: 'text_note',
      position,
      text: 'APPROVED',
    });
    return true;
  },
};

const stampKind: AnnotationKindRegistration = {
  kind: 'text_note',
  displayName: 'Approval stamp',
  tools: [stampTool],
  serialize: (kind) => kind,
  deserialize: (payload) => payload as AnnotationKindRegistration['kind'] extends never ? never : import('../apps/web/src/types').ViewAnnotationKindDto,
};

// window.apex.registerAnnotationKind(stampKind);
