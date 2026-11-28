import { CATALOGS } from '../i18n/catalogs';
import { t } from '../i18n/t';
import type { ToolTab } from './Tool';
import { ApexTabs } from './tabs';
import type { ComponentDto } from '../types';

/**
 * Ribbon slots: one button per category.
 *
 * `opening` is stored as one category for doors, windows, gates and slab
 * openings. Those stay separate buttons (a window genus is not a door).
 * Every other category — including flat and pitched roofs — is one button.
 * A user genus that extends a built-in opening stays on that button.
 */
export interface RibbonComponent {
  id: string;
  display_name: string;
  category: string;
  source: ComponentDto['source'];
  placement: ComponentDto['placement'];
  host_cut?: { host_categories: string[] } | null;
  genus?: { extends?: string } | null;
  default_species?: string | null;
  descriptor?: { purpose?: string } | null;
}

export interface RibbonSlot<T extends RibbonComponent = RibbonComponent> {
  key: string;
  /** Ribbon command id. Built-in primaries keep `place:apex.*`. */
  toolId: string;
  /** Other built-in command ids in this slot. Registered, not shown. */
  aliasToolIds: string[];
  genera: T[];
  primaryGenusId: string;
  category: string;
  /** When set, the button label is this component's catalog name. */
  labelComponentId?: string;
}

const ENGINEERING = new Set(['pipe', 'duct', 'cable', 'mep']);
const SITE = new Set(['fence', 'site', 'site_line', 'surface', 'landscape', 'topo']);

/** Prefer these built-ins when a category has more than one (roof). */
const PRIMARY_PREFERENCE = [
  'apex.wall',
  'apex.door',
  'apex.window',
  'apex.slab',
  'apex.roof',
  'apex.column',
  'apex.beam',
  'apex.stair',
  'apex.pipe',
  'apex.duct',
  'apex.cable_tray',
  'apex.fence',
  'apex.site_line',
  'apex.gate',
  'apex.site_surface',
  'apex.terrain',
  'apex.slab_opening',
];

export function isBuiltInSource(source: RibbonComponent['source']): boolean {
  return source === 'built_in';
}

export function toolIdForGenus(id: string): string {
  return `place:${id}`;
}

function skippedCategory(category: string): boolean {
  const cat = category.trim().toLowerCase();
  return cat === 'genus-part' || cat === 'modifier';
}

function lineageRoot<T extends RibbonComponent>(component: T, byId: ReadonlyMap<string, T>): T {
  let current = component;
  const seen = new Set<string>();
  while (current.genus?.extends && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = byId.get(current.genus.extends);
    if (!parent) break;
    current = parent;
  }
  return current;
}

/** Slot key for a component, or null when it is not a placeable genus. */
export function slotKeyFor(
  component: RibbonComponent,
  components: readonly RibbonComponent[],
): string | null {
  if (skippedCategory(component.category)) return null;
  const byId = new Map(components.map((item) => [item.id, item]));
  return slotKey(component, byId, (root) => isBuiltInSource(root.source));
}

/**
 * Genera the inspector may swap an instance to: same placement, and either
 * the same category or the same ribbon slot. A genus with no species row is
 * omitted unless it is the current one.
 */
export function generaForCategorySwitch<T extends RibbonComponent>(
  component: T,
  components: readonly T[],
  speciesGenusIds: ReadonlySet<string>,
): T[] {
  const slot = slotKeyFor(component, components);
  return components.filter((item) => {
    if (item.category === 'genus-part' || item.placement !== component.placement) return false;
    const sameCategory = item.category.toLowerCase() === component.category.toLowerCase();
    const sameSlot = slot != null && slotKeyFor(item, components) === slot;
    if (!sameCategory && !sameSlot) return false;
    if (item.id === component.id) return true;
    if (item.default_species) return true;
    return speciesGenusIds.has(item.id);
  });
}

function slotKey(
  component: RibbonComponent,
  byId: ReadonlyMap<string, RibbonComponent>,
  splitOpening: (root: RibbonComponent) => boolean,
): string {
  const root = lineageRoot(component, byId);
  const own = (component.category || 'generic').trim().toLowerCase();
  const rootCat = (root.category || own).trim().toLowerCase();
  // An explicit category other than opening leaves the built-in opening button.
  if (own !== 'opening' && own !== rootCat) return `category:${own}`;
  if (rootCat === 'opening' && splitOpening(root)) return `opening:${root.id}`;
  if (own === 'opening' || rootCat === 'opening') return 'category:opening';
  return `category:${own}`;
}

function choosePrimary<T extends RibbonComponent>(tooled: readonly T[]): T | undefined {
  if (tooled.length === 0) return undefined;
  for (const id of PRIMARY_PREFERENCE) {
    const hit = tooled.find((item) => item.id === id);
    if (hit) return hit;
  }
  return [...tooled].sort((a, b) => a.id.length - b.id.length || a.id.localeCompare(b.id))[0];
}

/**
 * Group placeable genera into ribbon slots.
 * `existingToolIds` is the set of command ids already registered by plugins
 * (`place:apex.wall`, …). Built-ins without a tool (boolean, IFC mesh, nested
 * parts) do not grow the ribbon.
 */
export function ribbonSlots<T extends RibbonComponent>(
  components: readonly T[],
  existingToolIds: ReadonlySet<string>,
): RibbonSlot<T>[] {
  const byId = new Map(components.map((item) => [item.id, item]));
  const placeable = components.filter((item) => {
    if (skippedCategory(item.category)) return false;
    if (isBuiltInSource(item.source)) return existingToolIds.has(toolIdForGenus(item.id));
    return true;
  });
  const groups = new Map<string, T[]>();
  for (const item of placeable) {
    const key = slotKey(item, byId, (root) =>
      isBuiltInSource(root.source) && existingToolIds.has(toolIdForGenus(root.id)),
    );
    const list = groups.get(key);
    if (list) list.push(item);
    else groups.set(key, [item]);
  }
  const slots: RibbonSlot<T>[] = [];
  for (const [key, genera] of groups) {
    const tooled = genera.filter(
      (item) => isBuiltInSource(item.source) && existingToolIds.has(toolIdForGenus(item.id)),
    );
    const primary = choosePrimary(tooled) ?? genera[0];
    if (!primary) continue;
    const toolId = tooled.length > 0 ? toolIdForGenus(primary.id) : `place:category:${primary.category.toLowerCase()}`;
    const aliasToolIds = tooled
      .map((item) => toolIdForGenus(item.id))
      .filter((id) => id !== toolId);
    const ordered = [
      primary,
      ...genera.filter((item) => item.id !== primary.id && isBuiltInSource(item.source)),
      ...genera
        .filter((item) => item.id !== primary.id && !isBuiltInSource(item.source))
        .sort((a, b) => a.display_name.localeCompare(b.display_name) || a.id.localeCompare(b.id)),
    ];
    slots.push({
      key,
      toolId,
      aliasToolIds,
      genera: ordered,
      primaryGenusId: primary.id,
      category: primary.category.toLowerCase(),
      labelComponentId: isBuiltInSource(primary.source) ? primary.id : undefined,
    });
  }
  return slots;
}

/** Hosted genera snap to a host; everyone else uses free placement. */
export function placementStyle(component: RibbonComponent): 'hosted' | 'free' {
  return component.host_cut ? 'hosted' : 'free';
}

export function tabForCategory(category: string): ToolTab {
  const cat = category.toLowerCase();
  if (ENGINEERING.has(cat) || cat.startsWith('mep.')) return ApexTabs.engineering;
  if (SITE.has(cat) || cat.startsWith('site')) return ApexTabs.site;
  return ApexTabs.building;
}

/** Sentence-case category name for a ribbon button that has no built-in genus. */
export function categoryPlaceLabel(category: string, fallback?: string): string {
  const named = t(`category.place.${category}`, undefined, '');
  if (named) return named;
  if (fallback && fallback.trim()) return fallback;
  const tail = category.includes('.') ? category.slice(category.lastIndexOf('.') + 1) : category;
  const words = tail.replace(/[_-]+/g, ' ').trim();
  if (!words) return category;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Both catalog languages, for palette search. */
export function categoryPlaceLabelBoth(category: string): string {
  const key = `category.place.${category}`;
  return `${CATALOGS.en[key] ?? ''} ${CATALOGS.ru[key] ?? ''}`.trim();
}

/**
 * Tooltip for a genus. Built-ins use their catalog sentence. User genera use
 * the authored purpose, or a localized “user genus” line — never the bare name.
 */
export function genusTooltip(component: RibbonComponent): string {
  const catalog = t(`component.${component.id}.title`, undefined, '');
  if (catalog) return catalog;
  const purpose = component.descriptor?.purpose?.trim() ?? '';
  const authored = /^User genus '(.+)'\.$/.exec(purpose);
  if (authored) return t('genus.userPurpose', { name: authored[1] });
  const name = t(`component.${component.id}`, undefined, component.display_name);
  if (purpose && purpose !== name && purpose !== component.display_name) return purpose;
  return t('genus.userPurpose', { name });
}

const MEMORY_KEY = 'apex.categoryPlacement';

type MemoryMap = Record<string, { genusId: string; speciesId: string | null }>;

let memory: MemoryMap | null = null;

function storage(): Storage | undefined {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : undefined;
  } catch {
    return undefined;
  }
}

function loadMemory(): MemoryMap {
  if (memory) return memory;
  memory = {};
  try {
    const raw = storage()?.getItem(MEMORY_KEY);
    if (raw) memory = JSON.parse(raw) as MemoryMap;
  } catch {
    memory = {};
  }
  return memory;
}

export interface SlotSelection {
  genusId: string;
  speciesId: string | null;
}

/** Last-used genus and species for a slot, or the primary genus. */
export function readSlotSelection(slot: RibbonSlot): SlotSelection {
  const saved = loadMemory()[slot.key];
  const genus =
    slot.genera.find((item) => item.id === saved?.genusId) ??
    slot.genera.find((item) => item.id === slot.primaryGenusId) ??
    slot.genera[0];
  if (!genus) return { genusId: slot.primaryGenusId, speciesId: null };
  const speciesId =
    saved?.genusId === genus.id
      ? (saved.speciesId ?? genus.default_species ?? null)
      : (genus.default_species ?? null);
  return { genusId: genus.id, speciesId };
}

export function writeSlotSelection(slotKey: string, genusId: string, speciesId: string | null): void {
  const map = loadMemory();
  map[slotKey] = { genusId, speciesId };
  try {
    storage()?.setItem(MEMORY_KEY, JSON.stringify(map));
  } catch {
    /* private mode / tests without storage */
  }
}

export function resetCategoryPlacementMemory(): void {
  memory = {};
  try {
    storage()?.removeItem(MEMORY_KEY);
  } catch {
    /* ignore */
  }
}
