import { apexRegisterComponent } from '../wasm/apex';
import type { Tool } from '../tools/Tool';

type Listener = () => void;

/**
 * Runtime extension surface for modules.
 *
 * A module contributes data (a component definition, which the core validates
 * and stores) or, more rarely, a genuinely new input gesture. Everything a
 * module can do here is something the visual editor will do too, which is why
 * a visually built component and a module-shipped one are the same thing.
 */
class ExtensionHost {
  private listeners = new Set<Listener>();
  private tools: Tool[] = [];

  /** Install a component. Throws if the core rejects the definition. */
  defineComponent(definition: unknown): void {
    apexRegisterComponent(definition);
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
