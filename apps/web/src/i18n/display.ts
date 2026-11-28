import type { Tool, ToolMode } from '../tools/Tool';
import type { Exporter } from '../plugins/types';
import { categoryPlaceLabel } from '../tools/categorySlots';
import { CATALOGS } from './catalogs';
import { localizeDocumentName } from '../ui/sampleLabels';
import { t } from './t';

/** Toolbar label for a tool (catalog by id, else tool.label). */
export function toolDisplayLabel(tool: Tool): string {
  if (tool.id.startsWith('place:category:')) {
    return categoryPlaceLabel(tool.id.slice('place:category:'.length), tool.label);
  }
  if (tool.id.startsWith('place:')) {
    const componentId = tool.id.slice('place:'.length);
    return t(`component.${componentId}`, undefined, tool.label);
  }
  return t(`tool.${tool.id}.label`, undefined, tool.label);
}

/**
 * Ribbon tooltip: a full sentence from `component.<id>.title` or
 * `tool.<id>.title`. A category button with no built-in genus uses
 * `category.place.<id>.title`. Otherwise the tool's purpose, when it says
 * more than the name.
 */
export function toolDisplayTitle(tool: Tool): string {
  if (tool.id.startsWith('place:category:')) {
    const category = tool.id.slice('place:category:'.length);
    const specific = t(`category.place.${category}.title`, undefined, '');
    if (specific) return specific;
    return t('category.place.title', { name: categoryPlaceLabel(category, tool.label) });
  }
  const key = tool.id.startsWith('place:')
    ? `component.${tool.id.slice('place:'.length)}.title`
    : `tool.${tool.id}.title`;
  const sentence = t(key, undefined, '');
  if (sentence) return sentence;
  const label = toolDisplayLabel(tool);
  const purpose = tool.descriptor?.purpose?.trim() ?? '';
  if (purpose && purpose !== label && purpose !== tool.label) return purpose;
  return label;
}

/** Draw-mode button label. */
export function modeDisplayLabel(mode: ToolMode): string {
  return t(`mode.${mode.id}`, undefined, mode.label);
}

/** Toolbar tab chip label (catalog tab ids). */
export function tabDisplayLabel(tabId: string, fallback: string): string {
  return t(`tab.${tabId}`, undefined, fallback);
}

/** Exporter button label / title. */
export function exporterDisplayLabel(exporter: Exporter): string {
  return t(`exporter.${exporter.id}.label`, undefined, exporter.label);
}

export function exporterDisplayTitle(exporter: Exporter): string {
  return t(`exporter.${exporter.id}.title`, undefined, exporter.title ?? exporter.label);
}

/** Component display name overlay for inspector / browser. */
export function componentDisplayName(componentId: string, fallback: string): string {
  return t(`component.${componentId}`, undefined, fallback);
}

const INSTANCE_COUNT = /^(.+?) (\d+)$/;
let instanceStems: Array<[string, string]> | null = null;

function numberedInstanceStems(): Array<[string, string]> {
  if (instanceStems) return instanceStems;
  const rows: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(CATALOGS.en)) {
    const numbered =
      (key.startsWith('component.') && !key.endsWith('.title')) || key.startsWith('name.');
    if (!numbered || !value) continue;
    rows.push([value, key]);
  }
  rows.sort((a, b) => b[0].length - a[0].length || a[0].localeCompare(b[0]));
  instanceStems = rows;
  return rows;
}

/**
 * Default instance names ("Door 1", "Wall 22") follow the active locale.
 * The stored document string is unchanged. Names a person typed stay as stored.
 */
export function instanceDisplayName(name: string): string {
  const asDocument = localizeDocumentName(name);
  if (asDocument !== name) return asDocument;
  const match = INSTANCE_COUNT.exec(name);
  if (!match) return name;
  const stem = match[1];
  for (const [en, key] of numberedInstanceStems()) {
    if (stem === en) return `${t(key)} ${match[2]}`;
  }
  return name;
}

/** Display name for a view: default core names ("L1 — Plan 2", "3D View") are shown localized. */
export function viewDisplayName(name: string): string {
  const plan = /^(.*) — Plan( \d+)?$/.exec(name);
  if (plan) return `${localizeDocumentName(plan[1])} — ${t('viewName.plan')}${plan[2] ?? ''}`;
  const three = /^3D View( \d+)?$/.exec(name);
  if (three) return `${t('viewName.threeD')}${three[1] ?? ''}`;
  return name;
}

/** Shipped species (catalog keys `species.<id>`). */
export const BUILTIN_SPECIES_IDS = [
  'apex.window.single-1200x1400',
  'apex.window.double-1500x1400',
  'apex.window.arched-900x1600',
  'apex.door.single-900x2100',
  'apex.door.double-1400x2100',
  'apex.door.transom-1000x2500',
  'apex.gate.single-1000x1500',
  'apex.site_line.fence',
  'apex.site_line.curb',
] as const;

/**
 * Display name for a species row. Shipped species come localized from the
 * catalog; names the core derives from them ("Window 1000×1400 (Window
 * 1200×1400 single sash)") get their English parts swapped. User names are
 * shown as typed.
 */
export function speciesDisplayName(row: { id: string; name: string; genus?: string }): string {
  const own = t(`species.${row.id}`, undefined, '');
  if (own) return own;
  let name = row.name;
  for (const id of BUILTIN_SPECIES_IDS) {
    const en = CATALOGS.en[`species.${id}`];
    if (en && name.includes(en)) name = name.replace(en, t(`species.${id}`));
  }
  const genus = row.genus ?? row.id.split('.').slice(0, 2).join('.');
  const genusEn = CATALOGS.en[`component.${genus}`];
  if (genusEn && name.startsWith(`${genusEn} `)) name = `${t(`component.${genus}`)}${name.slice(genusEn.length)}`;
  return name;
}
