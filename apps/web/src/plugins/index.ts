import { apexListComponents, apexRegisterComponent } from '../wasm/apex';
import { extensions } from '../extensions/sdk';
import type { ComponentDto } from '../types';
import type { ToolRegistry } from '../tools/registry';
import { alwaysOnPlugins, systemPacks } from './catalog';
import { exporterRegistry } from './exporters';
import { importerRegistry } from './importers';
import { underlayLinkerRegistry } from './underlayLinkers';
import { pluginsForEnabledPacks } from './packPrefs';
import { getEnabledPackIds } from './packStore';
import { registerUserComponentTools } from './userComponentTools';
import type { PluginHost } from './types';
import { assertDescribed } from '../descriptor';

export type { Plugin, PluginHost, Exporter, Importer, UnderlayLinker, SystemPack } from './types';
export {
  alwaysOnPlugins,
  firstPartyPlugins,
  systemPacks,
} from './catalog';
export {
  PACK_STORAGE_KEY,
  defaultEnabledPackIds,
  loadEnabledPackIds,
  saveEnabledPackIds,
  pluginsForEnabledPacks,
} from './packPrefs';
export {
  getEnabledPackIds,
  setPackEnabled,
  isPackEnabled,
  subscribePackPrefs,
} from './packStore';
export { exporterRegistry } from './exporters';
export { importerRegistry } from './importers';
export { underlayLinkerRegistry } from './underlayLinkers';

export type InstallPluginsOptions = {
  /** Override enabled pack ids (tests). Default: localStorage / pack defaults. */
  enabledPackIds?: readonly string[];
};

/**
 * Rebuild the toolbar and exporters from always-on plugins, enabled system
 * packs, user components, plus runtime `window.apex` modules.
 */
export function installPlugins(
  registry: ToolRegistry,
  components: ComponentDto[],
  options?: InstallPluginsOptions,
): void {
  registry.reset();
  exporterRegistry.reset();
  importerRegistry.reset();
  underlayLinkerRegistry.reset();
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
    registerUnderlayLinker: (linker) => underlayLinkerRegistry.register(linker),
  };

  const enabledIds = options?.enabledPackIds ?? getEnabledPackIds();
  for (const plugin of pluginsForEnabledPacks(alwaysOnPlugins, systemPacks, enabledIds)) {
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
