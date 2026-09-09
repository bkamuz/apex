import { createReferenceTool } from '../tools/referenceTool';
import type { Plugin } from './types';

export const refPlanePlugin: Plugin = {
  id: 'apex.ref_plane',
  install(host) {
    host.registerTool(createReferenceTool('plane', 'Ref plane'));
  },
};
