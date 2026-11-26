import { describeFromComponent } from '../descriptor';
import { CATALOGS } from '../i18n/catalogs';
import { t } from '../i18n/t';
import type { ComponentDto } from '../types';
import { componentIcon, catalogIconByName, TOOL_ICONS, type ToolIcon } from './icons';
import { createHostedPlacementTool } from './hostedPlacementTool';
import { createPlacementTool } from './placementTool';
import type { ToolRegistry } from './registry';
import {
  categoryPlaceLabel,
  categoryPlaceLabelBoth,
  placementStyle,
  readSlotSelection,
  ribbonSlots,
  tabForCategory,
  writeSlotSelection,
  type RibbonSlot,
} from './categorySlots';
import type { Tool, ToolMode, ToolTab } from './Tool';

/**
 * One live category tool. The ribbon id stays stable (`place:apex.window`);
 * the genus it places changes with the type selector.
 */
class CategoryRuntime {
  readonly slot: RibbonSlot<ComponentDto>;
  readonly genera: ComponentDto[];
  genusId: string;
  speciesId: string | null;
  private inner: Tool;
  private readonly tab: ToolTab;
  private readonly modeGenusId?: string;
  private readonly modeList?: readonly ToolMode[];

  constructor(slot: RibbonSlot<ComponentDto>, prior: Tool | undefined) {
    this.slot = slot;
    this.genera = slot.genera;
    const selection = readSlotSelection(slot);
    this.genusId = selection.genusId;
    this.speciesId = selection.speciesId;
    this.tab = prior?.tab ?? tabForCategory(slot.category);
    this.modeGenusId = prior?.componentId;
    this.modeList = prior?.modes;
    this.inner = this.build(this.genus(this.genusId));
  }

  owns(id: string): boolean {
    return this.genera.some((item) => item.id === id);
  }

  genus(id: string): ComponentDto {
    return this.genera.find((item) => item.id === id) ?? this.genera[0]!;
  }

  setPlacementTarget(genusId: string, speciesId: string | null): void {
    const genus = this.genera.find((item) => item.id === genusId);
    if (!genus) return;
    const nextSpecies = speciesId ?? genus.default_species ?? null;
    if (genus.id === this.genusId && nextSpecies === this.speciesId) return;
    const genusChanged = genus.id !== this.genusId;
    this.genusId = genus.id;
    this.speciesId = nextSpecies;
    if (genusChanged) this.inner = this.build(genus);
    writeSlotSelection(this.slot.key, this.genusId, this.speciesId);
    notifyCategoryPlacement();
  }

  label(): string {
    if (this.slot.labelComponentId) {
      const genus = this.genus(this.slot.labelComponentId);
      return t(`component.${this.slot.labelComponentId}`, undefined, genus.display_name);
    }
    return categoryPlaceLabel(this.slot.category);
  }

  dispatch(
    method: 'onClick' | 'onPointerMove',
    event: Parameters<NonNullable<Tool['onClick']>>[0],
    ctx: Parameters<NonNullable<Tool['onClick']>>[1],
  ): void {
    this.inner[method]?.(event, ctx);
  }

  private build(genus: ComponentDto): Tool {
    if (placementStyle(genus) === 'hosted') return createHostedPlacementTool(genus, this.tab);
    if (genus.id === this.modeGenusId && this.modeList && this.modeList.length > 0) {
      return createPlacementTool(genus, { tab: this.tab, modes: [...this.modeList] });
    }
    return createPlacementTool(genus, { tab: this.tab });
  }

  makeTool(prior: Tool | undefined): Tool {
    const self = this;
    const primary = this.genus(this.slot.primaryGenusId);
    const hasChoice = this.genera.length > 1 || this.genera.some((item) => item.default_species);
    return {
      id: this.slot.toolId,
      label: prior?.label ?? categoryPlaceLabel(this.slot.category, primary.display_name),
      descriptor:
        prior?.descriptor ?? {
          purpose: `Place a genus in the ${this.slot.category} category. One ribbon button covers every genus of this category.`,
        },
      group: 'create',
      tab: this.tab,
      icon: prior?.icon ?? iconForSlot(this.slot, primary),
      shortcut: prior?.shortcut,
      hasCategoryChoice: hasChoice,
      get componentId() {
        return self.genusId;
      },
      get modes() {
        return self.inner.modes;
      },
      categoryGenera: () => self.genera,
      placementSpeciesId: () => self.speciesId,
      setPlacementTarget: (genusId, speciesId) => self.setPlacementTarget(genusId, speciesId),
      get getMode() {
        return self.inner.getMode ? () => self.inner.getMode?.() ?? '' : undefined;
      },
      setMode: (id) => self.inner.setMode?.(id),
      placementKind: () => self.inner.placementKind?.() ?? self.genus(self.genusId).placement,
      hint: (pending) => self.inner.hint(pending),
      onClick: (event, ctx) => self.inner.onClick?.(event, ctx),
      onPointerMove: (event, ctx) => self.inner.onPointerMove?.(event, ctx),
      cancel: (ctx) => self.inner.cancel?.(ctx),
      get nudgeElevation() {
        const fn = self.inner.nudgeElevation;
        return fn ? (delta: number) => self.inner.nudgeElevation?.(delta) : undefined;
      },
    };
  }
}

interface AliasTarget {
  toolId: string;
  genusId: string;
  speciesId: string | null;
}

const runtimeByTool = new Map<string, CategoryRuntime>();
const aliasIndex = new Map<string, AliasTarget>();

type PlacementListener = () => void;
const listeners = new Set<PlacementListener>();

export function subscribeCategoryPlacement(listener: PlacementListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifyCategoryPlacement(): void {
  for (const listener of listeners) listener();
}

function iconForSlot(slot: RibbonSlot<ComponentDto>, primary: ComponentDto): ToolIcon {
  if (componentIcon(primary) !== TOOL_ICONS.component) return componentIcon(primary);
  const tail = slot.category.split('.').pop() ?? slot.category;
  for (const name of [slot.category, tail, tail.replace(/_/g, '-')]) {
    if (catalogIconByName(name, 24)) return name;
  }
  return TOOL_ICONS.component;
}

function createAliasTool(aliasId: string, genus: ComponentDto, target: AliasTarget): Tool {
  const useRuntime = () => {
    const runtime = runtimeByTool.get(target.toolId);
    runtime?.setPlacementTarget(target.genusId, target.speciesId);
    return runtime;
  };
  return {
    id: aliasId,
    label: genus.display_name,
    descriptor: describeFromComponent(genus),
    group: 'create',
    hideFromRibbon: true,
    componentId: genus.id,
    hint: () => '',
    onClick: (event, ctx) => useRuntime()?.dispatch('onClick', event, ctx),
    onPointerMove: (event, ctx) => useRuntime()?.dispatch('onPointerMove', event, ctx),
  };
}

/**
 * Replace per-genus placement tools with one tool per category.
 * Built-in command ids stay registered so hotkeys keep resolving.
 */
export function installCategoryTools(registry: ToolRegistry, components: readonly ComponentDto[]): void {
  const existing = new Set(registry.list().map((tool) => tool.id));
  const slots = ribbonSlots(components, existing);
  aliasIndex.clear();
  runtimeByTool.clear();
  for (const slot of slots) {
    const prior = registry.get(slot.toolId);
    const runtime = new CategoryRuntime(slot, prior);
    const tool = runtime.makeTool(prior);
    runtimeByTool.set(slot.toolId, runtime);
    registry.register(tool);
    for (const aliasId of slot.aliasToolIds) {
      const genusId = aliasId.slice('place:'.length);
      const genus = slot.genera.find((item) => item.id === genusId);
      if (!genus) continue;
      const target: AliasTarget = {
        toolId: slot.toolId,
        genusId,
        speciesId: genus.default_species ?? null,
      };
      aliasIndex.set(aliasId, target);
      registry.register(createAliasTool(aliasId, genus, target));
    }
  }
}

/** Map a built-in alias (`place:apex.roof.pitched`) onto the category tool. */
export function prepareToolActivation(id: string): string {
  const alias = aliasIndex.get(id);
  if (!alias) return id;
  runtimeByTool.get(alias.toolId)?.setPlacementTarget(alias.genusId, alias.speciesId);
  return alias.toolId;
}

/** Select a genus and return the ribbon tool that places it. */
export function focusGenusPlacement(genusId: string): string | null {
  for (const runtime of runtimeByTool.values()) {
    if (!runtime.owns(genusId)) continue;
    runtime.setPlacementTarget(genusId, null);
    return runtime.slot.toolId;
  }
  return null;
}

/** True when a per-genus `place:<id>` tool would duplicate a category button. */
export function isCategoryPlacementCovered(componentId: string): boolean {
  for (const runtime of runtimeByTool.values()) {
    if (runtime.owns(componentId)) return true;
  }
  return false;
}

export function activePlacementStyle(toolId: string): 'hosted' | 'free' | null {
  const runtime = runtimeByTool.get(toolId);
  if (!runtime) return null;
  const genus = runtime.genera.find((item) => item.id === runtime.genusId);
  if (!genus) return null;
  return placementStyle(genus);
}

export interface GenusPaletteEntry {
  id: string;
  toolId: string;
  genusId: string;
  speciesId: string | null;
  label: string;
  search: string;
}

/** Palette rows such as "Window: Corner window". The ribbon button is not repeated. */
export function genusPaletteEntries(): GenusPaletteEntry[] {
  const entries: GenusPaletteEntry[] = [];
  for (const runtime of runtimeByTool.values()) {
    const slotLabel = runtime.label();
    for (const genus of runtime.genera) {
      if (genus.id === runtime.slot.primaryGenusId && genus.source === 'built_in') continue;
      const en = CATALOGS.en[`component.${genus.id}`] ?? '';
      const ru = CATALOGS.ru[`component.${genus.id}`] ?? '';
      const name = t(`component.${genus.id}`, undefined, genus.display_name);
      entries.push({
        id: `genus:${genus.id}`,
        toolId: runtime.slot.toolId,
        genusId: genus.id,
        speciesId: genus.default_species ?? null,
        label: `${slotLabel}: ${name}`,
        search: `${slotLabel} ${categoryPlaceLabelBoth(runtime.slot.category)} ${name} ${en} ${ru} ${genus.display_name} ${genus.id}`.toLowerCase(),
      });
    }
  }
  return entries;
}

export function resetCategoryToolsForTests(): void {
  runtimeByTool.clear();
  aliasIndex.clear();
  listeners.clear();
}
