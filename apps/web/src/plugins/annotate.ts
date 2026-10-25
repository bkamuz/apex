import { createDimensionTool } from '../tools/dimensionTool';
import { createTextNoteTool } from '../tools/textNoteTool';
import type { Plugin } from './types';

export const annotatePlugin: Plugin = {
  id: 'apex.annotate',
  install(host) {
    host.registerTool(createDimensionTool());
    host.registerTool(createTextNoteTool());
  },
};
