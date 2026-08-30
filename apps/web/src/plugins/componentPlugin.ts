import { createPlacementTool } from '../tools/placementTool';
import type { Plugin } from './types';

/** A create-tool plugin that places one already-registered component. */
export function componentPlugin(componentId: string): Plugin {
  return {
    id: componentId,
    install(host) {
      const definition = host.component(componentId);
      if (!definition) return;
      host.registerTool(createPlacementTool(definition));
    },
  };
}
