import { createTransformTool } from '../tools/transformTool';
import type { Plugin } from './types';

export const movePlugin: Plugin = {
  id: 'apex.move',
  install(host) {
    host.registerTool(createTransformTool('move'));
  },
};
