import { createGridAxisTool } from '../tools/gridAxisTool';
import type { Plugin } from './types';

export const gridAxisPlugin: Plugin = {
  id: 'apex.grid_axis',
  descriptor: { purpose: 'Structural grid axis tool.' },
  install(host) {
    host.registerTool(createGridAxisTool());
  },
};
