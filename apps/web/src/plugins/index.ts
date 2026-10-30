import { apexListComponents, apexRegisterComponent } from '../wasm/apex';
import { extensions } from '../extensions/sdk';
import type { ComponentDto } from '../types';
import type { ToolRegistry } from '../tools/registry';
import { firstPartyPlugins } from './catalog';
import { exporterRegistry } from './exporters';
import { importerRegistry } from './importers';
import { registerUserComponentTools } from './userComponentTools';
import type { PluginHost } from './types';
import { assertDescribed } from '../descriptor';

export type { Plugin, PluginHost, Exporter, Importer } from './types';
export { firstPartyPlugins } from './catalog';
export { exporterRegistry } from './exporters';
export { importerRegistry } from './importers';

/** Rebuild the toolbar and exporters from first-party plugins plus runtime modules. */
export function installPlugins(registry: ToolRegistry, components: ComponentDto[]): void {
  registry.reset();
  exporterRegistry.reset();
  importerRegistry.reset();
  const byId = new Map(components.map((component) => [component.id, component]));
  const host: PluginHost = {
    component: (id) => byId.get(id),
    registerTool: (tool) => registry.register(tool),
    registerComponent: (definition) => {
      apexRegisterComponent(definition);
      // Refresh local lookup so a later registerTool in the same install sees it.
      for (const component of apexListComponents()) {
        byId.set(component.id, component);
      }
      extensions.notifyCatalogChanged();
    },
    registerExporter: (exporter) => exporterRegistry.register(exporter),
    registerImporter: (importer) => importerRegistry.register(importer),
  };
  for (const plugin of firstPartyPlugins) {
    assertDescribed('plugin', plugin.id, plugin);
    plugin.install(host);
  }
  registerUserComponentTools(registry, components);
  for (const tool of extensions.customTools()) {
    if (!registry.get(tool.id)) host.registerTool(tool);
  }
  for (const exporter of extensions.customExporters()) host.registerExporter(exporter);
  for (const importer of extensions.customImporters()) host.registerImporter(importer);
}
