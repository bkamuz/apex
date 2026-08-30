import { extensions } from '../extensions/sdk';
import type { ComponentDto } from '../types';
import type { ToolRegistry } from '../tools/registry';
import { firstPartyPlugins } from './catalog';
import type { PluginHost } from './types';

export type { Plugin, PluginHost } from './types';
export { firstPartyPlugins } from './catalog';

/** Rebuild the toolbar from first-party plugins plus any runtime modules. */
export function installPlugins(registry: ToolRegistry, components: ComponentDto[]): void {
  registry.reset();
  const byId = new Map(components.map((component) => [component.id, component]));
  const host: PluginHost = {
    component: (id) => byId.get(id),
    registerTool: (tool) => registry.register(tool),
  };
  for (const plugin of firstPartyPlugins) plugin.install(host);
  for (const tool of extensions.customTools()) host.registerTool(tool);
}
