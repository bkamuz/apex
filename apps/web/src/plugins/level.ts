import { createLevelTool } from '../tools/levelTool';
import type { Plugin } from './types';

export const levelPlugin: Plugin = {
  id: 'apex.level',
  descriptor: { purpose: 'Level (storey) tool.' },
  install(host) {
    host.registerTool(createLevelTool());
  },
};
