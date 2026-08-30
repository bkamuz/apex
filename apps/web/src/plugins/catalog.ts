import { componentPlugin } from './componentPlugin';
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
  wallPlugin,
  componentPlugin('apex.column'),
  componentPlugin('apex.beam'),
];
