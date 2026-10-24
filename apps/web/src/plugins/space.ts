import { createSpaceTool } from '../tools/spaceTool';
import type { Plugin } from './types';

export const spacePlugin: Plugin = {
  id: 'apex.space',
  install(host) {
    host.registerTool(createSpaceTool());
  },
};
