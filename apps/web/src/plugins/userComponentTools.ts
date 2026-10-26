import type { ComponentDto } from '../types';
import { createPlacementTool } from '../tools/placementTool';
import { createHostedPlacementTool } from '../tools/hostedPlacementTool';
import { ApexTabs } from '../tools/tabs';
import type { ToolTab } from '../tools/Tool';
import type { ToolRegistry } from '../tools/registry';
import { toolIdForComponent } from '../tools/Tool';

const ENGINEERING_CATEGORIES = new Set(['pipe', 'duct', 'cable', 'mep']);

export function tabForUserComponent(component: ComponentDto): ToolTab {
  const category = component.category.toLowerCase();
  if (ENGINEERING_CATEGORIES.has(category)) return ApexTabs.engineering;
  return ApexTabs.building;
}

/** Placement tools for user-authored components (visual / module), not first-party plugins. */
export function registerUserComponentTools(
  registry: ToolRegistry,
  components: ComponentDto[],
): void {
  for (const component of components) {
    if (component.source === 'built_in') continue;
    const toolId = toolIdForComponent(component);
    if (registry.get(toolId)) continue;
    // Genera placed into a host (host placement → host_cut) pick a host like windows do.
    registry.register(
      component.host_cut
        ? createHostedPlacementTool(component)
        : createPlacementTool(component, { tab: tabForUserComponent(component) }),
    );
  }
}
