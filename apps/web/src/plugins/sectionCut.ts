import { createSectionCutTool } from '../tools/sectionCutTool';
import type { Plugin } from './types';

export const sectionCutPlugin: Plugin = {
  id: 'apex.section_cut',
  descriptor: { purpose: 'Section cut tool.' },
  install(host) {
    host.registerTool(createSectionCutTool());
  },
};
