/**
 * Minimal third-party tool stub for apex.
 *
 * Load manually in dev (e.g. dynamic import from the console) or copy into
 * `apps/web/src/plugins/` and add the plugin to `firstPartyPlugins`.
 *
 * Registers through the same surface runtime modules use:
 *   window.apex.registerTool(tool)
 */
import type { Tool } from '../apps/web/src/tools/Tool';

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

// In the browser console after the app loads:
//   import('/examples/custom-tool.ts').then(m => window.apex.registerTool(m.helloTool))
