import { apexImportProject } from '../wasm/apex';
import type { Plugin } from './types';

/**
 * Apex PROJECT_FORMAT JSON Open — registered through PluginHost so Open routes
 * `.json` via the importer registry (same path as IFC), not an App.tsx branch.
 *
 * Save / Save As stay document chrome (not exporters): they write the live
 * snapshot and mark the document clean.
 */
export const projectJsonPlugin: Plugin = {
  id: 'apex.project.json',
  descriptor: {
    purpose: 'Open Apex PROJECT_FORMAT JSON snapshots via the importer registry.',
  },
  install(host) {
    host.registerImporter({
      id: 'apex.project',
      descriptor: {
        purpose: 'Replace the live project from an Apex JSON snapshot (PROJECT_FORMAT).',
      },
      label: 'Apex project',
      title: 'Open Apex project (.json)',
      extensions: ['.json'],
      accept: '.json,application/json',
      import: (text) => apexImportProject(text),
    });
  },
};
