import { useCallback, useMemo, useState } from 'react';
import type {
  ConstructionLineDto,
  ElementListDto,
  GridAxisDto,
  LevelDto,
  ProfileTypeDto,
  ReferenceDto,
  SectionCutDto,
  SpaceDto,
} from '../types';
import { profileLabel } from './profileModel';

export type BrowserGroupBy = 'kind' | 'category' | 'level' | 'profile' | 'none';
export type BrowserSortBy = 'name' | 'kind' | 'category';
export type BrowserFilter = 'all' | 'types' | 'instances' | 'references' | 'grids' | 'annotations';

interface Props {
  elements: ElementListDto[];
  references: ReferenceDto[];
  gridAxes: GridAxisDto[];
  constructionLines: ConstructionLineDto[];
  sectionCuts: SectionCutDto[];
  spaces: SpaceDto[];
  profiles: ProfileTypeDto[];
  levels: LevelDto[];
  selectedIds: string[];
  selectedProfileId: string | null;
  selectedRefId: string | null;
  selectedGridAxisId: string | null;
  selectedConstructionLineId: string | null;
  selectedSectionCutId: string | null;
  selectedSpaceId: string | null;
  onSelectInstance: (id: string, multi: boolean) => void;
  onSelectReference: (id: string) => void;
  onSelectGridAxis: (id: string) => void;
  onSelectConstructionLine: (id: string) => void;
  onSelectSectionCut: (id: string) => void;
  onSelectSpace: (id: string) => void;
  onSelectType: (profileId: string) => void;
  onNewProfile: () => void;
}

interface BrowserItem {
  key: string;
  kind: 'type' | 'instance' | 'reference' | 'grid_axis' | 'construction_line' | 'section_cut' | 'space';
  id: string;
  name: string;
  category: string;
  levelName: string;
  profileName: string;
  /** Element parent id when this row is a child instance. */
  parentId?: string | null;
}

interface BrowserPrefs {
  groupBy: BrowserGroupBy;
  sortBy: BrowserSortBy;
  filter: BrowserFilter;
  collapsed: Partial<Record<BrowserGroupBy, string[]>>;
}

const BROWSER_PREFS_KEY = 'apex.browser';

function loadPrefs(): BrowserPrefs {
  try {
    const raw = localStorage.getItem(BROWSER_PREFS_KEY);
    if (!raw) {
      return { groupBy: 'kind', sortBy: 'name', filter: 'all', collapsed: {} };
    }
    const parsed = JSON.parse(raw) as Partial<BrowserPrefs>;
    return {
      groupBy: parsed.groupBy ?? 'kind',
      sortBy: parsed.sortBy ?? 'name',
      filter: parsed.filter ?? 'all',
      collapsed: parsed.collapsed ?? {},
    };
  } catch {
    return { groupBy: 'kind', sortBy: 'name', filter: 'all', collapsed: {} };
  }
}

function storePrefs(prefs: BrowserPrefs): void {
  try {
    localStorage.setItem(BROWSER_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
}

function groupKey(item: BrowserItem, groupBy: BrowserGroupBy): string {
  switch (groupBy) {
    case 'kind':
      if (item.kind === 'type') return 'Shared types';
      if (item.kind === 'reference') return 'References';
      if (item.kind === 'grid_axis') return 'Grid axes';
      if (item.kind === 'construction_line') return 'Construction lines';
      if (item.kind === 'section_cut') return 'Section cuts';
      if (item.kind === 'space') return 'Spaces';
      return 'Placed elements';
    case 'category':
      return item.category || 'uncategorized';
    case 'level':
      return item.kind === 'type' ? 'Types (not on a level)' : item.levelName;
    case 'profile':
      return item.kind === 'type' ? `Type · ${item.name}` : item.profileName || 'No profile';
    case 'none':
      return 'All';
    default: {
      const exhaustive: never = groupBy;
      return exhaustive;
    }
  }
}

function compareItems(a: BrowserItem, b: BrowserItem, sortBy: BrowserSortBy): number {
  switch (sortBy) {
    case 'name':
      return a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind);
    case 'kind':
      return a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name);
    case 'category':
      return a.category.localeCompare(b.category) || a.name.localeCompare(b.name);
    default: {
      const exhaustive: never = sortBy;
      return exhaustive;
    }
  }
}

function isGroupExpanded(
  groupBy: BrowserGroupBy,
  label: string,
  collapsed: Partial<Record<BrowserGroupBy, string[]>>,
): boolean {
  const list = collapsed[groupBy] ?? [];
  return !list.includes(label);
}

interface BrowserTreeItemProps {
  item: BrowserItem;
  isSelected: boolean;
  depth?: number;
  onSelectInstance: (id: string, multi: boolean) => void;
  onSelectReference: (id: string) => void;
  onSelectGridAxis: (id: string) => void;
  onSelectConstructionLine: (id: string) => void;
  onSelectSectionCut: (id: string) => void;
  onSelectSpace: (id: string) => void;
  onSelectType: (profileId: string) => void;
}

function kindBadge(kind: BrowserItem['kind'], depth = 0): string {
  switch (kind) {
    case 'type':
      return 'type';
    case 'reference':
      return 'ref';
    case 'grid_axis':
      return 'grid';
    case 'construction_line':
      return 'line';
    case 'section_cut':
      return 'cut';
    case 'space':
      return 'space';
    case 'instance':
      return depth > 0 ? 'child' : 'instance';
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

/** Nest instance rows under their parent when both appear in the same list. */
function orderWithParentHierarchy(items: BrowserItem[]): { item: BrowserItem; depth: number }[] {
  const instances = items.filter((item) => item.kind === 'instance');
  if (instances.length === 0) {
    return items.map((item) => ({ item, depth: 0 }));
  }

  const byId = new Map(instances.map((item) => [item.id, item]));
  const children = new Map<string, BrowserItem[]>();
  for (const item of instances) {
    const parentId = item.parentId;
    if (parentId && byId.has(parentId)) {
      const list = children.get(parentId) ?? [];
      list.push(item);
      children.set(parentId, list);
    }
  }

  const ordered: { item: BrowserItem; depth: number }[] = [];
  const visited = new Set<string>();

  const walk = (item: BrowserItem, depth: number) => {
    if (visited.has(item.id)) return;
    visited.add(item.id);
    ordered.push({ item, depth });
    const kids = children.get(item.id) ?? [];
    kids.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of kids) walk(child, depth + 1);
  };

  for (const item of items) {
    if (item.kind !== 'instance') {
      ordered.push({ item, depth: 0 });
      continue;
    }
    const parentId = item.parentId;
    if (parentId && byId.has(parentId)) continue;
    walk(item, 0);
  }
  for (const item of instances) {
    if (!visited.has(item.id)) ordered.push({ item, depth: 0 });
  }
  return ordered;
}

function BrowserTreeItem({
  item,
  isSelected,
  depth = 0,
  onSelectInstance,
  onSelectReference,
  onSelectGridAxis,
  onSelectConstructionLine,
  onSelectSectionCut,
  onSelectSpace,
  onSelectType,
}: BrowserTreeItemProps) {
  const isType = item.kind === 'type';
  const isDatum =
    item.kind === 'reference' ||
    item.kind === 'grid_axis' ||
    item.kind === 'construction_line' ||
    item.kind === 'section_cut' ||
    item.kind === 'space';

  return (
    <li
      data-kind={item.kind}
      data-id={item.id}
      data-parent-id={item.parentId ?? undefined}
      data-depth={depth}
      className={isSelected ? 'selected' : ''}
      style={depth > 0 ? { paddingLeft: 10 + depth * 14 } : undefined}
      onClick={(event) => {
        if (isType) onSelectType(item.id);
        else if (item.kind === 'reference') onSelectReference(item.id);
        else if (item.kind === 'grid_axis') onSelectGridAxis(item.id);
        else if (item.kind === 'construction_line') onSelectConstructionLine(item.id);
        else if (item.kind === 'section_cut') onSelectSectionCut(item.id);
        else if (item.kind === 'space') onSelectSpace(item.id);
        else onSelectInstance(item.id, event.ctrlKey || event.metaKey);
      }}
    >
      <span>
        {item.name}
        <span className={`kind-badge kind-${item.kind}`}>{kindBadge(item.kind, depth)}</span>
      </span>
      <span className="cat">{isType ? item.category : isDatum ? item.levelName : item.profileName}</span>
    </li>
  );
}

function isItemSelected(
  item: BrowserItem,
  selected: Set<string>,
  selectedProfileId: string | null,
  selectedRefId: string | null,
  selectedGridAxisId: string | null,
  selectedConstructionLineId: string | null,
  selectedSectionCutId: string | null,
  selectedSpaceId: string | null,
): boolean {
  switch (item.kind) {
    case 'type':
      return selectedProfileId === item.id;
    case 'reference':
      return selectedRefId === item.id;
    case 'grid_axis':
      return selectedGridAxisId === item.id;
    case 'construction_line':
      return selectedConstructionLineId === item.id;
    case 'section_cut':
      return selectedSectionCutId === item.id;
    case 'space':
      return selectedSpaceId === item.id;
    case 'instance':
      return selected.has(item.id);
    default: {
      const exhaustive: never = item.kind;
      return exhaustive;
    }
  }
}

interface BrowserTreeGroupProps {
  label: string;
  items: BrowserItem[];
  expanded: boolean;
  onToggle: () => void;
  selected: Set<string>;
  selectedProfileId: string | null;
  selectedRefId: string | null;
  selectedGridAxisId: string | null;
  selectedConstructionLineId: string | null;
  selectedSectionCutId: string | null;
  selectedSpaceId: string | null;
  onSelectInstance: (id: string, multi: boolean) => void;
  onSelectReference: (id: string) => void;
  onSelectGridAxis: (id: string) => void;
  onSelectConstructionLine: (id: string) => void;
  onSelectSectionCut: (id: string) => void;
  onSelectSpace: (id: string) => void;
  onSelectType: (profileId: string) => void;
}

function BrowserTreeGroup({
  label,
  items,
  expanded,
  onToggle,
  selected,
  selectedProfileId,
  selectedRefId,
  selectedGridAxisId,
  selectedConstructionLineId,
  selectedSectionCutId,
  selectedSpaceId,
  onSelectInstance,
  onSelectReference,
  onSelectGridAxis,
  onSelectConstructionLine,
  onSelectSectionCut,
  onSelectSpace,
  onSelectType,
}: BrowserTreeGroupProps) {
  return (
    <div className="browser-tree-group">
      <div className="browser-tree-group-header">
        <button
          type="button"
          className="browser-tree-toggle"
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${label}`}
          onClick={onToggle}
        >
          <span className="browser-tree-chevron" aria-hidden="true" />
        </button>
        <span className="browser-tree-group-label">{label}</span>
        <span className="browser-tree-group-count">{items.length}</span>
      </div>
      {expanded ? (
        <ul className="browser-tree-items">
          {orderWithParentHierarchy(items).map(({ item, depth }) => (
            <BrowserTreeItem
              key={item.key}
              item={item}
              depth={depth}
              isSelected={isItemSelected(
                item,
                selected,
                selectedProfileId,
                selectedRefId,
                selectedGridAxisId,
                selectedConstructionLineId,
                selectedSectionCutId,
                selectedSpaceId,
              )}
              onSelectInstance={onSelectInstance}
              onSelectReference={onSelectReference}
              onSelectGridAxis={onSelectGridAxis}
              onSelectConstructionLine={onSelectConstructionLine}
              onSelectSectionCut={onSelectSectionCut}
              onSelectSpace={onSelectSpace}
              onSelectType={onSelectType}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function ProjectBrowser({
  elements,
  references,
  gridAxes,
  constructionLines,
  sectionCuts,
  spaces,
  profiles,
  levels,
  selectedIds,
  selectedProfileId,
  selectedRefId,
  selectedGridAxisId,
  selectedConstructionLineId,
  selectedSectionCutId,
  selectedSpaceId,
  onSelectInstance,
  onSelectReference,
  onSelectGridAxis,
  onSelectConstructionLine,
  onSelectSectionCut,
  onSelectSpace,
  onSelectType,
  onNewProfile,
}: Props) {
  const initial = loadPrefs();
  const [groupBy, setGroupBy] = useState<BrowserGroupBy>(initial.groupBy);
  const [sortBy, setSortBy] = useState<BrowserSortBy>(initial.sortBy);
  const [filter, setFilter] = useState<BrowserFilter>(initial.filter);
  const [collapsed, setCollapsed] = useState<Partial<Record<BrowserGroupBy, string[]>>>(
    initial.collapsed,
  );

  const persist = useCallback(
    (next: Partial<BrowserPrefs>) => {
      const prefs: BrowserPrefs = {
        groupBy,
        sortBy,
        filter,
        collapsed,
        ...next,
      };
      storePrefs(prefs);
    },
    [groupBy, sortBy, filter, collapsed],
  );

  const setGroup = (value: BrowserGroupBy) => {
    setGroupBy(value);
    persist({ groupBy: value });
  };
  const setSort = (value: BrowserSortBy) => {
    setSortBy(value);
    persist({ sortBy: value });
  };
  const setFilt = (value: BrowserFilter) => {
    setFilter(value);
    persist({ filter: value });
  };

  const toggleGroup = (label: string) => {
    setCollapsed((prev) => {
      const list = prev[groupBy] ?? [];
      const nextList = list.includes(label)
        ? list.filter((entry) => entry !== label)
        : [...list, label];
      const next = { ...prev, [groupBy]: nextList };
      storePrefs({ groupBy, sortBy, filter, collapsed: next });
      return next;
    });
  };

  const levelName = (id: string) => levels.find((level) => level.id === id)?.name ?? '—';

  const items = useMemo(() => {
    const types: BrowserItem[] = profiles.map((profile) => ({
      key: `type:${profile.id}`,
      kind: 'type',
      id: profile.id,
      name: profile.display_name,
      category: profile.category,
      levelName: '',
      profileName: profile.display_name,
    }));
    const instances: BrowserItem[] = elements.map((element) => ({
      key: `instance:${element.id}`,
      kind: 'instance',
      id: element.id,
      name: element.name,
      category: element.category,
      // A child reads its parent's level, so show the effective one.
      levelName: levelName(element.effective_level_id),
      profileName: element.profile_id
        ? profileLabel(profiles, element.profile_id)
        : element.category,
      parentId: element.parent_id ?? null,
    }));
    const refs: BrowserItem[] = references.map((reference) => ({
      key: `reference:${reference.id}`,
      kind: 'reference',
      id: reference.id,
      name: reference.name,
      category: reference.kind,
      levelName: levelName(reference.level_id),
      profileName: reference.kind,
    }));
    const grids: BrowserItem[] = gridAxes.map((axis) => ({
      key: `grid:${axis.id}`,
      kind: 'grid_axis',
      id: axis.id,
      name: axis.name,
      category: 'grid',
      levelName: levelName(axis.level_id),
      profileName: String(axis.params.label ?? '—'),
    }));
    const lines: BrowserItem[] = constructionLines.map((line) => ({
      key: `cline:${line.id}`,
      kind: 'construction_line',
      id: line.id,
      name: line.name,
      category: 'construction',
      levelName: levelName(line.level_id),
      profileName: String(line.params.label ?? '—'),
    }));
    const cuts: BrowserItem[] = sectionCuts.map((cut) => ({
      key: `cut:${cut.id}`,
      kind: 'section_cut',
      id: cut.id,
      name: cut.name,
      category: 'section',
      levelName: levelName(cut.level_id),
      profileName: String(cut.params.label ?? '—'),
    }));
    const spaceItems: BrowserItem[] = spaces.map((space) => ({
      key: `space:${space.id}`,
      kind: 'space',
      id: space.id,
      name: space.name,
      category: 'space',
      levelName: levelName(space.level_id),
      profileName: String(space.params.label ?? '—'),
    }));
    let all = [...types, ...instances, ...refs, ...grids, ...lines, ...cuts, ...spaceItems];
    switch (filter) {
      case 'all':
        break;
      case 'types':
        all = all.filter((item) => item.kind === 'type');
        break;
      case 'instances':
        all = all.filter((item) => item.kind === 'instance');
        break;
      case 'references':
        all = all.filter((item) => item.kind === 'reference');
        break;
      case 'grids':
        all = all.filter((item) => item.kind === 'grid_axis');
        break;
      case 'annotations':
        all = all.filter(
          (item) =>
            item.kind === 'construction_line' ||
            item.kind === 'section_cut' ||
            item.kind === 'space',
        );
        break;
      default: {
        const exhaustive: never = filter;
        return exhaustive;
      }
    }
    all.sort((a, b) => compareItems(a, b, sortBy));
    return all;
  }, [elements, references, gridAxes, constructionLines, sectionCuts, spaces, profiles, levels, filter, sortBy]);

  const groups = useMemo(() => {
    const map = new Map<string, BrowserItem[]>();
    for (const item of items) {
      const key = groupKey(item, groupBy);
      const list = map.get(key) ?? [];
      list.push(item);
      map.set(key, list);
    }
    return [...map.entries()];
  }, [items, groupBy]);

  const selected = new Set(selectedIds);

  return (
    <div className="project-browser" data-testid="project-browser">
      <div className="panel-title-row">
        <div className="panel-title">Project</div>
        <button
          type="button"
          className="panel-action"
          onClick={onNewProfile}
          data-testid="browser-new-profile"
        >
          + Profile
        </button>
      </div>
      <div className="browser-toolbar">
        <label>
          Group
          <select
            value={groupBy}
            aria-label="Group by"
            data-testid="browser-group"
            onChange={(e) => setGroup(e.target.value as BrowserGroupBy)}
          >
            <option value="kind">Type / instance</option>
            <option value="category">Category</option>
            <option value="level">Level</option>
            <option value="profile">Profile</option>
            <option value="none">None</option>
          </select>
        </label>
        <label>
          Sort
          <select
            value={sortBy}
            aria-label="Sort by"
            data-testid="browser-sort"
            onChange={(e) => setSort(e.target.value as BrowserSortBy)}
          >
            <option value="name">Name</option>
            <option value="kind">Kind</option>
            <option value="category">Category</option>
          </select>
        </label>
      </div>
      <div className="browser-filter" role="tablist" aria-label="Show">
        {(
          [
            ['all', 'All'],
            ['types', 'Types'],
            ['instances', 'Instances'],
            ['references', 'Refs'],
            ['grids', 'Grids'],
            ['annotations', 'Annot.'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={filter === value}
            className={filter === value ? 'active' : ''}
            data-testid={`browser-filter-${value}`}
            onClick={() => setFilt(value)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="browser-tree-scroll shell-scroll" data-testid="browser-tree-scroll">
        {groups.length === 0 ? (
          <div className="empty">No types or elements yet. Draw a profile or place a wall.</div>
        ) : groupBy === 'none' ? (
          <ul className="browser-tree-items browser-tree-items--flat">
            {orderWithParentHierarchy(items).map(({ item, depth }) => (
              <BrowserTreeItem
                key={item.key}
                item={item}
                depth={depth}
                isSelected={isItemSelected(
                  item,
                  selected,
                  selectedProfileId,
                  selectedRefId,
                  selectedGridAxisId,
                  selectedConstructionLineId,
                  selectedSectionCutId,
                  selectedSpaceId,
                )}
                onSelectInstance={onSelectInstance}
                onSelectReference={onSelectReference}
                onSelectGridAxis={onSelectGridAxis}
                onSelectConstructionLine={onSelectConstructionLine}
                onSelectSectionCut={onSelectSectionCut}
                onSelectSpace={onSelectSpace}
                onSelectType={onSelectType}
              />
            ))}
          </ul>
        ) : (
          <div className="browser-tree">
            {groups.map(([label, groupItems]) => (
              <BrowserTreeGroup
                key={label}
                label={label}
                items={groupItems}
                expanded={isGroupExpanded(groupBy, label, collapsed)}
                onToggle={() => toggleGroup(label)}
                selected={selected}
                selectedProfileId={selectedProfileId}
                selectedRefId={selectedRefId}
                selectedGridAxisId={selectedGridAxisId}
                selectedConstructionLineId={selectedConstructionLineId}
                selectedSectionCutId={selectedSectionCutId}
                selectedSpaceId={selectedSpaceId}
                onSelectInstance={onSelectInstance}
                onSelectReference={onSelectReference}
                onSelectGridAxis={onSelectGridAxis}
                onSelectConstructionLine={onSelectConstructionLine}
                onSelectSectionCut={onSelectSectionCut}
                onSelectSpace={onSelectSpace}
                onSelectType={onSelectType}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
