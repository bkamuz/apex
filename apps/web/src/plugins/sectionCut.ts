import { createSectionCutTool } from '../tools/sectionCutTool';
import type { Plugin } from './types';

export const sectionCutPlugin: Plugin = {
  id: 'apex.section_cut',
  install(host) {
    host.registerTool(createSectionCutTool());
  },
};
