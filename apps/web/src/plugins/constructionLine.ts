import { createConstructionLineTool } from '../tools/constructionLineTool';
import type { Plugin } from './types';

export const constructionLinePlugin: Plugin = {
  id: 'apex.construction_line',
  descriptor: { purpose: 'Construction line tool.' },
  install(host) {
    host.registerTool(createConstructionLineTool());
  },
};
