import { createTransformTool } from '../tools/transformTool';
import type { Plugin } from './types';

export const copyPlugin: Plugin = {
  id: 'apex.copy',
  descriptor: { purpose: 'Copy tool.' },
  install(host) {
    host.registerTool(createTransformTool('copy'));
  },
};
