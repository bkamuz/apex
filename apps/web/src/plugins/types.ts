import type { ComponentDto } from '../types';
import type { Tool } from '../tools/Tool';

/** Services a plugin uses to install itself. */
export interface PluginHost {
  component(id: string): ComponentDto | undefined;
  registerTool(tool: Tool): void;
}

/**
 * A first-party or user module that contributes tools.
 *
 * One plugin = one toolbar tool. A plugin may look up a component the core
 * already knows, or a user module may register a component and then a tool.
 */
export interface Plugin {
  readonly id: string;
  install(host: PluginHost): void;
}
