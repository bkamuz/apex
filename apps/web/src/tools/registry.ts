import type { Tool } from './Tool';
import { SELECT_TOOL_ID } from './selectTool';

/**
 * Holds the tools the toolbar offers.
 *
 * Tools come from plugins, not from a 1:1 walk of the component list. A
 * component variant (round vs rectangular column) must not become a second
 * button; a plugin decides what it contributes.
 */
export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.id, tool);
  }

  reset(): void {
    this.tools.clear();
  }

  get(id: string): Tool | undefined {
    return this.tools.get(id);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  static readonly selectId = SELECT_TOOL_ID;
}
