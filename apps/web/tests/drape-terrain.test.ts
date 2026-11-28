// A lawn drawn as a plan square follows a sloped terrain; paving stays level.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createElement,
  getScene,
  initApp,
  initSync,
  listComponents,
  newProject,
  setSlabShape,
} from '../src/wasm/pkg/apex_wasm.js';
import { en } from '../src/i18n/catalogs/en.ts';
import { ru } from '../src/i18n/catalogs/ru.ts';

const wasm = readFileSync(new URL('../src/wasm/pkg/apex_wasm_bg.wasm', import.meta.url));
initSync({ module: wasm });
initApp();

type Scene = {
  positions: Float32Array;
  indices: Uint32Array;
  pick_ids: Float64Array;
  elements: Array<{
    id: string;
    component_id: string;
    pick_id: number;
    surface_kind?: string;
    params?: Record<string, unknown>;
  }>;
};

function scene(): Scene {
  return getScene() as Scene;
}

function ring(pts: Array<[number, number]>): string {
  return JSON.stringify(pts.map(([x, z]) => [x, 0, z]));
}

function place(component: string, pts: Array<[number, number]>, params: Record<string, unknown>): string {
  const before = new Set(scene().elements.map((el) => el.id));
  createElement(component, ring(pts), 0, JSON.stringify(params), 'polyline');
  const hit = scene().elements.find((el) => el.component_id === component && !before.has(el.id));
  if (!hit) throw new Error(`missing ${component}`);
  return hit.id;
}

/** Highest triangle covering plan (x, z) for one pick id. */
function topAt(view: Scene, pick: number, x: number, z: number): number {
  let best = Number.NEGATIVE_INFINITY;
  const { positions, indices, pick_ids } = view;
  for (let t = 0; t < pick_ids.length; t += 1) {
    if (pick_ids[t] !== pick) continue;
    const i0 = indices[t * 3];
    const i1 = indices[t * 3 + 1];
    const i2 = indices[t * 3 + 2];
    const p = [i0, i1, i2].map((i) => [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]]);
    const area = (p[1][0] - p[0][0]) * (p[2][2] - p[0][2]) - (p[1][2] - p[0][2]) * (p[2][0] - p[0][0]);
    if (Math.abs(area) < 1e-8) continue;
    const l1 = ((p[1][2] - p[2][2]) * (x - p[2][0]) + (p[2][0] - p[1][0]) * (z - p[2][2])) / area;
    const l2 = ((p[2][2] - p[0][2]) * (x - p[2][0]) + (p[0][0] - p[2][0]) * (z - p[2][2])) / area;
    const l3 = 1 - l1 - l2;
    if (l1 >= -1e-3 && l2 >= -1e-3 && l3 >= -1e-3) {
      best = Math.max(best, l1 * p[0][1] + l2 * p[1][1] + l3 * p[2][1]);
    }
  }
  return best;
}

function pickOf(id: string): number {
  const el = scene().elements.find((row) => row.id === id);
  if (!el) throw new Error(id);
  return el.pick_id;
}

test('a lawn drapes on a slope and paving stays flat', () => {
  newProject();
  const terrain = place('apex.terrain', [[0, 0], [10, 0], [10, 10], [0, 10]], {
    bottom_offset: 0.2,
    smooth: false,
    contour_interval: 5,
  });
  setSlabShape(terrain, JSON.stringify({ z: [0, 0, 2, 2], points: [], creases: [] }));
  const lawn = place('apex.site_surface', [[2, 2], [8, 2], [8, 8], [2, 8]], {
    thickness: 0.05,
    surface_kind: 'lawn',
  });
  const view = scene();
  const lawnPick = pickOf(lawn);
  const centre = topAt(view, lawnPick, 5, 5);
  const south = topAt(view, lawnPick, 5, 2);
  // Terrain y = 0.2 * z, plus 2 cm clearance and 5 cm thickness.
  const expect = 0.2 * 5 + 0.02 + 0.05;
  assert.ok(Math.abs(centre - expect) < 0.02, `centre ${centre} vs ${expect}`);
  assert.ok(centre > south + 0.4, `lawn rises with the slope (${south} → ${centre})`);

  const drive = place('apex.site_surface', [[2, 2], [4, 2], [4, 4], [2, 4]], {
    thickness: 0.1,
    surface_kind: 'driveway',
  });
  const after = scene();
  const ys: number[] = [];
  const drivePick = pickOf(drive);
  const pos = after.positions;
  const idx = after.indices;
  for (let t = 0; t < after.pick_ids.length; t += 1) {
    if (after.pick_ids[t] !== drivePick) continue;
    for (let k = 0; k < 3; k += 1) {
      ys.push(pos[idx[t * 3 + k] * 3 + 1]);
    }
  }
  ys.sort((a, b) => a - b);
  const span = ys[ys.length - 1] - ys[0];
  assert.ok(Math.abs(span - 0.1) < 0.01, `flat driveway span ${span}`);
  const flat = topAt(after, drivePick, 3, 3);
  assert.ok(Math.abs(flat - expect) > 0.2, 'driveway does not follow the slope');
});

test('editing the terrain re-drapes a path', () => {
  newProject();
  const terrain = place('apex.terrain', [[0, 0], [10, 0], [10, 10], [0, 10]], { smooth: false });
  const path = place('apex.site_surface', [[2, 2], [8, 2], [8, 8], [2, 8]], { surface_kind: 'path' });
  const before = topAt(scene(), pickOf(path), 5, 5);
  setSlabShape(terrain, JSON.stringify({ z: [0, 0, 0, 0], points: [[5, 5, 1.5]], creases: [] }));
  const after = topAt(scene(), pickOf(path), 5, 5);
  // Path sits 2 cm + 6 cm above the ground, plus the 5 cm default thickness.
  const expect = 1.5 + 0.02 + 0.06 + 0.05;
  assert.ok(Math.abs(after - expect) < 0.03, `peak ${after} vs ${expect} (was ${before})`);
  assert.ok(after > before + 1, `terrain edit re-drapes the path (${before} → ${after})`);
});

test('placement choices are localized in EN and RU', () => {
  const keys = [
    'param.label.placement',
    'param.choice.placement_mode.draped',
    'param.choice.placement_mode.flat',
    'param.choice.surface_kind.lawn',
    'param.choice.surface_kind.path',
    'param.choice.surface_kind.gravel',
    'param.choice.surface_kind.paved',
    'param.choice.surface_kind.driveway',
  ];
  for (const key of keys) {
    assert.ok(en[key], `en ${key}`);
    assert.ok(ru[key], `ru ${key}`);
    assert.notEqual(en[key], ru[key], key);
    assert.ok(!/famil/i.test(`${en[key]} ${ru[key]}`), key);
    assert.ok(!/семейств/i.test(ru[key]), key);
  }
  assert.equal(en['param.choice.placement_mode.draped'], 'Draped on terrain');
  assert.equal(ru['param.choice.placement_mode.draped'], 'По рельефу');
  assert.equal(ru['param.choice.placement_mode.flat'], 'Плоско');

  newProject();
  const comps = listComponents() as Array<{ id: string; params: Array<{ id: string; options?: string[] }> }>;
  const site = comps.find((c) => c.id === 'apex.site_surface');
  const mode = site?.params.find((p) => p.id === 'placement_mode');
  const kind = site?.params.find((p) => p.id === 'surface_kind');
  assert.deepEqual(mode?.options, ['draped', 'flat']);
  assert.deepEqual(kind?.options, ['lawn', 'path', 'gravel', 'paved', 'driveway']);
});
