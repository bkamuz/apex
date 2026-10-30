import { assertDescribed } from '../descriptor';
export type { Descriptor, DescriptorExample } from '../descriptor';
import {
  apexListComponents,
  apexRegisterComponent,
  apexRegisterOpeningGenerator,
  type OpeningGeneratorFn,
} from '../wasm/apex';
import type { Descriptor } from '../descriptor';
import {
  getLocale,
  hasMessage,
  LOCALES,
  setLocale,
  t,
  type Locale,
} from '../i18n';
import { TOOL_ICONS } from '../tools/icons';
import { createPlacementTool } from '../tools/placementTool';
import { ApexTabs, TOOL_TABS } from '../tools/tabs';
import type { Tool } from '../tools/Tool';
import type { Exporter, Importer } from '../plugins/types';
import { annotationKinds } from '../annotations/registry';
import type { AnnotationKindRegistration } from '../annotations/types';

/** Re-export the tool surface third-party modules implement. */
export type { Tool, ToolContext, ToolGroup, ToolMode, ToolTab, ResolvedToolTab } from '../tools/Tool';
export type { ToolIcon, ToolIconName } from '../tools/icons';
export type { TransformOriginal, TransformMode } from '../tools/transformTypes';
export type { Exporter, Importer } from '../plugins/types';
export type { OpeningGeneratorFn, OpeningGeometryDto, OpeningPartDto } from '../wasm/apex';
export type { AnnotationKindRegistration, AnnotationKindId } from '../annotations/types';
export { ApexTabs, TOOL_TABS, catalogTabById, resolveToolTab } from '../tools/tabs';
export { ApexIcons, TOOL_ICONS, catalogIconByName, resolveToolIconSvg } from '../tools/icons';

type Listener = () => void;

/**
 * Runtime extension surface for modules.
 *
 * A module is a plugin: it installs a component (data the core validates) and
 * a default placement tool. `registerTool` / `registerExporter` / `registerImporter`
 * are for gestures and formats the generated helpers cannot express.
 */
class ExtensionHost {
  private listeners = new Set<Listener>();
  private tools: Tool[] = [];
  private exporters: Exporter[] = [];
  private importers: Importer[] = [];

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

  /**
   * Register a geometry generator for opening genera (doors, windows,
   * plugin openings). A genus uses it via `opening.generator: id`; the core
   * still owns types, hosting, the wall void and plan symbols.
   */
  registerOpeningGenerator(registration: OpeningGeneratorRegistration): void {
    assertDescribed('opening generator', registration.id, registration);
    apexRegisterOpeningGenerator(registration.id, registration.descriptor, registration.generate);
    this.emit();
  }

  /** Add a tool with a gesture the generated placement tools cannot express. */
  registerTool(tool: Tool): void {
    assertDescribed('tool', tool.id, tool);
    this.tools = [...this.tools.filter((t) => t.id !== tool.id), tool];
    this.emit();
  }

  registerExporter(exporter: Exporter): void {
    assertDescribed('exporter', exporter.id, exporter);
    this.exporters = [
      ...this.exporters.filter((item) => item.id !== exporter.id),
      exporter,
    ];
    this.emit();
  }

  registerImporter(importer: Importer): void {
    assertDescribed('importer', importer.id, importer);
    this.importers = [
      ...this.importers.filter((item) => item.id !== importer.id),
      importer,
    ];
    this.emit();
  }

  /** Register a view-annotation kind (tools + optional hit-test / serialize hooks). */
  registerAnnotationKind(registration: AnnotationKindRegistration): void {
    annotationKinds.register(registration);
    for (const tool of registration.tools) {
      this.registerTool(tool);
    }
    this.emit();
  }

  customTools(): Tool[] {
    return this.tools;
  }

  customExporters(): Exporter[] {
    return this.exporters;
  }

  customImporters(): Importer[] {
    return this.importers;
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

/** A plugin geometry generator for opening genera. */
export interface OpeningGeneratorRegistration {
  readonly id: string;
  /** Required. What the generator builds. See docs/descriptors.md. */
  readonly descriptor: Descriptor;
  /** Resolved genus params (metres) + host wall depth → solids. Must be deterministic. */
  readonly generate: OpeningGeneratorFn;
}

/** Runtime i18n surface for plugins (see docs/i18n.md). */
export interface ApexI18n {
  t: typeof t;
  getLocale: typeof getLocale;
  setLocale: typeof setLocale;
  hasMessage: typeof hasMessage;
  locales: readonly Locale[];
}

export interface ApexGlobal {
  defineComponent(definition: unknown): void;
  registerTool(tool: Tool): void;
  registerExporter(exporter: Exporter): void;
  registerImporter(importer: Importer): void;
  registerAnnotationKind(registration: AnnotationKindRegistration): void;
  registerOpeningGenerator(registration: OpeningGeneratorRegistration): void;
  /** Known toolbar tabs — prefer these; a custom `{ id, label }` still creates a new tab. */
  tabs: typeof TOOL_TABS;
  /** Known toolbar icon names — prefer these; omit icon or use `{ svg }` for custom. */
  icons: typeof TOOL_ICONS;
  /** Translate UI strings; prefer message keys over hard-coded English. */
  i18n: ApexI18n;
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
    registerImporter: (importer) => extensions.registerImporter(importer),
    registerAnnotationKind: (registration) => extensions.registerAnnotationKind(registration),
    registerOpeningGenerator: (registration) => extensions.registerOpeningGenerator(registration),
    tabs: TOOL_TABS,
    icons: TOOL_ICONS,
    i18n: {
      t,
      getLocale,
      setLocale,
      hasMessage,
      locales: LOCALES,
    },
  };
}
