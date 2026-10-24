/**
 * First-party toolbar icon catalog (ontology), parallel to `TOOL_TABS`.
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

/** Flat CAD glyphs: 14×14, stroke currentColor, no fill chrome. */
const CATALOG_SVG: Readonly<Record<string, string>> = {
  select:
    '<path d="M3 2l4 10 2-4 4-2z" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/>',
  move: '<path d="M7 2v10M2 7h10M4.5 4.5L2 7l2.5 2.5M9.5 4.5L12 7l-2.5 2.5" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>',
  copy: '<rect x="2.5" y="4" width="6.5" height="7.5" fill="none" stroke="currentColor" stroke-width="1.25"/><path d="M5.5 4V2.5h6.5V10H10" fill="none" stroke="currentColor" stroke-width="1.25"/>',
  parent:
    '<circle cx="7" cy="3.5" r="1.75" fill="none" stroke="currentColor" stroke-width="1.25"/><circle cx="3.5" cy="10.5" r="1.75" fill="none" stroke="currentColor" stroke-width="1.25"/><circle cx="10.5" cy="10.5" r="1.75" fill="none" stroke="currentColor" stroke-width="1.25"/><path d="M7 5.25v2M7 7.25L3.5 9M7 7.25l3.5 1.75" fill="none" stroke="currentColor" stroke-width="1.25"/>',
  detach:
    '<circle cx="4" cy="7" r="2" fill="none" stroke="currentColor" stroke-width="1.25"/><circle cx="10" cy="7" r="2" fill="none" stroke="currentColor" stroke-width="1.25"/><path d="M6 7h2" fill="none" stroke="currentColor" stroke-width="1.25" stroke-dasharray="1.5 1"/>',
  wall: '<path d="M2 11L7 3l5 8" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/><path d="M3.2 9h7.6" fill="none" stroke="currentColor" stroke-width="1.25"/>',
  column:
    '<rect x="4.5" y="2.5" width="5" height="9" fill="none" stroke="currentColor" stroke-width="1.25"/><path d="M3.5 11.5h7" fill="none" stroke="currentColor" stroke-width="1.25"/>',
  beam: '<path d="M2 5.5h10v3H2z" fill="none" stroke="currentColor" stroke-width="1.25"/><path d="M3.5 3.5v8M10.5 3.5v8" fill="none" stroke="currentColor" stroke-width="1.25"/>',
  slab: '<path d="M2 4.5h10v5H2z" fill="none" stroke="currentColor" stroke-width="1.25"/><path d="M2 7h10" fill="none" stroke="currentColor" stroke-width="1.25"/>',
  door: '<path d="M3.5 12V3.5h7V12" fill="none" stroke="currentColor" stroke-width="1.25"/><circle cx="8.5" cy="8" r="0.7" fill="currentColor"/><path d="M3.5 12h8" fill="none" stroke="currentColor" stroke-width="1.25"/>',
  window:
    '<rect x="2.5" y="3" width="9" height="8" fill="none" stroke="currentColor" stroke-width="1.25"/><path d="M7 3v8M2.5 7h9" fill="none" stroke="currentColor" stroke-width="1.25"/>',
  opening:
    '<rect x="2.5" y="3.5" width="9" height="7" fill="none" stroke="currentColor" stroke-width="1.25" stroke-dasharray="1.6 1.2"/>',
  stair:
    '<path d="M2.5 11.5h3v-2.5h3V6.5h3V3.5" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/>',
  roof: '<path d="M2 8.5L7 3l5 5.5" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/><path d="M3.5 8.5v3h7v-3" fill="none" stroke="currentColor" stroke-width="1.25"/>',
  pipe: '<path d="M2 7h10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="3.5" cy="7" r="1.6" fill="none" stroke="currentColor" stroke-width="1.1"/><circle cx="10.5" cy="7" r="1.6" fill="none" stroke="currentColor" stroke-width="1.1"/>',
  duct: '<rect x="2" y="4.5" width="10" height="5" rx="0" fill="none" stroke="currentColor" stroke-width="1.25"/><path d="M5 4.5v5M9 4.5v5" fill="none" stroke="currentColor" stroke-width="1.1"/>',
  cable:
    '<path d="M2.5 4.5c2 0 2 5 4.5 5s2.5-5 4.5-5" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>',
  'ref-point':
    '<circle cx="7" cy="7" r="2.25" fill="none" stroke="currentColor" stroke-width="1.25"/><path d="M7 2.5v2M7 9.5v2M2.5 7h2M9.5 7h2" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>',
  'ref-plane':
    '<path d="M2.5 10.5L7 3.5l4.5 7" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/><path d="M3.5 9h7" fill="none" stroke="currentColor" stroke-width="1.25"/>',
  grid: '<path d="M3 2.5v9M7 2.5v9M11 2.5v9M2.5 4h9M2.5 7h9M2.5 10h9" fill="none" stroke="currentColor" stroke-width="1.15"/>',
  level:
    '<path d="M2 11.5h10M2 7.5h10M2 3.5h10" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/><path d="M3.5 11.5V3.5" fill="none" stroke="currentColor" stroke-width="1.1"/>',
  'construction-line':
    '<path d="M2.5 11.5L11.5 2.5" fill="none" stroke="currentColor" stroke-width="1.25" stroke-dasharray="2 1.5" stroke-linecap="round"/><circle cx="2.5" cy="11.5" r="1" fill="currentColor"/><circle cx="11.5" cy="2.5" r="1" fill="currentColor"/>',
  'section-cut':
    '<path d="M2.5 11.5L11.5 2.5" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/><path d="M4 4.5h3.5v3.5" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linejoin="round"/>',
  space:
    '<path d="M3 3.5h8v7H3z" fill="none" stroke="currentColor" stroke-width="1.25"/><path d="M5 6.5h4M7 4.5v4" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>',
  'detect-rooms':
    '<path d="M2.5 3.5h4v4h-4zM7.5 3.5h4v4h-4zM2.5 8.5h9v3h-9z" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M4.5 5.5h0.01M9.5 5.5h0.01M7 10h0.01" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
};

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
  'apex.roof.pitched': TOOL_ICONS.roof,
  'apex.pipe': TOOL_ICONS.pipe,
  'apex.duct': TOOL_ICONS.duct,
  'apex.cable_tray': TOOL_ICONS.cable,
};

export function catalogIconByName(name: string): string | undefined {
  return CATALOG_SVG[name];
}

/**
 * Resolve a tool icon to SVG markup ready for `dangerouslySetInnerHTML`, or
 * `null` when missing/unknown (caller shows label only).
 */
export function resolveToolIconSvg(icon: ToolIcon | undefined): string | null {
  if (icon == null) return null;
  if (typeof icon === 'object' && 'svg' in icon) {
    const raw = icon.svg?.trim();
    if (!raw) return null;
    if (/^<svg[\s>]/i.test(raw)) return raw;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">${raw}</svg>`;
  }
  const inner = catalogIconByName(String(icon));
  if (!inner) return null;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">${inner}</svg>`;
}
