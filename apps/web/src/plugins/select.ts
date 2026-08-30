import { createSelectTool } from '../tools/selectTool';
import type { Plugin } from './types';

export const selectPlugin: Plugin = {
  id: 'apex.select',
  install(host) {
    host.registerTool(createSelectTool());
  },
};
