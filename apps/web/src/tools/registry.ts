import type { ComponentDto } from '../types';
import { createPlacementTool } from './placementTool';
import { createSelectTool, SELECT_TOOL_ID } from './selectTool';
import type { Tool } from './Tool';

/**
 * Holds the tools the toolbar offers.
 *
 * Placement tools are generated from the installed components, so registering
 * a component is all it takes to get a working tool. `register` exists for the
 * rarer case where a module needs a genuinely new gesture.
 */
export class ToolRegistry {
  private tools = new Map<string, Tool>();

  constructor() {
    this.register(createSelectTool());
  }

  register(tool: Tool): void {
    this.tools.set(tool.id, tool);
  }

  get(id: string): Tool | undefined {
    return this.tools.get(id);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  /** Rebuild the generated placement tools from the current component list. */
  syncComponents(components: ComponentDto[]): void {
    for (const tool of this.tools.values()) {
      if (tool.componentId) this.tools.delete(tool.id);
    }
    for (const component of components) {
      this.register(createPlacementTool(component));
    }
  }

  static readonly selectId = SELECT_TOOL_ID;
}
