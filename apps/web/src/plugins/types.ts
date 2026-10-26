import type { Descriptor } from '../descriptor';
import type { ComponentDto } from '../types';
import type { Tool } from '../tools/Tool';

/** A downloadable project export contributed by a plugin. */
export interface Exporter {
  readonly id: string;
  readonly label: string;
  /** Required. What the export produces. */
  readonly descriptor: Descriptor;
  /** Optional native tooltip on the export button in the doc bar. */
  readonly title?: string;
  /** File name suggestion, e.g. `project.ifc`. */
  readonly filename: string;
  /** Produce file contents. May throw; the shell surfaces the message. */
  export(): string;
}

/** Services a plugin uses to install itself. */
export interface PluginHost {
  component(id: string): ComponentDto | undefined;
  registerTool(tool: Tool): void;
  /** Register (or replace) a component definition in the live WASM project. */
  registerComponent(definition: unknown): void;
  /** Contribute a file exporter shown next to Save. */
  registerExporter(exporter: Exporter): void;
}

/**
 * A first-party or user module that contributes tools / types / exporters.
 *
 * One create plugin usually equals one toolbar tool. Domain packs may register
 * several tools plus an exporter from a single `install`.
 */
export interface Plugin {
  readonly id: string;
  /** Required. What the plugin contributes. See docs/descriptors.md. */
  readonly descriptor: Descriptor;
  install(host: PluginHost): void;
}
