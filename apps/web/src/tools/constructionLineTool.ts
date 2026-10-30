import { pluralS, t } from '../i18n';
import type { Vec3 } from '../viewport/ViewportRenderer';
import { ApexIcons } from './icons';
import type { Tool, ToolContext, ToolTab } from './Tool';
import { ApexTabs } from './tabs';

const MIN_PICK_SPACING = 0.1;

function farEnough(a: Vec3, b: Vec3): boolean {
  return Math.hypot(b[0] - a[0], b[2] - a[2]) >= MIN_PICK_SPACING;
}

/** Place a plan construction line with two clicks on the active level. */
export function createConstructionLineTool(tab: ToolTab = ApexTabs.basics): Tool {
  const picks: Vec3[] = [];

  const reset = (ctx: ToolContext) => {
    picks.length = 0;
    ctx.setPending([]);
    ctx.clearPreview();
    ctx.showPreviewLine(null);
    ctx.setTouchOrbitEnabled(true);
  };

  return {
    id: 'construction-line',
    label: 'Construction line',
    descriptor: { purpose: 'Draw an infinite construction line through two picks for alignment; it has no geometry in exports.' },
    group: 'create',
    tab,
    icon: ApexIcons.constructionLine,

    hint(pendingCount) {
      const remaining = 2 - pendingCount;
      return remaining <= 0
        ? t('tool.construction-line.hintPlacing')
        : t('tool.construction-line.hintClicks', { n: remaining, s: pluralS(remaining) });
    },

    onPointerDown(e, ctx) {
      ctx.setTouchOrbitEnabled(false);
      const anchor = picks.length > 0 ? picks[picks.length - 1] : null;
      const point = ctx.resolvePoint(e.clientX, e.clientY, e.shift, anchor);
      if (!point) return true;
      ctx.showSnapMarker(point, e.shift);
      if (anchor && !farEnough(anchor, point)) return true;

      picks.push(point);
      ctx.setPending([...picks]);
      ctx.showPreviewLine([...picks]);

      if (picks.length >= 2) {
        ctx.createConstructionLine([...picks]);
        reset(ctx);
      }
      return true;
    },

    onPointerMove(e, ctx) {
      const anchor = picks.length > 0 ? picks[picks.length - 1] : null;
      const point = ctx.resolvePoint(e.clientX, e.clientY, e.shift, anchor);
      if (!point) return;
      ctx.showSnapMarker(point, e.shift);
      if (picks.length === 0) return;
      ctx.showPreviewLine([...picks, point]);
    },

    cancel(ctx) {
      reset(ctx);
    },
  };
}
