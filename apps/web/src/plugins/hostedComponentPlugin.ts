import { createHostedPlacementTool } from '../tools/hostedPlacementTool';
import type { ToolTab } from '../tools/Tool';
import { ApexTabs } from '../tools/tabs';
import type { Plugin } from './types';

/** Create-tool plugin for openings that cut a void in a picked host. */
export function hostedComponentPlugin(
  componentId: string,
  options: { tab?: ToolTab } = {},
): Plugin {
  const tab = options.tab ?? ApexTabs.building;
  return {
    id: componentId,
    descriptor: { purpose: `Hosted placement tool for ${componentId} (cuts its host).` },
    install(host) {
      const definition = host.component(componentId);
      if (!definition) return;
      host.registerTool(createHostedPlacementTool(definition, tab));
    },
  };
}
