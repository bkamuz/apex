import { componentPlugin } from './componentPlugin';
import { copyPlugin } from './copy';
import { gridAxisPlugin } from './gridAxis';
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
  refPointPlugin,
  refPlanePlugin,
  gridAxisPlugin,
];
