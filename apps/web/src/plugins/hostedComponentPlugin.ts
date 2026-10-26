import { createHostedPlacementTool } from '../tools/hostedPlacementTool';
import type { Plugin } from './types';

/** Create-tool plugin for openings that cut a void in a picked host. */
export function hostedComponentPlugin(componentId: string): Plugin {
  return {
    id: componentId,
    descriptor: { purpose: `Hosted placement tool for ${componentId} (cuts its host).` },
    install(host) {
      const definition = host.component(componentId);
      if (!definition) return;
      host.registerTool(createHostedPlacementTool(definition));
    },
  };
}
