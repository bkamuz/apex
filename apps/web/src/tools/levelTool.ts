import { ApexIcons } from './icons';
import type { Tool, ToolContext, ToolTab } from './Tool';
import { ApexTabs } from './tabs';

/**
 * Create a storey above the highest level (+3 m), matching LevelList.
 * Click anywhere (or activate via toolbar click) to add; LevelList remains
 * for manage / activate.
 */
export function createLevelTool(tab: ToolTab = ApexTabs.basics): Tool {
  return {
    id: 'level',
    label: 'Level',
    group: 'create',
    tab,
    icon: ApexIcons.level,
    hint: () => 'Level: click to add a storey (+3 m above the highest)',

    onClick(_e, ctx) {
      ctx.createLevel();
    },

    onPointerDown(_e, ctx) {
      ctx.createLevel();
      return true;
    },

    cancel(_ctx: ToolContext) {
      /* no gesture state */
    },
  };
}
