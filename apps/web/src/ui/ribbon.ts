import type { Tool } from '../tools/Tool';
import { resolveToolTab } from '../tools/tabs';

/**
 * Variant-A ribbon: tabs grouped by task, not by plugin tab.
 *
 * Plugin tool tabs (`apex.building`, `apex.spaces`, …) stay the plugin-facing
 * ontology; this module only decides where their tools *show*. Unknown plugin
 * tabs keep a ribbon tab of their own so nothing disappears.
 */
export const RIBBON_TABS = {
  architecture: 'apex.architecture',
  engineering: 'apex.engineering',
  annotate: 'apex.annotate',
  view: 'apex.view',
} as const;

export type RibbonGroupId =
  | 'select'
  | 'build'
  | 'rooms'
  | 'datums'
  | 'routes'
  | 'annotations'
  | 'sections'
  | 'modify'
  | 'plugin';

/** One labelled ribbon panel. Tools always lay out in a single dense row. */
export interface RibbonGroup {
  id: RibbonGroupId;
  tools: Tool[];
  /** Plugin-provided label (open-world tabs). */
  label?: string;
}

export interface RibbonTab {
  id: string;
  /** Raw label for plugin tabs; built-in tabs are labelled through i18n. */
  label?: string;
  groups: RibbonGroup[];
}

const SECTION_TOOL_IDS = new Set(['section-cut']);

/** Where each plugin tab lands: [ribbon tab, group]. */
const PLACEMENT: Record<string, [string, RibbonGroupId]> = {
  'apex.building': [RIBBON_TABS.architecture, 'build'],
  'apex.spaces': [RIBBON_TABS.architecture, 'rooms'],
  'apex.basics': [RIBBON_TABS.architecture, 'datums'],
  'apex.engineering': [RIBBON_TABS.engineering, 'routes'],
  'apex.annotate': [RIBBON_TABS.annotate, 'annotations'],
};

const GROUP_ORDER: RibbonGroupId[] = [
  'select',
  'build',
  'rooms',
  'datums',
  'routes',
  'annotations',
  'sections',
  'plugin',
];

/** Selection-dependent tools (Move, Copy, Parent, Detach, Boolean). */
export function modifyTools(tools: readonly Tool[]): Tool[] {
  return tools.filter((tool) => tool.group === 'transform');
}

/**
 * Build the task ribbon. Select lives once, on Architecture; Modify is not
 * in any tab: the caller shows it as a contextual group while something is
 * selected (see `showModify`).
 */
export function buildRibbon(tools: readonly Tool[]): RibbonTab[] {
  const tabs = new Map<string, RibbonTab>();
  const order = [RIBBON_TABS.architecture, RIBBON_TABS.engineering, RIBBON_TABS.annotate];
  for (const id of order) tabs.set(id, { id, groups: [] });
  const groupOf = (tabId: string, groupId: RibbonGroupId, label?: string): RibbonGroup => {
    let tab = tabs.get(tabId);
    if (!tab) {
      tab = { id: tabId, label, groups: [] };
      tabs.set(tabId, tab);
    }
    let group = tab.groups.find((g) => g.id === groupId);
    if (!group) {
      group = { id: groupId, tools: [], label };
      tab.groups.push(group);
    }
    return group;
  };

  for (const tool of tools) {
    const kind = tool.group ?? 'create';
    if (kind === 'transform') continue;
    if (kind === 'select') {
      groupOf(RIBBON_TABS.architecture, 'select').tools.push(tool);
      continue;
    }
    if (SECTION_TOOL_IDS.has(tool.id)) {
      groupOf(RIBBON_TABS.view, 'sections').tools.push(tool);
      continue;
    }
    if (!tool.tab) {
      groupOf(RIBBON_TABS.architecture, 'build').tools.push(tool);
      continue;
    }
    const placed = PLACEMENT[tool.tab.id];
    if (placed) {
      groupOf(placed[0], placed[1]).tools.push(tool);
      continue;
    }
    const resolved = resolveToolTab(tool.tab);
    groupOf(resolved.id, 'plugin', resolved.label).tools.push(tool);
  }
  // View always exists (navigation/graphics groups are rendered by the host).
  if (!tabs.has(RIBBON_TABS.view)) tabs.set(RIBBON_TABS.view, { id: RIBBON_TABS.view, groups: [] });

  const result = [...tabs.values()].filter(
    (tab) => tab.id === RIBBON_TABS.view || tab.groups.some((g) => g.tools.length > 0),
  );
  for (const tab of result) {
    tab.groups.sort((a, b) => GROUP_ORDER.indexOf(a.id) - GROUP_ORDER.indexOf(b.id));
  }
  // Keep View last even after plugin tabs.
  result.sort((a, b) => Number(a.id === RIBBON_TABS.view) - Number(b.id === RIBBON_TABS.view));
  return result;
}

/** Ribbon tab that hosts a tool (to follow the active tool). */
export function ribbonTabForTool(ribbon: readonly RibbonTab[], toolId: string): string | null {
  for (const tab of ribbon) {
    if (tab.groups.some((g) => g.tools.some((tool) => tool.id === toolId))) return tab.id;
  }
  return null;
}

/** Modify appears while something is selected or a modify tool is running. */
export function showModify(selectedCount: number, activeToolId: string, tools: readonly Tool[]): boolean {
  if (selectedCount > 0) return true;
  return modifyTools(tools).some((tool) => tool.id === activeToolId);
}
