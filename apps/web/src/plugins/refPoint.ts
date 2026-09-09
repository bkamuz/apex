import { createReferenceTool } from '../tools/referenceTool';
import type { Plugin } from './types';

export const refPointPlugin: Plugin = {
  id: 'apex.ref_point',
  install(host) {
    host.registerTool(createReferenceTool('point', 'Ref point'));
  },
};
