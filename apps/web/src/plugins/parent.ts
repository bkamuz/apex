import { createDetachTool, createParentTool } from '../tools/parentTool';
import type { Plugin } from './types';

/**
 * Parent and Detach.
 *
 * One plugin, two tools: both act on the element-parent relation, and the
 * relation is not specific to any component type. Walls, beams and slabs are
 * the common host, but nothing is special-cased — any element can parent any
 * other, and a child can itself be a parent.
 */
export const parentPlugin: Plugin = {
  id: 'apex.parent',
  install(host) {
    host.registerTool(createParentTool());
    host.registerTool(createDetachTool());
  },
};
