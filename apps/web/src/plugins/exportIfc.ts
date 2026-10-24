import { apexExportIfc } from '../wasm/apex';
import type { Plugin } from './types';

/** First-party IFC4 exporter — registered through PluginHost, not App branches. */
export const exportIfcPlugin: Plugin = {
  id: 'apex.export.ifc',
  install(host) {
    host.registerExporter({
      id: 'apex.ifc',
      label: 'IFC',
      title: 'Export building model as IFC4 (.ifc)',
      filename: 'apex-export.ifc',
      export: () => apexExportIfc(),
    });
  },
};
