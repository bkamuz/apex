import { useMemo, useState } from 'react';
import type { ElementListDto, GridAxisDto, LevelDto, ProfileTypeDto, ReferenceDto } from '../types';
import { profileLabel } from './profileModel';

export type BrowserGroupBy = 'kind' | 'category' | 'level' | 'profile' | 'none';
export type BrowserSortBy = 'name' | 'kind' | 'category';
export type BrowserFilter = 'all' | 'types' | 'instances' | 'references' | 'grids';

interface Props {
  elements: ElementListDto[];
  references: ReferenceDto[];
  gridAxes: GridAxisDto[];
  profiles: ProfileTypeDto[];
  levels: LevelDto[];
  selectedIds: string[];
  selectedProfileId: string | null;
  selectedRefId: string | null;
  selectedGridAxisId: string | null;
  onSelectInstance: (id: string, multi: boolean) => void;
  onSelectReference: (id: string) => void;
  onSelectGridAxis: (id: string) => void;
  onSelectType: (profileId: string) => void;
  onNewProfile: () => void;
}

interface BrowserItem {
  key: string;
  kind: 'type' | 'instance' | 'reference' | 'grid_axis';
  id: string;
  name: string;
  category: string;
  levelName: string;
  profileName: string;
}

const BROWSER_PREFS_KEY = 'apex.browser';

function loadPrefs(): { groupBy: BrowserGroupBy; sortBy: BrowserSortBy; filter: BrowserFilter } {
  try {
    const raw = localStorage.getItem(BROWSER_PREFS_KEY);
    if (!raw) return { groupBy: 'kind', sortBy: 'name', filter: 'all' };
    const parsed = JSON.parse(raw) as Partial<{
      groupBy: BrowserGroupBy;
      sortBy: BrowserSortBy;
      filter: BrowserFilter;
    }>;
    return {
      groupBy: parsed.groupBy ?? 'kind',
      sortBy: parsed.sortBy ?? 'name',
      filter: parsed.filter ?? 'all',
    };
  } catch {
    return { groupBy: 'kind', sortBy: 'name', filter: 'all' };
  }
}

function storePrefs(prefs: {
  groupBy: BrowserGroupBy;
  sortBy: BrowserSortBy;
  filter: BrowserFilter;
}): void {
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

export function ProjectBrowser({
  elements,
  references,
  gridAxes,
  profiles,
  levels,
  selectedIds,
  selectedProfileId,
  selectedRefId,
  selectedGridAxisId,
  onSelectInstance,
  onSelectReference,
  onSelectGridAxis,
  onSelectType,
  onNewProfile,
}: Props) {
  const initial = loadPrefs();
  const [groupBy, setGroupBy] = useState<BrowserGroupBy>(initial.groupBy);
  const [sortBy, setSortBy] = useState<BrowserSortBy>(initial.sortBy);
  const [filter, setFilter] = useState<BrowserFilter>(initial.filter);

  const setGroup = (value: BrowserGroupBy) => {
    setGroupBy(value);
    storePrefs({ groupBy: value, sortBy, filter });
  };
  const setSort = (value: BrowserSortBy) => {
    setSortBy(value);
    storePrefs({ groupBy, sortBy: value, filter });
  };
  const setFilt = (value: BrowserFilter) => {
    setFilter(value);
    storePrefs({ groupBy, sortBy, filter: value });
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
      levelName: levelName(element.level_id),
      profileName: element.profile_id
        ? profileLabel(profiles, element.profile_id)
        : element.category,
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
    let all = [...types, ...instances, ...refs, ...grids];
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
      default: {
        const exhaustive: never = filter;
        return exhaustive;
      }
    }
    all.sort((a, b) => compareItems(a, b, sortBy));
    return all;
  }, [elements, references, gridAxes, profiles, levels, filter, sortBy]);

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
      {groups.length === 0 ? (
        <div className="empty">No types or elements yet. Draw a profile or place a wall.</div>
      ) : (
        groups.map(([label, groupItems]) => (
          <div key={label} className="browser-group">
            {groupBy !== 'none' ? <div className="browser-group-title">{label}</div> : null}
            <ul className="element-list">
              {groupItems.map((item) => {
                const isType = item.kind === 'type';
                const isRef = item.kind === 'reference';
                const isGrid = item.kind === 'grid_axis';
                const isSelected = isType
                  ? selectedProfileId === item.id
                  : isRef
                    ? selectedRefId === item.id
                    : isGrid
                      ? selectedGridAxisId === item.id
                      : selected.has(item.id);
                return (
                  <li
                    key={item.key}
                    data-kind={item.kind}
                    data-id={item.id}
                    className={isSelected ? 'selected' : ''}
                    onClick={(event) => {
                      if (isType) onSelectType(item.id);
                      else if (isRef) onSelectReference(item.id);
                      else if (isGrid) onSelectGridAxis(item.id);
                      else onSelectInstance(item.id, event.ctrlKey || event.metaKey);
                    }}
                  >
                    <span>
                      {item.name}
                      <span className={`kind-badge kind-${item.kind}`}>
                        {isType ? 'type' : isRef ? 'ref' : isGrid ? 'grid' : 'instance'}
                      </span>
                    </span>
                    <span className="cat">
                      {isType ? item.category : isRef || isGrid ? item.levelName : item.profileName}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        ))
      )}
    </div>
  );
}
