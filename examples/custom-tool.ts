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
 * `ApexTabs.building`). A custom `{ id, label }` not in the catalog creates a
 * new tab automatically. Omit `label` only for catalog ids — the default label
 * is filled in. Select/transform tools usually omit `tab`.
 */
import type { Tool } from '../apps/web/src/tools/Tool';
import { ApexTabs } from '../apps/web/src/tools/tabs';
import type { Exporter } from '../apps/web/src/plugins/types';

/** Example: a no-op tool that only logs clicks. */
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
 * Example: join the first-party Building constructions tab via the catalog.
 * Prefer `ApexTabs.building` (or `window.apex.tabs.building`); a custom id
 * creates a new tab.
 */
export const planterTool: Tool = {
  id: 'acme.planter-place',
  label: 'Planter place',
  group: 'create',
  tab: ApexTabs.building,
  hint: () => 'Demo tool on the Building constructions tab',
  onClick(_e, ctx) {
    ctx.setError('Planter place — prefer ApexTabs; custom { id, label } creates a new tab');
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
//     window.apex.registerTool(m.helloTool)
//     window.apex.registerTool(m.planterTool) // catalog tab
//     window.apex.registerTool(m.spacesTool)  // custom tab
//     window.apex.registerExporter(m.helloExporter)
//   })
