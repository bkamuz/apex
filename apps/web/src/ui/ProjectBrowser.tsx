import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type {
  ComponentDto,
  ConstructionLineDto,
  ElementListDto,
  GridAxisDto,
  LevelDto,
  ProfileTypeDto,
  ReferenceDto,
  SectionCutDto,
  SpaceDto,
} from '../types';
import { t, useI18n } from '../i18n';
import { categoryDisplayLabel } from './categoryLabels';
import { isUserAuthoredComponent } from './componentModel';
import { componentDisplayName } from '../i18n';
import { isGenusComponent } from '../genusEditor/model';
import { profileLabel } from './profileModel';
import { ViewsSheetsPanel } from './ViewsSheetsPanel';
import type { SheetDto, ViewDto } from '../types';
import { matchesBrowserSearch, type SidebarTab } from './sidebarPrefs';

export type BrowserGroupBy = 'kind' | 'category' | 'level' | 'profile' | 'none';
export type BrowserSortBy = 'name' | 'kind' | 'category';

interface Props {
  /** Active browser tab (Виды / Модель / Роды). */
  tab: SidebarTab;
  onTabChange: (tab: SidebarTab) => void;
  /** Collapse button in the tab strip (desktop). */
  onCollapse?: () => void;
  /** Levels list shown at the top of the Виды tab. */
  levelsSlot?: ReactNode;
  elements: ElementListDto[];
  references: ReferenceDto[];
  gridAxes: GridAxisDto[];
  constructionLines: ConstructionLineDto[];
  sectionCuts: SectionCutDto[];
  spaces: SpaceDto[];
  profiles: ProfileTypeDto[];
  components: ComponentDto[];
  levels: LevelDto[];
  selectedIds: string[];
  selectedProfileId: string | null;
  selectedComponentId: string | null;
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
  onSelectComponent: (componentId: string) => void;
  onNewProfile: () => void;
  onNewComponent: () => void;
  views?: ViewDto[];
  sheets?: SheetDto[];
  activeLevelId?: string | null;
  openViewId?: string | null;
  openSheetId?: string | null;
  onOpenView?: (id: string) => void;
  onOpenSheet?: (id: string) => void;
  onNewPlanView?: (levelId: string) => void;
  onNewThreeDView?: () => void;
  onDuplicateView?: (id: string) => void;
  onRenameView?: (id: string, name: string) => void;
  onDeleteView?: (id: string) => void;
  onCreateSheetWithLayout?: (
    paper: import('../types').PaperSize,
    orientation: import('../types').PaperOrientation,
    customWidthMm: number,
    customHeightMm: number,
  ) => void;
  onRenameSheet?: (id: string, number: string, name: string) => void;
  onDeleteSheet?: (id: string) => void;
  /** Open a user genus in the genus editor mode. */
  onOpenGenus?: (id: string) => void;
  /** «Create based on» a built-in genus (a new genus that extends it). */
  onDeriveGenus?: (id: string) => void;
  /** The previous (modal) component editor. */
  onLegacyEditComponent?: (id: string) => void;
}

/** Роды rows with a genus body: click selects, double-click / actions open. */
interface GenusRowActions {
  activeId: string | null;
  setActiveId: (id: string | null) => void;
  onOpenGenus?: (id: string) => void;
  onDeriveGenus?: (id: string) => void;
  onLegacyEditComponent?: (id: string) => void;
}
const GenusRowContext = createContext<GenusRowActions | null>(null);

interface BrowserItem {
  key: string;
  kind:
    | 'type'
    | 'component_def'
    | 'instance'
    | 'reference'
    | 'grid_axis'
    | 'construction_line'
    | 'section_cut'
    | 'space';
  id: string;
  name: string;
  category: string;
  levelName: string;
  /** component_def: a built-in genus (read-only; «Create based on»). */
  builtIn?: boolean;
  /** component_def: has a universal genus body (opens in the genus editor). */
  hasGenus?: boolean;
  profileName: string;
  /** Element parent id when this row is a child instance. */
  parentId?: string | null;
}

interface BrowserPrefs {
  groupBy: BrowserGroupBy;
  sortBy: BrowserSortBy;
  collapsed: Partial<Record<BrowserGroupBy, string[]>>;
}

const BROWSER_PREFS_KEY = 'apex.browser.v2';

function loadPrefs(): BrowserPrefs {
  try {
    const raw = localStorage.getItem(BROWSER_PREFS_KEY);
    if (!raw) {
      return { groupBy: 'category', sortBy: 'name', collapsed: {} };
    }
    const parsed = JSON.parse(raw) as Partial<BrowserPrefs>;
    return {
      groupBy: parsed.groupBy ?? 'category',
      sortBy: parsed.sortBy ?? 'name',
      collapsed: parsed.collapsed ?? {},
    };
  } catch {
    return { groupBy: 'category', sortBy: 'name', collapsed: {} };
  }
}

function storePrefs(prefs: BrowserPrefs): void {
  try {
    localStorage.setItem(BROWSER_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
}

function groupKey(
  item: BrowserItem,
  groupBy: BrowserGroupBy,
  components: readonly ComponentDto[],
): string {
  switch (groupBy) {
    case 'kind':
      if (item.kind === 'component_def') return t('browser.kind.component_def');
      if (item.kind === 'type') return t('browser.kind.type');
      if (item.kind === 'reference') return t('browser.kind.reference');
      if (item.kind === 'grid_axis') return t('browser.kind.grid_axis');
      if (item.kind === 'construction_line') return t('browser.kind.construction_line');
      if (item.kind === 'section_cut') return t('browser.kind.section_cut');
      if (item.kind === 'space') return t('browser.kind.space');
      return t('browser.kind.element');
    case 'category':
      // Datums group under their own kind; placed elements and types by category.
      if (item.kind !== 'instance' && item.kind !== 'type' && item.kind !== 'component_def') {
        return groupKey(item, 'kind', components);
      }
      return categoryDisplayLabel(item.category || 'uncategorized', components);
    case 'level':
      return item.kind === 'type' ? t('browser.typesNotOnLevel') : item.levelName;
    case 'profile':
      return item.kind === 'type'
        ? t('browser.typePrefix', { name: item.name })
        : item.profileName || t('browser.noProfile');
    case 'none':
      return t('browser.filter.all');
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
  components: readonly ComponentDto[];
  isSelected: boolean;
  depth?: number;
  onSelectInstance: (id: string, multi: boolean) => void;
  onSelectReference: (id: string) => void;
  onSelectGridAxis: (id: string) => void;
  onSelectConstructionLine: (id: string) => void;
  onSelectSectionCut: (id: string) => void;
  onSelectSpace: (id: string) => void;
  onSelectType: (profileId: string) => void;
  onSelectComponent: (componentId: string) => void;
}

function kindBadge(kind: BrowserItem['kind'], depth = 0): string {
  switch (kind) {
    case 'component_def':
      return t('browser.badge.component');
    case 'type':
      return t('browser.badge.type');
    case 'reference':
      return t('browser.badge.reference');
    case 'grid_axis':
      return t('browser.badge.grid');
    case 'construction_line':
      return t('browser.badge.line');
    case 'section_cut':
      return t('browser.badge.cut');
    case 'space':
      return t('browser.badge.space');
    case 'instance':
      return depth > 0 ? t('browser.badge.child') : t('browser.badge.instance');
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
  components,
  isSelected,
  depth = 0,
  onSelectInstance,
  onSelectReference,
  onSelectGridAxis,
  onSelectConstructionLine,
  onSelectSectionCut,
  onSelectSpace,
  onSelectType,
  onSelectComponent,
}: BrowserTreeItemProps) {
  const isType = item.kind === 'type';
  const isComponentDef = item.kind === 'component_def';
  const genusRows = useContext(GenusRowContext);
  const genusRow = isComponentDef && (item.hasGenus || item.builtIn) && genusRows !== null;
  const genusActive = genusRow && genusRows?.activeId === item.id;
  const openGenus = () => {
    if (!genusRows) return;
    if (item.builtIn) genusRows.onDeriveGenus?.(item.id);
    else genusRows.onOpenGenus?.(item.id);
  };
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
      data-builtin={item.builtIn ? 'true' : undefined}
      className={isSelected || genusActive ? 'selected' : ''}
      style={depth > 0 ? { paddingLeft: 10 + depth * 14 } : undefined}
      onDoubleClick={genusRow ? openGenus : undefined}
      onClick={(event) => {
        if (genusRow) {
          if ((event.target as HTMLElement).closest('.browser-genus-actions')) return;
          genusRows?.setActiveId(genusActive ? null : item.id);
          return;
        }
        if (isType) onSelectType(item.id);
        else if (isComponentDef) onSelectComponent(item.id);
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
        {item.builtIn ? <span className="kind-badge kind-builtin">{t('browser.badge.builtIn')}</span> : null}
      </span>
      <span className="cat">
        {isType || isComponentDef
          ? categoryDisplayLabel(item.category, components)
          : isDatum
            ? item.levelName
            : item.profileName}
      </span>
      {genusActive ? (
        <span className="browser-genus-actions" data-testid={`browser-genus-actions-${item.id}`}>
          {item.builtIn ? (
            <button
              type="button"
              className="panel-action"
              data-testid="browser-genus-derive"
              title={t('browser.genus.deriveTitle')}
              onClick={() => genusRows?.onDeriveGenus?.(item.id)}
            >
              {t('browser.genus.derive')}
            </button>
          ) : (
            <>
              <button
                type="button"
                className="panel-action"
                data-testid="browser-genus-edit"
                title={t('browser.genus.editTitle')}
                onClick={() => genusRows?.onOpenGenus?.(item.id)}
              >
                {t('browser.genus.edit')}
              </button>
              <button
                type="button"
                className="panel-action"
                data-testid="browser-genus-legacy"
                title={t('browser.genus.legacyTitle')}
                onClick={() => genusRows?.onLegacyEditComponent?.(item.id)}
              >
                {t('browser.genus.legacy')}
              </button>
            </>
          )}
        </span>
      ) : null}
    </li>
  );
}

function isItemSelected(
  item: BrowserItem,
  selected: Set<string>,
  selectedProfileId: string | null,
  selectedComponentId: string | null,
  selectedRefId: string | null,
  selectedGridAxisId: string | null,
  selectedConstructionLineId: string | null,
  selectedSectionCutId: string | null,
  selectedSpaceId: string | null,
): boolean {
  switch (item.kind) {
    case 'type':
      return selectedProfileId === item.id;
    case 'component_def':
      return selectedComponentId === item.id;
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
  components: readonly ComponentDto[];
  expanded: boolean;
  onToggle: () => void;
  selected: Set<string>;
  selectedProfileId: string | null;
  selectedComponentId: string | null;
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
  onSelectComponent: (componentId: string) => void;
}

function BrowserTreeGroup({
  label,
  items,
  components,
  expanded,
  onToggle,
  selected,
  selectedProfileId,
  selectedComponentId,
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
  onSelectComponent,
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
              components={components}
              depth={depth}
              isSelected={isItemSelected(
                item,
                selected,
                selectedProfileId,
                selectedComponentId,
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
              onSelectComponent={onSelectComponent}
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
  components,
  levels,
  selectedIds,
  selectedProfileId,
  selectedComponentId,
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
  onSelectComponent,
  onNewProfile,
  onNewComponent,
  views = [],
  sheets = [],
  activeLevelId = null,
  openViewId = null,
  openSheetId = null,
  onOpenView,
  onOpenSheet,
  onNewPlanView,
  onNewThreeDView,
  onDuplicateView,
  onRenameView,
  onDeleteView,
  onCreateSheetWithLayout,
  onRenameSheet,
  onDeleteSheet,
  onOpenGenus,
  onDeriveGenus,
  onLegacyEditComponent,
  tab,
  onTabChange,
  onCollapse,
  levelsSlot,
}: Props) {
  const { t: tx, locale } = useI18n();
  const [activeGenusId, setActiveGenusId] = useState<string | null>(null);
  const genusRowActions = useMemo<GenusRowActions | null>(
    () =>
      onOpenGenus || onDeriveGenus
        ? { activeId: activeGenusId, setActiveId: setActiveGenusId, onOpenGenus, onDeriveGenus, onLegacyEditComponent }
        : null,
    [activeGenusId, onOpenGenus, onDeriveGenus, onLegacyEditComponent],
  );
  const initial = loadPrefs();
  const [groupBy, setGroupBy] = useState<BrowserGroupBy>(initial.groupBy);
  const [sortBy, setSortBy] = useState<BrowserSortBy>(initial.sortBy);
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Partial<Record<BrowserGroupBy, string[]>>>(
    initial.collapsed,
  );
  /** Group/Sort are secondary; keep the tree + filters as the primary scan path. */
  const [arrangeOpen, setArrangeOpen] = useState(false);

  const persist = useCallback(
    (next: Partial<BrowserPrefs>) => {
      const prefs: BrowserPrefs = {
        groupBy,
        sortBy,
        collapsed,
        ...next,
      };
      storePrefs(prefs);
    },
    [groupBy, sortBy, collapsed],
  );

  const setGroup = (value: BrowserGroupBy) => {
    setGroupBy(value);
    persist({ groupBy: value });
  };
  const setSort = (value: BrowserSortBy) => {
    setSortBy(value);
    persist({ sortBy: value });
  };

  const toggleGroup = (label: string) => {
    setCollapsed((prev) => {
      const list = prev[groupBy] ?? [];
      const nextList = list.includes(label)
        ? list.filter((entry) => entry !== label)
        : [...list, label];
      const next = { ...prev, [groupBy]: nextList };
      storePrefs({ groupBy, sortBy, collapsed: next });
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
    const componentDefs: BrowserItem[] = components
      .filter((def) => isUserAuthoredComponent(def) || (onDeriveGenus && isGenusComponent(def)))
      .map((def) => ({
      key: `component:${def.id}`,
      kind: 'component_def' as const,
      id: def.id,
      name: isUserAuthoredComponent(def) ? def.display_name : componentDisplayName(def.id, def.display_name),
      builtIn: !isUserAuthoredComponent(def),
      hasGenus: isGenusComponent(def),
      category: def.category,
      levelName: '',
      profileName: def.placement,
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
        : // Name the element's own component (a window is not a "Door" just
          // because both share the opening category).
          (components.find((c) => c.id === element.component_id)?.display_name ??
          categoryDisplayLabel(element.category, components)),
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
    let all =
      tab === 'genera'
        ? [...componentDefs, ...types]
        : [...instances, ...refs, ...grids, ...lines, ...cuts, ...spaceItems];
    if (query.trim()) {
      all = all.filter((item) =>
        matchesBrowserSearch(
          query,
          item.name,
          item.profileName,
          item.levelName,
          item.category,
          categoryDisplayLabel(item.category || 'uncategorized', components),
          groupKey(item, 'kind', components),
        ),
      );
    }
    all.sort((a, b) => compareItems(a, b, sortBy));
    return all;
  }, [
    elements,
    references,
    gridAxes,
    constructionLines,
    sectionCuts,
    spaces,
    profiles,
    components,
    levels,
    tab,
    query,
    sortBy,
    locale,
    onDeriveGenus,
  ]);

  const groups = useMemo(() => {
    const map = new Map<string, BrowserItem[]>();
    for (const item of items) {
      const key = groupKey(item, groupBy, components);
      const list = map.get(key) ?? [];
      list.push(item);
      map.set(key, list);
    }
    return [...map.entries()];
  }, [items, groupBy, components, locale]);

  const selected = new Set(selectedIds);

  const tabs: { id: SidebarTab; key: string }[] = [
    { id: 'views', key: 'sidebar.tab.views' },
    { id: 'model', key: 'sidebar.tab.model' },
    { id: 'genera', key: 'sidebar.tab.genera' },
  ];
  const totalInTab =
    tab === 'genera'
      ? profiles.length +
        components.filter((def) => isUserAuthoredComponent(def) || (onDeriveGenus && isGenusComponent(def))).length
      : elements.length + references.length + gridAxes.length + constructionLines.length + sectionCuts.length + spaces.length;

  return (
    <GenusRowContext.Provider value={genusRowActions}>
    <div className="project-browser" data-testid="project-browser" data-tab={tab}>
      <div className="browser-tabs" role="tablist" aria-label={tx('sidebar.tabsLabel')}>
        {tabs.map(({ id, key }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={`browser-tab${tab === id ? ' active' : ''}`}
            data-testid={`browser-tab-${id}`}
            onClick={() => onTabChange(id)}
          >
            {tx(key)}
          </button>
        ))}
        {onCollapse ? (
          <button
            type="button"
            className="browser-collapse"
            data-testid="sidebar-collapse"
            title={tx('sidebar.collapse')}
            aria-label={tx('sidebar.collapse')}
            onClick={onCollapse}
          >
            «
          </button>
        ) : null}
      </div>
      {tab === 'views' ? (
        <div className="browser-views shell-scroll" data-testid="browser-views">
          {levelsSlot}
          {onOpenView && onNewPlanView && onNewThreeDView ? (
            <ViewsSheetsPanel
              views={views}
              sheets={sheets}
              levels={levels}
              activeLevelId={activeLevelId}
              openViewId={openViewId}
              openSheetId={openSheetId}
              onOpenView={onOpenView}
              onOpenSheet={(id) => (onOpenSheet ?? onOpenView)?.(id)}
              onNewPlanView={onNewPlanView}
              onNewThreeDView={onNewThreeDView}
              onDuplicateView={onDuplicateView ?? (() => {})}
              onRenameView={onRenameView ?? (() => {})}
              onDeleteView={onDeleteView ?? (() => {})}
              onCreateSheetWithLayout={onCreateSheetWithLayout ?? (() => {})}
              onRenameSheet={onRenameSheet ?? (() => {})}
              onDeleteSheet={onDeleteSheet ?? (() => {})}
            />
          ) : null}
        </div>
      ) : (
        <>
      {tab === 'genera' ? (
        <div className="panel-title-row browser-genera-actions">
          <button
            type="button"
            className="panel-action"
            onClick={onNewComponent}
            data-testid="browser-new-component"
          >
            {tx('panel.addComponent')}
          </button>
          <button
            type="button"
            className="panel-action"
            onClick={onNewProfile}
            data-testid="browser-new-profile"
          >
            {tx('panel.addProfile')}
          </button>
        </div>
      ) : null}
      <div className="browser-search">
        <input
          type="search"
          value={query}
          placeholder={tx(tab === 'genera' ? 'browser.searchGenera' : 'browser.search')}
          aria-label={tx(tab === 'genera' ? 'browser.searchGenera' : 'browser.search')}
          data-testid="browser-search"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && query) {
              e.stopPropagation();
              setQuery('');
            }
          }}
        />
      </div>
      <div className={`browser-arrange${arrangeOpen ? ' is-open' : ''}`}>
        <button
          type="button"
          className="browser-arrange-toggle"
          aria-expanded={arrangeOpen}
          data-testid="browser-arrange-toggle"
          onClick={() => setArrangeOpen((open) => !open)}
        >
          {tx('browser.arrange')}
          <span className="browser-arrange-meta">
            {groupBy === 'kind' ? tx('browser.arrange.kindMeta') : groupBy} · {sortBy}
          </span>
        </button>
        {arrangeOpen ? (
          <div className="browser-toolbar">
            <label>
              {tx('browser.group')}
              <select
                value={groupBy}
                aria-label={tx('browser.groupBy')}
                data-testid="browser-group"
                onChange={(e) => setGroup(e.target.value as BrowserGroupBy)}
              >
                <option value="kind">{tx('browser.group.kind')}</option>
                <option value="category">{tx('browser.group.category')}</option>
                <option value="level">{tx('browser.group.level')}</option>
                <option value="profile">{tx('browser.group.profile')}</option>
                <option value="none">{tx('browser.group.none')}</option>
              </select>
            </label>
            <label>
              {tx('browser.sort')}
              <select
                value={sortBy}
                aria-label={tx('browser.sortBy')}
                data-testid="browser-sort"
                onChange={(e) => setSort(e.target.value as BrowserSortBy)}
              >
                <option value="name">{tx('browser.sort.name')}</option>
                <option value="kind">{tx('browser.sort.kind')}</option>
                <option value="category">{tx('browser.sort.category')}</option>
              </select>
            </label>
          </div>
        ) : null}
      </div>
      <div className="browser-tree-scroll shell-scroll" data-testid="browser-tree-scroll">
        {groups.length === 0 ? (
          <div className="empty">
            {query.trim() && totalInTab > 0
              ? tx('browser.noMatches')
              : tx(tab === 'genera' ? 'browser.emptyGenera' : 'browser.emptyModel')}
          </div>
        ) : groupBy === 'none' ? (
          <ul className="browser-tree-items browser-tree-items--flat">
            {orderWithParentHierarchy(items).map(({ item, depth }) => (
              <BrowserTreeItem
                key={item.key}
                item={item}
                components={components}
                depth={depth}
                isSelected={isItemSelected(
                  item,
                  selected,
                  selectedProfileId,
                  selectedComponentId,
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
                onSelectComponent={onSelectComponent}
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
                components={components}
                expanded={isGroupExpanded(groupBy, label, collapsed)}
                onToggle={() => toggleGroup(label)}
                selected={selected}
                selectedProfileId={selectedProfileId}
                selectedComponentId={selectedComponentId}
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
                onSelectComponent={onSelectComponent}
              />
            ))}
          </div>
        )}
      </div>
        </>
      )}
    </div>
    </GenusRowContext.Provider>
  );
}
