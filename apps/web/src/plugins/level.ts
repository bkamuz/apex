import { createLevelTool } from '../tools/levelTool';
import type { Plugin } from './types';

export const levelPlugin: Plugin = {
  id: 'apex.level',
  install(host) {
    host.registerTool(createLevelTool());
  },
};
