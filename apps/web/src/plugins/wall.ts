import { createPlacementTool } from '../tools/placementTool';
import type { Plugin } from './types';

/**
 * One Wall tool. Line, arc and polyline are draw modes; the section is a
 * profile parameter. There is no second "Arc wall" plugin.
 */
export const wallPlugin: Plugin = {
  id: 'apex.wall',
  install(host) {
    const definition = host.component('apex.wall');
    if (!definition) return;
    host.registerTool(
      createPlacementTool(definition, {
        modes: [
          { id: 'line', label: 'Line', placement: 'two_point' },
          { id: 'arc', label: 'Arc', placement: 'three_point_arc' },
          { id: 'polyline', label: 'Polyline', placement: 'polyline' },
        ],
      }),
    );
  },
};
