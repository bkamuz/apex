import { apexListComponents, apexRegisterComponent } from '../wasm/apex';
import { createPlacementTool } from '../tools/placementTool';
import type { Tool } from '../tools/Tool';

type Listener = () => void;

/**
 * Runtime extension surface for modules.
 *
 * A module is a plugin: it installs a component (data the core validates) and
 * a default placement tool. `registerTool` is for a genuinely new gesture.
 */
class ExtensionHost {
  private listeners = new Set<Listener>();
  private tools: Tool[] = [];

  /** Install a component and give it a placement tool, like a first-party plugin. */
  defineComponent(definition: unknown): void {
    apexRegisterComponent(definition);
    const id = componentIdOf(definition);
    const installed = id
      ? apexListComponents().find((component) => component.id === id)
      : undefined;
    if (installed) {
      this.registerTool(createPlacementTool(installed));
      return;
    }
    this.emit();
  }

  /** Add a tool with a gesture the generated placement tools cannot express. */
  registerTool(tool: Tool): void {
    this.tools = [...this.tools.filter((t) => t.id !== tool.id), tool];
    this.emit();
  }

  customTools(): Tool[] {
    return this.tools;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

function componentIdOf(definition: unknown): string | null {
  if (!definition || typeof definition !== 'object' || !('id' in definition)) return null;
  const id = (definition as { id: unknown }).id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

export const extensions = new ExtensionHost();

export interface ApexGlobal {
  defineComponent(definition: unknown): void;
  registerTool(tool: Tool): void;
}

declare global {
  interface Window {
    apex?: ApexGlobal;
  }
}

/** Expose the SDK so a module (or the console) can extend a running app. */
export function installGlobalSdk(): void {
  window.apex = {
    defineComponent: (definition) => extensions.defineComponent(definition),
    registerTool: (tool) => extensions.registerTool(tool),
  };
}
