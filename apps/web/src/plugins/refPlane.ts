import { createReferenceTool } from '../tools/referenceTool';
import type { Plugin } from './types';

export const refPlanePlugin: Plugin = {
  id: 'apex.ref_plane',
  descriptor: { purpose: 'Reference plane tool.' },
  install(host) {
    host.registerTool(createReferenceTool('plane', 'Ref plane'));
  },
};
