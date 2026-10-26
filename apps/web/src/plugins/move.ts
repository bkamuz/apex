import { createTransformTool } from '../tools/transformTool';
import type { Plugin } from './types';

export const movePlugin: Plugin = {
  id: 'apex.move',
  descriptor: { purpose: 'Move tool.' },
  install(host) {
    host.registerTool(createTransformTool('move'));
  },
};
