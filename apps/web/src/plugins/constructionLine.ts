import { createConstructionLineTool } from '../tools/constructionLineTool';
import type { Plugin } from './types';

export const constructionLinePlugin: Plugin = {
  id: 'apex.construction_line',
  install(host) {
    host.registerTool(createConstructionLineTool());
  },
};
