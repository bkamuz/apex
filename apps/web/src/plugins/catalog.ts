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
import { projectJsonPlugin } from './projectJson';
import { refPlanePlugin } from './refPlane';
import { refPointPlugin } from './refPoint';
import { sectionCutPlugin } from './sectionCut';
import { selectPlugin } from './select';
import { annotatePlugin } from './annotate';
import { dxfUnderlayPlugin } from './dxfUnderlay';
import { spacePlugin } from './space';
import { wallPlugin } from './wall';
import type { Plugin, SystemPack } from './types';

/**
 * Always-on chrome — not toggleable in Settings.
 * Select / transform / parent / project JSON Open+Save.
 */
export const alwaysOnPlugins: readonly Plugin[] = [
  selectPlugin,
  movePlugin,
  copyPlugin,
  parentPlugin,
  projectJsonPlugin,
];

/**
 * First-party system packs. Order matches toolbar tab discovery
 * (Basics → Building → Engineering → Spaces) then annotate / IFC.
 *
 * Toggle via Settings; defaults recreate today's full toolbar.
 * Add a pack here — do not branch on component ids in App.tsx.
 */
export const systemPacks: readonly SystemPack[] = [
  {
    id: 'apex.pack.basics',
    labelKey: 'settings.pack.basics',
    descriptionKey: 'settings.pack.basics.desc',
    defaultEnabled: true,
    plugins: [
      // Basics tab tools first so `apex.basics` appears before building constructions.
      // Ref point is the only point tool (no second “point” type).
      levelPlugin,
      refPointPlugin,
      refPlanePlugin,
      constructionLinePlugin,
      gridAxisPlugin,
      sectionCutPlugin,
    ],
  },
  {
    id: 'apex.pack.building',
    labelKey: 'settings.pack.building',
    descriptionKey: 'settings.pack.building.desc',
    defaultEnabled: true,
    plugins: [
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
    ],
  },
  {
    id: 'apex.pack.engineering',
    labelKey: 'settings.pack.engineering',
    descriptionKey: 'settings.pack.engineering.desc',
    defaultEnabled: true,
    plugins: [
      componentPlugin('apex.pipe', { tab: ApexTabs.engineering }),
      componentPlugin('apex.duct', { tab: ApexTabs.engineering }),
      componentPlugin('apex.cable_tray', { tab: ApexTabs.engineering }),
    ],
  },
  {
    id: 'apex.pack.spaces',
    labelKey: 'settings.pack.spaces',
    descriptionKey: 'settings.pack.spaces.desc',
    defaultEnabled: true,
    plugins: [spacePlugin],
  },
  {
    id: 'apex.pack.site',
    labelKey: 'settings.pack.site',
    descriptionKey: 'settings.pack.site.desc',
    defaultEnabled: true,
    // Fence / gate / surfaces land in follow-up PRs; DXF underlay ships first.
    plugins: [dxfUnderlayPlugin],
  },
  {
    id: 'apex.pack.annotate',
    labelKey: 'settings.pack.annotate',
    descriptionKey: 'settings.pack.annotate.desc',
    defaultEnabled: true,
    plugins: [annotatePlugin],
  },
  {
    id: 'apex.pack.ifc',
    labelKey: 'settings.pack.ifc',
    descriptionKey: 'settings.pack.ifc.desc',
    defaultEnabled: true,
    plugins: [exportIfcPlugin],
  },
];

/**
 * Flat list of every first-party plugin (always-on + all packs).
 * Prefer `alwaysOnPlugins` + `systemPacks` when installing or documenting packs.
 */
export const firstPartyPlugins: Plugin[] = [
  ...alwaysOnPlugins,
  ...systemPacks.flatMap((pack) => [...pack.plugins]),
];
