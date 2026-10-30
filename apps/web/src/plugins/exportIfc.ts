import { apexExportIfc } from '../wasm/apex';
import { importIfcWithIfcLite } from './ifcLiteImport';
import type { Plugin } from './types';

/** First-party IFC4 export + import — registered through PluginHost, not App branches. */
export const exportIfcPlugin: Plugin = {
  id: 'apex.export.ifc',
  descriptor: {
    purpose:
      'IFC4 export and IFC-Lite–backed Open (Rust+WASM tessellation with CSG openings).',
  },
  install(host) {
    host.registerExporter({
      id: 'apex.ifc',
      descriptor: { purpose: 'IFC4 STEP file of every element, level and space.' },
      label: 'IFC',
      title: 'Export building model as IFC4 (.ifc)',
      filename: 'apex-export.ifc',
      export: () => apexExportIfc(),
    });
    host.registerImporter({
      id: 'apex.ifc',
      descriptor: {
        purpose:
          'Open an IFC STEP file via IFC-Lite (CSG openings, IfcOpenShell-verified meshes) into apex.ifc.mesh instances; storeys become levels.',
      },
      label: 'IFC',
      title: 'Open IFC4 / IFC2x3 (.ifc)',
      extensions: ['.ifc'],
      accept: '.ifc,application/x-step,model/step',
      import: (text) => importIfcWithIfcLite(text),
    });
  },
};
