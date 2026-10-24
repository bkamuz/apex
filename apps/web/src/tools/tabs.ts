import type { Tool, ToolTab, ResolvedToolTab } from './Tool';

/**
 * Discoverable catalog of known toolbar tabs (ontology).
 *
 * Plugin authors should normally pick one of these. Passing a custom
 * `{ id, label }` that is not in this map still creates a new tab at runtime —
 * the catalog is guidance and stable ids, not an allowlist.
 */
export const TOOL_TABS = {
  /**
   * Foundational drafting tools: Level, Ref point (the point tool), Ref plane,
   * Construction line, Grid axis, Section cut. LevelList still manages/activates levels.
   */
  basics: {
    id: 'apex.basics',
    label: 'Basics',
  },
  building: {
    id: 'apex.building',
    label: 'Building constructions',
  },
} as const satisfies Record<string, ResolvedToolTab>;

/** Alias preferred in SDK / examples (`ApexTabs.building`). */
export const ApexTabs = TOOL_TABS;

/** @deprecated Prefer `ApexTabs.building` / `TOOL_TABS.building`. */
export const BUILDING_CONSTRUCTIONS_TAB: ResolvedToolTab = TOOL_TABS.building;

const catalogById: ReadonlyMap<string, ResolvedToolTab> = new Map(
  Object.values(TOOL_TABS).map((tab) => [tab.id, tab]),
);

/** Look up a catalog entry by stable id, or `undefined` for open-world tabs. */
export function catalogTabById(id: string): ResolvedToolTab | undefined {
  return catalogById.get(id);
}

/**
 * Fill in a label: catalog default when the author omits one for a known id;
 * otherwise the provided label, else the raw id as a last-resort fallback.
 */
export function resolveToolTab(tab: ToolTab): ResolvedToolTab {
  const catalog = catalogById.get(tab.id);
  const label = tab.label ?? catalog?.label ?? tab.id;
  return { id: tab.id, label };
}

/**
 * Tabs present on the current tool list, in first-seen order.
 * First registration wins for the resolved label when several tools share an id.
 * Tabs with no tools never appear (this walks tools, not a closed enum).
 */
export function collectToolTabs(tools: readonly Tool[]): ResolvedToolTab[] {
  const tabs: ResolvedToolTab[] = [];
  const seen = new Set<string>();
  for (const tool of tools) {
    if (!tool.tab) continue;
    const resolved = resolveToolTab(tool.tab);
    if (seen.has(resolved.id)) continue;
    seen.add(resolved.id);
    tabs.push(resolved);
  }
  return tabs;
}

export function toolsInTab(tools: readonly Tool[], tabId: string): Tool[] {
  return tools.filter((tool) => tool.tab?.id === tabId);
}

/** Create-group tools that did not declare a tab (shown after the tab strip). */
export function untabbedCreateTools(tools: readonly Tool[]): Tool[] {
  return tools.filter((tool) => (tool.group ?? 'create') === 'create' && !tool.tab);
}

export function toolsInGroup(tools: readonly Tool[], group: NonNullable<Tool['group']>): Tool[] {
  return tools.filter((tool) => (tool.group ?? 'create') === group);
}
