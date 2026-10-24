import { apexListComponents, apexRegisterComponent } from '../wasm/apex';
import { createPlacementTool } from '../tools/placementTool';
import { ApexTabs, TOOL_TABS } from '../tools/tabs';
import type { Tool } from '../tools/Tool';
import type { Exporter } from '../plugins/types';

/** Re-export the tool surface third-party modules implement. */
export type { Tool, ToolContext, ToolGroup, ToolMode, ToolTab, ResolvedToolTab } from '../tools/Tool';
export type { TransformOriginal, TransformMode } from '../tools/transformTypes';
export type { Exporter } from '../plugins/types';
export { ApexTabs, TOOL_TABS, catalogTabById, resolveToolTab } from '../tools/tabs';

type Listener = () => void;

/**
 * Runtime extension surface for modules.
 *
 * A module is a plugin: it installs a component (data the core validates) and
 * a default placement tool. `registerTool` / `registerExporter` are for
 * gestures and formats the generated helpers cannot express.
 */
class ExtensionHost {
  private listeners = new Set<Listener>();
  private tools: Tool[] = [];
  private exporters: Exporter[] = [];

  /** Install a component and give it a placement tool, like a first-party plugin. */
  defineComponent(definition: unknown): void {
    apexRegisterComponent(definition);
    const id = componentIdOf(definition);
    const installed = id
      ? apexListComponents().find((component) => component.id === id)
      : undefined;
    if (installed) {
      // Prefer catalog tab; override via registerTool for a custom tab.
      this.registerTool(createPlacementTool(installed, { tab: ApexTabs.building }));
      return;
    }
    this.emit();
  }

  /** Add a tool with a gesture the generated placement tools cannot express. */
  registerTool(tool: Tool): void {
    this.tools = [...this.tools.filter((t) => t.id !== tool.id), tool];
    this.emit();
  }

  registerExporter(exporter: Exporter): void {
    this.exporters = [
      ...this.exporters.filter((item) => item.id !== exporter.id),
      exporter,
    ];
    this.emit();
  }

  customTools(): Tool[] {
    return this.tools;
  }

  customExporters(): Exporter[] {
    return this.exporters;
  }

  /** Tell the app to re-sync the component catalog after a host.registerComponent. */
  notifyCatalogChanged(): void {
    this.emit();
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
  registerExporter(exporter: Exporter): void;
  /** Known toolbar tabs — prefer these; a custom `{ id, label }` still creates a new tab. */
  tabs: typeof TOOL_TABS;
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
    registerExporter: (exporter) => extensions.registerExporter(exporter),
    tabs: TOOL_TABS,
  };
}
