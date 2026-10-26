import { apexExportIfc } from '../wasm/apex';
import type { Plugin } from './types';

/** First-party IFC4 exporter — registered through PluginHost, not App branches. */
export const exportIfcPlugin: Plugin = {
  id: 'apex.export.ifc',
  descriptor: { purpose: 'IFC4 export of the whole project.' },
  install(host) {
    host.registerExporter({
      id: 'apex.ifc',
      descriptor: { purpose: 'IFC4 STEP file of every element, level and space.' },
    label: 'IFC',
      title: 'Export building model as IFC4 (.ifc)',
      filename: 'apex-export.ifc',
      export: () => apexExportIfc(),
    });
  },
};
