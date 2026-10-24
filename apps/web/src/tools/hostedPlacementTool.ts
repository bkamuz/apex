import type { ComponentDto } from '../types';
import type { Vec3 } from '../viewport/ViewportRenderer';
import { toolIdForComponent, type Tool, type ToolContext } from './Tool';

/**
 * Place an opening on a host element: first click picks the host, second click
 * places the opening and parents it so the host-cut seam punches a void.
 */
export function createHostedPlacementTool(component: ComponentDto): Tool {
  let hostId: string | null = null;
  let hostPoint: Vec3 | null = null;

  const reset = (ctx: ToolContext) => {
    hostId = null;
    hostPoint = null;
    ctx.setPending([]);
    ctx.clearPreview();
    ctx.showPreviewLine(null);
    ctx.setTouchOrbitEnabled(true);
  };

  return {
    id: toolIdForComponent(component),
    label: component.display_name,
    group: 'create',
    componentId: component.id,
    placementKind: () => 'point',

    hint(pendingCount) {
      if (pendingCount === 0) {
        return `${component.display_name}: click a host (${(component.host_cut?.host_categories ?? []).join('/') || 'element'})`;
      }
      return `${component.display_name}: click insertion point · Esc`;
    },

    onClick(e, ctx) {
      if (!hostId) {
        const id = ctx.pickElementId(e.clientX, e.clientY);
        if (!id) {
          ctx.setError('Click a host element first.');
          return;
        }
        const category = ctx.elementCategory(id);
        const allowed = component.host_cut?.host_categories ?? [];
        if (allowed.length > 0 && category && !allowed.includes(category)) {
          ctx.setError(`Host must be one of: ${allowed.join(', ')}`);
          return;
        }
        hostId = id;
        hostPoint = ctx.anchorOf(id);
        ctx.setError(null);
        ctx.setPending(hostPoint ? [hostPoint] : [[0, 0, 0]]);
        ctx.setTouchOrbitEnabled(false);
        return;
      }

      const point = ctx.resolvePoint(e.clientX, e.clientY, e.shift, hostPoint);
      if (!point) return;
      const parent = hostId;
      reset(ctx);
      ctx.createElementWithParent(component.id, [point], parent, 'point');
    },

    onPointerMove(e, ctx) {
      if (!hostId) {
        ctx.showSnapMarker(null, e.shift);
        return;
      }
      const point = ctx.resolvePoint(e.clientX, e.clientY, e.shift, hostPoint);
      if (!point) {
        ctx.showSnapMarker(null, e.shift);
        return;
      }
      ctx.showSnapMarker(point, e.shift);
      ctx.showPreview(component.id, [point], 'point');
    },

    cancel(ctx) {
      reset(ctx);
    },
  };
}
