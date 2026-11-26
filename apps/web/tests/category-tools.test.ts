import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { componentDisplayName, toolDisplayLabel, toolDisplayTitle } from '../src/i18n/display.ts';
import { getLocale, setLocale, t } from '../src/i18n/t.ts';
import {
  genusTooltip,
  resetCategoryPlacementMemory,
  generaForCategorySwitch,
  ribbonSlots,
  slotKeyFor,
  type RibbonComponent,
} from '../src/tools/categorySlots.ts';
import {
  activePlacementStyle,
  genusPaletteEntries,
  installCategoryTools,
  prepareToolActivation,
  resetCategoryToolsForTests,
} from '../src/tools/categoryTool.ts';
import type { Tool, ToolMode } from '../src/tools/Tool.ts';
import type { ComponentDto } from '../src/types.ts';

interface Registry {
  register(tool: Tool): void;
  get(id: string): Tool | undefined;
  list(): Tool[];
}

function createRegistry(): Registry {
  const tools = new Map<string, Tool>();
  return {
    register(tool) {
      if (!tool.descriptor?.purpose?.trim()) throw new Error(`tool ${tool.id} has no descriptor`);
      tools.set(tool.id, tool);
    },
    get: (id) => tools.get(id),
    list: () => [...tools.values()],
  };
}

const WALL_MODES: ToolMode[] = [
  { id: 'line', label: 'Line', placement: 'two_point' },
  { id: 'arc', label: 'Arc', placement: 'three_point_arc' },
  { id: 'polyline', label: 'Polyline', placement: 'polyline' },
];

function comp(
  partial: Partial<ComponentDto> &
    Pick<ComponentDto, 'id' | 'display_name' | 'category' | 'placement'>,
): ComponentDto {
  return {
    source: 'visual',
    params: [],
    recipe: { op: 'extrude' },
    descriptor: { purpose: `Place ${partial.display_name}.` },
    ...partial,
  } as ComponentDto;
}

function stub(id: string, extra: Partial<Tool> = {}): Tool {
  return {
    id: `place:${id}`,
    label: id,
    descriptor: { purpose: `Place ${id}.` },
    group: 'create',
    componentId: id,
    hint: () => '',
    ...extra,
  };
}

function install(components: ComponentDto[], extraStubs: Tool[] = []): Registry {
  const registry = createRegistry();
  const tooled = components.filter(
    (item) => item.source === 'built_in' && item.category !== 'modifier' && item.category !== 'genus-part',
  );
  for (const item of tooled) {
    registry.register(
      item.id === 'apex.wall'
        ? stub(item.id, { modes: WALL_MODES, getMode: () => 'line', shortcut: 'W' })
        : stub(item.id),
    );
  }
  for (const tool of extraStubs) registry.register(tool);
  installCategoryTools(registry, components);
  return registry;
}

function visibleIds(registry: Registry): string[] {
  return registry
    .list()
    .filter((tool) => !tool.hideFromRibbon)
    .map((tool) => tool.id)
    .sort();
}

beforeEach(() => {
  resetCategoryToolsForTests();
  resetCategoryPlacementMemory();
});

const windowBuiltIn = comp({
  id: 'apex.window',
  display_name: 'Window',
  category: 'opening',
  source: 'built_in',
  placement: 'point',
  host_cut: { host_categories: ['wall'] },
  default_species: 'apex.window.single-1200x1400',
});

const doorBuiltIn = comp({
  id: 'apex.door',
  display_name: 'Door',
  category: 'opening',
  source: 'built_in',
  placement: 'point',
  host_cut: { host_categories: ['wall'] },
  default_species: 'apex.door.single-900x2100',
});

const corner = comp({
  id: 'user.corner',
  display_name: 'Corner window',
  category: 'opening',
  source: 'visual',
  placement: 'point',
  genus: { extends: 'apex.window' },
  descriptor: { purpose: "User genus 'Corner window'." },
});

test('a derived window joins Window; Door stays its own button', () => {
  const registry = install([windowBuiltIn, doorBuiltIn, corner]);
  const visible = visibleIds(registry);
  assert.ok(visible.includes('place:apex.window'));
  assert.ok(visible.includes('place:apex.door'));
  assert.equal(visible.includes('place:user.corner'), false);
  assert.equal(slotKeyFor(corner, [windowBuiltIn, doorBuiltIn, corner]), 'opening:apex.window');
  assert.notEqual(slotKeyFor(doorBuiltIn, [windowBuiltIn, doorBuiltIn, corner]), slotKeyFor(corner, [windowBuiltIn, doorBuiltIn, corner]));

  const windowTool = registry.get('place:apex.window');
  assert.ok(windowTool);
  assert.equal(windowTool.componentId, 'apex.window');
  assert.equal(activePlacementStyle('place:apex.window'), 'hosted');
  assert.match(windowTool.hint(0), /move near/);

  windowTool.setPlacementTarget?.('user.corner', null);
  assert.equal(windowTool.componentId, 'user.corner');
  assert.equal(activePlacementStyle('place:apex.window'), 'free');
  assert.doesNotMatch(windowTool.hint(0), /move near/);

  windowTool.setPlacementTarget?.('apex.window', 'apex.window.double-1500x1400');
  assert.equal(windowTool.componentId, 'apex.window');
  assert.equal(windowTool.placementSpeciesId?.(), 'apex.window.double-1500x1400');
  assert.equal(activePlacementStyle('place:apex.window'), 'hosted');

  const labels = genusPaletteEntries().map((entry) => entry.label);
  assert.ok(labels.includes('Window: Corner window'));
  assert.equal(labels.some((label) => label === 'Window: Window'), false);
});

test('flat and pitched roofs share one Roof button; the pitched command stays an alias', () => {
  const roof = comp({
    id: 'apex.roof',
    display_name: 'Roof',
    category: 'roof',
    source: 'built_in',
    placement: 'polyline',
  });
  const pitched = comp({
    id: 'apex.roof.pitched',
    display_name: 'Pitched roof',
    category: 'roof',
    source: 'built_in',
    placement: 'two_point',
  });
  const registry = install([roof, pitched]);
  assert.deepEqual(
    visibleIds(registry).filter((id) => id.includes('roof')),
    ['place:apex.roof'],
  );
  const alias = registry.get('place:apex.roof.pitched');
  assert.equal(alias?.hideFromRibbon, true);
  assert.equal(prepareToolActivation('place:apex.roof.pitched'), 'place:apex.roof');
  assert.equal(registry.get('place:apex.roof')?.componentId, 'apex.roof.pitched');
  assert.equal(
    genusPaletteEntries().some((entry) => entry.label === 'Roof: Pitched roof'),
    true,
  );
});

test('user-only categories get one button, and nested parts do not', () => {
  const planter = comp({
    id: 'acme.planter',
    display_name: 'Planter',
    category: 'furniture',
    placement: 'point',
  });
  const chair = comp({
    id: 'acme.chair',
    display_name: 'Chair',
    category: 'furniture',
    placement: 'point',
  });
  const part = comp({
    id: 'user.sash',
    display_name: 'Sash',
    category: 'genus-part',
    placement: 'point',
  });
  const booleanOp = comp({
    id: 'apex.boolean',
    display_name: 'Boolean',
    category: 'modifier',
    source: 'built_in',
    placement: 'free',
  });
  const registry = install([planter, chair, part, booleanOp]);
  const visible = visibleIds(registry);
  assert.ok(visible.includes('place:category:furniture'));
  assert.equal(visible.filter((id) => id.includes('planter') || id.includes('chair') || id.includes('sash') || id.includes('boolean')).length, 0);
  const furniture = registry.get('place:category:furniture');
  assert.ok(furniture);
  assert.equal(toolDisplayLabel(furniture), 'Furniture');
  assert.equal(toolDisplayTitle(furniture), 'Place furniture.');
  assert.notEqual(toolDisplayTitle(furniture), toolDisplayLabel(furniture));
  assert.equal(furniture.categoryGenera?.().length, 2);
});

test('wall draw modes stay on the built-in genus and drop for a user wall', () => {
  const wall = comp({
    id: 'apex.wall',
    display_name: 'Wall',
    category: 'wall',
    source: 'built_in',
    placement: 'path',
    joinable: true,
  });
  const userWall = comp({
    id: 'user.wall',
    display_name: 'Garden wall',
    category: 'wall',
    placement: 'path',
    genus: { extends: 'apex.wall' },
  });
  const registry = install([wall, userWall]);
  const tool = registry.get('place:apex.wall');
  assert.ok(tool);
  assert.equal(tool.shortcut, 'W');
  assert.equal(tool.getMode?.(), 'line');
  assert.equal(tool.modes?.length, 3);
  tool.setPlacementTarget?.('user.wall', null);
  assert.equal(tool.modes, undefined);
  assert.equal(tool.componentId, 'user.wall');
  tool.setPlacementTarget?.('apex.wall', null);
  assert.equal(tool.modes?.length, 3);
  assert.equal(tool.getMode?.(), 'line');
});

test('an opening genus with no built-in root gets the Opening button, not its own', () => {
  const loose = comp({
    id: 'user.hole',
    display_name: 'Hole',
    category: 'opening',
    placement: 'point',
  });
  const slots = ribbonSlots([loose], new Set());
  assert.equal(slots.length, 1);
  assert.equal(slots[0]?.toolId, 'place:category:opening');
  assert.equal(slots[0]?.genera.length, 1);
});

test('genus tooltips describe the genus, and copy names follow the UI language', () => {
  const previous = getLocale();
  try {
    setLocale('en');
    const tip = genusTooltip(corner);
    assert.notEqual(tip, corner.display_name);
    assert.match(tip, /Corner window/);
    assert.match(tip, /genus/i);
    const authored = genusTooltip({
      ...corner,
      descriptor: { purpose: 'A corner window for thick walls.' },
    });
    assert.equal(authored, 'A corner window for thick walls.');
    assert.equal(
      t('genusEditor.copyName', { name: componentDisplayName('apex.window', 'Window') }),
      'Window (copy)',
    );

    setLocale('ru');
    const tipRu = genusTooltip(corner);
    assert.notEqual(tipRu, tip);
    assert.match(tipRu, /Corner window/);
    assert.match(tipRu, /род/i);
    assert.equal(
      t('genusEditor.copyName', { name: componentDisplayName('apex.window', 'Window') }),
      'Окно (копия)',
    );
  } finally {
    setLocale(previous);
  }
});

test('last-used genus survives a tool rebuild', () => {
  const components = [windowBuiltIn, corner];
  const first = install(components);
  first.get('place:apex.window')?.setPlacementTarget?.('user.corner', null);
  resetCategoryToolsForTests();
  const second = install(components);
  assert.equal(second.get('place:apex.window')?.componentId, 'user.corner');
});

test('inspector lists slot-mates and same-category genera that have species', () => {
  const pitched = comp({
    id: 'apex.roof.pitched',
    display_name: 'Pitched roof',
    category: 'roof',
    source: 'built_in',
    placement: 'two_point',
  });
  const furniture = comp({
    id: 'acme.planter',
    display_name: 'Planter',
    category: 'furniture',
    placement: 'point',
  });
  const components = [windowBuiltIn, doorBuiltIn, corner, pitched, furniture];
  const ids = generaForCategorySwitch(windowBuiltIn, components, new Set(['user.corner'])).map(
    (item) => item.id,
  );
  assert.deepEqual(ids.sort(), ['apex.door', 'apex.window', 'user.corner']);
  const bare = { ...corner, id: 'user.bare' };
  const withoutSpecies = generaForCategorySwitch(windowBuiltIn, [...components, bare], new Set());
  assert.equal(withoutSpecies.some((item) => item.id === 'user.bare'), false);
});

test('slot keys keep an explicitly recategorized genus off the Window button', () => {
  const furnitureWindow = comp({
    id: 'user.corner',
    display_name: 'Corner window',
    category: 'furniture',
    placement: 'point',
    genus: { extends: 'apex.window' },
  });
  const components: RibbonComponent[] = [windowBuiltIn, furnitureWindow];
  assert.equal(slotKeyFor(furnitureWindow, components), 'category:furniture');
  assert.equal(slotKeyFor(windowBuiltIn, components), 'opening:apex.window');
});
