import { componentPlugin } from './componentPlugin';
import { selectPlugin } from './select';
import type { Plugin } from './types';

/**
 * Shipped tools, each its own plugin.
 *
 * Column is one plugin: rectangle vs round is a profile parameter, not a
 * second tool. Arc wall is a separate plugin because the gesture is different.
 */
export const firstPartyPlugins: Plugin[] = [
  selectPlugin,
  componentPlugin('apex.wall'),
  componentPlugin('apex.arc_wall'),
  componentPlugin('apex.column'),
  componentPlugin('apex.beam'),
];
