import { componentPlugin } from './componentPlugin';
import { copyPlugin } from './copy';
import { exportIfcPlugin } from './exportIfc';
import { gridAxisPlugin } from './gridAxis';
import { hostedComponentPlugin } from './hostedComponentPlugin';
import { movePlugin } from './move';
import { parentPlugin } from './parent';
import { refPlanePlugin } from './refPlane';
import { refPointPlugin } from './refPoint';
import { selectPlugin } from './select';
import { wallPlugin } from './wall';
import type { Plugin } from './types';

/**
 * Shipped tools, each its own plugin.
 *
 * Wall and Column are one plugin each: draw mode (line / arc / polyline) and
 * profile (rectangle / round) are switches on the tool, not extra buttons.
 * Openings use a hosted placement gesture; MEP routes reuse path placement.
 */
export const firstPartyPlugins: Plugin[] = [
  selectPlugin,
  movePlugin,
  copyPlugin,
  parentPlugin,
  wallPlugin,
  componentPlugin('apex.column'),
  componentPlugin('apex.beam'),
  componentPlugin('apex.slab'),
  hostedComponentPlugin('apex.door'),
  hostedComponentPlugin('apex.window'),
  hostedComponentPlugin('apex.slab_opening'),
  componentPlugin('apex.stair'),
  componentPlugin('apex.roof'),
  componentPlugin('apex.roof.pitched'),
  componentPlugin('apex.pipe'),
  componentPlugin('apex.duct'),
  componentPlugin('apex.cable_tray'),
  refPointPlugin,
  refPlanePlugin,
  gridAxisPlugin,
  exportIfcPlugin,
];
