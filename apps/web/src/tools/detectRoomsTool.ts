import { ApexIcons } from './icons';
import type { Tool, ToolContext, ToolTab } from './Tool';
import { ApexTabs } from './tabs';

/**
 * One-shot action: detect closed wall loops on the active level and create /
 * refresh auto-tagged Space annotations. Manual spaces are left alone.
 */
export function createDetectRoomsTool(tab: ToolTab = ApexTabs.spaces): Tool {
  return {
    id: 'detect-rooms',
    label: 'Detect rooms',
    descriptor: { purpose: 'Find closed wall loops on the active level and create a space for each one.' },
    group: 'create',
    tab,
    icon: ApexIcons.detectRooms,
    hint: () => 'Detect rooms: click to find closed wall loops on the active level',

    onClick(_e, ctx) {
      ctx.detectRoomsFromWalls();
    },

    onPointerDown(_e, ctx) {
      ctx.detectRoomsFromWalls();
      return true;
    },

    cancel(_ctx: ToolContext) {
      /* no gesture state */
    },
  };
}
