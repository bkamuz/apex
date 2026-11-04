import { apexLinkDxfUnderlay } from '../wasm/apex';
import type { Plugin } from './types';

/**
 * DXF linked underlay — additive plan reference (Site pack).
 *
 * Never registered as an Open `Importer` (those replace the live project).
 */
export const dxfUnderlayPlugin: Plugin = {
  id: 'apex.dxf_underlay',
  descriptor: {
    purpose:
      'Link DXF R12 ASCII as a non-editable plan underlay (overlay reference, not explode-to-walls).',
  },
  install(host) {
    host.registerUnderlayLinker({
      id: 'apex.dxf',
      descriptor: {
        purpose:
          'Parse DXF R12 ASCII LINE / LWPOLYLINE / POLYLINE / CIRCLE / ARC into a linked plan underlay.',
      },
      label: 'DXF underlay',
      title: 'Link DXF as plan underlay (.dxf)',
      extensions: ['.dxf'],
      accept: '.dxf,application/dxf,image/vnd.dxf',
      link: (text, fileName) => apexLinkDxfUnderlay(text, fileName),
    });
  },
};
