import { TOOL_ICON_SVG, type ToolIconSize } from './iconCatalog.generated';

export type { ToolIconSize } from './iconCatalog.generated';

/**
 * First-party toolbar icon catalog (ontology), parallel to `TOOL_TABS`.
 *
 * Glyphs come from the Poché set (`iconCatalog.generated.ts`): one file per
 * size (16 / 24 / 32 px), each drawn for its own pixel grid, two tones of
 * `currentColor`.
 *
 * Prefer a catalog name via `ApexIcons.*` / `window.apex.icons.*`.
 * Unknown names render nothing (label-only — never a broken image).
 * Third parties may pass `{ svg: string }` with a full `<svg>…</svg>` or
 * inner markup (paths) that the host wraps.
 */

/** Catalog names — stable ids for first-party glyphs. */
export const TOOL_ICONS = {
  select: 'select',
  move: 'move',
  copy: 'copy',
  parent: 'parent',
  detach: 'detach',
  boolean: 'boolean',
  wall: 'wall',
  column: 'column',
  beam: 'beam',
  slab: 'slab',
  door: 'door',
  window: 'window',
  opening: 'opening',
  stair: 'stair',
  roof: 'roof',
  pipe: 'pipe',
  duct: 'duct',
  cable: 'cable',
  refPoint: 'ref-point',
  refPlane: 'ref-plane',
  grid: 'grid',
  level: 'level',
  constructionLine: 'construction-line',
  sectionCut: 'section-cut',
  space: 'space',
  detectRooms: 'detect-rooms',
  fence: 'fence',
  gate: 'gate',
  siteSurface: 'site-surface',
  terrain: 'terrain',
  roofPitched: 'roof-pitched',
  dimension: 'dimension',
  textNote: 'text-note',
  component: 'component',
  genusEditor: 'genus-editor',
  view3d: 'view-3d',
  viewPlan: 'view-plan',
  viewFit: 'view-fit',
  thinLines: 'thin-lines',
  railing: 'railing',
  ceiling: 'ceiling',
  curtainWall: 'curtain-wall',
  foundation: 'foundation',
  wallOpening: 'wall-opening',
} as const;

export type ToolIconName = (typeof TOOL_ICONS)[keyof typeof TOOL_ICONS];

/** Alias preferred in SDK / examples (`ApexIcons.wall`). */
export const ApexIcons = TOOL_ICONS;

/**
 * Optional tool glyph.
 * - Catalog name string (prefer `ApexIcons.*`)
 * - `{ svg }` inline markup for custom icons
 */
export type ToolIcon = ToolIconName | (string & {}) | { svg: string };

/** Map built-in component ids → catalog icon names. */
export const COMPONENT_ICON_BY_ID: Readonly<Record<string, ToolIconName>> = {
  'apex.wall': TOOL_ICONS.wall,
  'apex.column': TOOL_ICONS.column,
  'apex.beam': TOOL_ICONS.beam,
  'apex.slab': TOOL_ICONS.slab,
  'apex.door': TOOL_ICONS.door,
  'apex.window': TOOL_ICONS.window,
  'apex.slab_opening': TOOL_ICONS.opening,
  'apex.stair': TOOL_ICONS.stair,
  'apex.roof': TOOL_ICONS.roof,
  'apex.roof.pitched': TOOL_ICONS.roofPitched,
  'apex.pipe': TOOL_ICONS.pipe,
  'apex.duct': TOOL_ICONS.duct,
  'apex.cable_tray': TOOL_ICONS.cable,
  'apex.fence': TOOL_ICONS.fence,
  'apex.gate': TOOL_ICONS.gate,
  'apex.site_surface': TOOL_ICONS.siteSurface,
  'apex.terrain': TOOL_ICONS.terrain,
};

/**
 * Icon for a component: its own catalog glyph, else the glyph of the genus it
 * extends, else the generic component glyph (user components are never
 * label-only).
 */
export function componentIcon(component: { id: string; genus?: { extends?: string } | null }): ToolIconName {
  const own = COMPONENT_ICON_BY_ID[component.id];
  if (own) return own;
  const base = component.genus?.extends;
  return (base && COMPONENT_ICON_BY_ID[base]) || TOOL_ICONS.component;
}

/** Nearest shipped size at or above `size` (falls back to the largest). */
function shippedSize(size: number): ToolIconSize {
  if (size <= 16) return 16;
  if (size <= 24) return 24;
  return 32;
}

/** Full `<svg>` markup for a catalog name at a size, or `undefined` when unknown. */
export function catalogIconByName(name: string, size: number = 24): string | undefined {
  return TOOL_ICON_SVG[shippedSize(size)][name];
}

/**
 * Give an icon's mask ids a per-instance prefix so many inline copies of the
 * same glyph never share (or shadow) one `<mask id>` in the document.
 */
export function scopeSvgIds(svg: string, scope: string): string {
  const safe = scope.replace(/[^a-zA-Z0-9_-]/g, '');
  return safe ? svg.replace(/apx-p-/g, `apx-${safe}-`) : svg;
}

/**
 * Resolve a tool icon to SVG markup ready for `dangerouslySetInnerHTML`, or
 * `null` when missing/unknown (caller shows label only). `size` picks the
 * pixel-grid version of catalog glyphs; custom inner markup keeps its 14×14
 * viewBox.
 */
export function resolveToolIconSvg(icon: ToolIcon | undefined, size: number = 24): string | null {
  if (icon == null) return null;
  if (typeof icon === 'object' && 'svg' in icon) {
    const raw = icon.svg?.trim();
    if (!raw) return null;
    if (/^<svg[\s>]/i.test(raw)) return raw;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">${raw}</svg>`;
  }
  return catalogIconByName(String(icon), size) ?? null;
}
