import { ApexTabs } from '../tools/tabs';
import { componentPlugin } from './componentPlugin';
import { constructionLinePlugin } from './constructionLine';
import { copyPlugin } from './copy';
import { exportIfcPlugin } from './exportIfc';
import { gridAxisPlugin } from './gridAxis';
import { hostedComponentPlugin } from './hostedComponentPlugin';
import { levelPlugin } from './level';
import { movePlugin } from './move';
import { parentPlugin } from './parent';
import { refPlanePlugin } from './refPlane';
import { refPointPlugin } from './refPoint';
import { sectionCutPlugin } from './sectionCut';
import { selectPlugin } from './select';
import { annotatePlugin } from './annotate';
import { spacePlugin } from './space';
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
  // Basics tab tools first so `apex.basics` appears before building constructions.
  // Ref point is the only point tool (no second “point” type).
  levelPlugin,
  refPointPlugin,
  refPlanePlugin,
  constructionLinePlugin,
  gridAxisPlugin,
  sectionCutPlugin,
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
  // Engineering tab (after Building so tab chips stay Basics → Building → Engineering).
  componentPlugin('apex.pipe', { tab: ApexTabs.engineering }),
  componentPlugin('apex.duct', { tab: ApexTabs.engineering }),
  componentPlugin('apex.cable_tray', { tab: ApexTabs.engineering }),
  // Spaces tab (after Engineering).
  spacePlugin,
  annotatePlugin,
  exportIfcPlugin,
];
