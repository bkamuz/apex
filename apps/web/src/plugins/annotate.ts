import { installBuiltinAnnotationKinds } from '../annotations/installBuiltins';
import { annotationKinds } from '../annotations/registry';
import type { Plugin } from './types';

export const annotatePlugin: Plugin = {
  id: 'apex.annotate',
  install(host) {
    installBuiltinAnnotationKinds();
    for (const reg of annotationKinds.all()) {
      for (const tool of reg.tools) {
        host.registerTool(tool);
      }
    }
  },
};
