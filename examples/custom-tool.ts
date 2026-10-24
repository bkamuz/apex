/**
 * Minimal third-party tool / exporter stub for apex.
 *
 * Load manually in dev (e.g. dynamic import from the console) or copy into
 * `apps/web/src/plugins/` and add the plugin to `firstPartyPlugins`.
 *
 * Registers through the same surface runtime modules use:
 *   window.apex.registerTool(tool)
 *   window.apex.registerExporter(exporter)
 *
 * Toolbar tabs: prefer a catalog entry (`window.apex.tabs.building` /
 * `ApexTabs.building` / `ApexTabs.basics` / `ApexTabs.engineering`). A custom
 * `{ id, label }` not in the catalog creates a new tab automatically. Omit
 * `label` only for catalog ids — the default label is filled in.
 * Select/transform tools usually omit `tab` (always pinned).
 *
 * Toolbar icons (optional): prefer a catalog name (`window.apex.icons.wall` /
 * `ApexIcons.wall`). Pass `{ svg: '<svg>…</svg>' }` (or path markup) for a
 * custom glyph. Omit `icon` — or use an unknown name — for a label-only
 * button (never a broken image).
 */
import type { Tool } from '../apps/web/src/tools/Tool';
import { ApexIcons } from '../apps/web/src/tools/icons';
import { ApexTabs } from '../apps/web/src/tools/tabs';
import type { Exporter } from '../apps/web/src/plugins/types';

/** Example: a no-op tool that only logs clicks (no icon → label only). */
export const helloTool: Tool = {
  id: 'acme.hello',
  label: 'Hello',
  group: 'transform',
  shortcut: 'H',
  hint: () => 'Click the canvas — this tool does nothing yet',
  onClick(_e, ctx) {
    ctx.setError('Hello from a custom tool');
  },
};

/**
 * Example: join the first-party Building constructions tab via the catalog,
 * with a catalog icon.
 */
export const planterTool: Tool = {
  id: 'acme.planter-place',
  label: 'Planter place',
  group: 'create',
  tab: ApexTabs.building,
  icon: ApexIcons.slab,
  hint: () => 'Demo tool on the Building constructions tab',
  onClick(_e, ctx) {
    ctx.setError('Planter place — prefer ApexTabs / ApexIcons; custom icon via { svg }');
  },
};

/** Example: Basics tab + custom inline SVG icon. */
export const stakeTool: Tool = {
  id: 'acme.stake',
  label: 'Stake',
  group: 'create',
  tab: ApexTabs.basics,
  icon: {
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 14 14" width="14" height="14"><path d="M7 2v10M4 11h6" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/></svg>',
  },
  hint: () => 'Demo Basics-tab tool with a custom SVG icon',
  onClick(_e, ctx) {
    ctx.setError('Custom { svg } icon on ApexTabs.basics');
  },
};

/** Example: Engineering tab (MEP / services) via the catalog. */
export const conduitTool: Tool = {
  id: 'acme.conduit',
  label: 'Conduit',
  group: 'create',
  tab: ApexTabs.engineering,
  icon: ApexIcons.pipe,
  hint: () => 'Demo tool on the Engineering tab',
  onClick(_e, ctx) {
    ctx.setError('Conduit — prefer ApexTabs.engineering for MEP create tools');
  },
};

/** Example: open-world tab — not in the catalog, so supply a label. */
export const spacesTool: Tool = {
  id: 'acme.space',
  label: 'Space',
  group: 'create',
  tab: { id: 'acme.spaces', label: 'Spaces' },
  hint: () => 'Demo tool that creates a custom Spaces tab',
  onClick(_e, ctx) {
    ctx.setError('Custom tab id creates a new toolbar tab');
  },
};

/** Example: a tiny text exporter contributed like the first-party IFC plugin. */
export const helloExporter: Exporter = {
  id: 'acme.hello-export',
  label: 'Hello.txt',
  filename: 'hello.txt',
  export: () => 'hello from a custom exporter\n',
};

// In the browser console after the app loads:
//   import('/examples/custom-tool.ts').then((m) => {
//     window.apex.registerTool(m.helloTool)   // label-only
//     window.apex.registerTool(m.planterTool) // catalog tab + icon
//     window.apex.registerTool(m.stakeTool)   // basics + custom svg
//     window.apex.registerTool(m.conduitTool) // engineering tab
//     window.apex.registerTool(m.spacesTool)  // custom tab
//     window.apex.registerExporter(m.helloExporter)
//   })
