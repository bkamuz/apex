// A site line seats on a slope in two ways: level from the start, or a
// straight chord through the ends. Posts reach the ground; the panel does not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createElement,
  getScene,
  getSelected,
  initApp,
  initSync,
  listComponents,
  newProject,
  selectElement,
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
  elements: Array<{ id: string; component_id: string; pick_id: number }>;
};

function scene(): Scene {
  return getScene() as Scene;
}

function place(
  pts: Array<[number, number]>,
  params: Record<string, unknown>,
  kind = 'two_point',
): string {
  const before = new Set(scene().elements.map((el) => el.id));
  createElement(
    'apex.site_line',
    JSON.stringify(pts.map(([x, z]) => [x, 0, z])),
    0,
    JSON.stringify(params),
    kind,
  );
  const hit = scene().elements.find((el) => el.component_id === 'apex.site_line' && !before.has(el.id));
  if (!hit) throw new Error('missing site line');
  return hit.id;
}

function topAt(view: Scene, pick: number, x: number, z: number): number {
  let best = Number.NEGATIVE_INFINITY;
  const { positions, indices, pick_ids } = view;
  for (let t = 0; t < pick_ids.length; t += 1) {
    if (pick_ids[t] !== pick) continue;
    const p = [0, 1, 2].map((k) => {
      const i = indices[t * 3 + k];
      return [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
    });
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

function lowestNear(view: Scene, pick: number, x: number, z: number, r: number): number {
  let lo = Number.POSITIVE_INFINITY;
  const { positions, indices, pick_ids } = view;
  for (let t = 0; t < pick_ids.length; t += 1) {
    if (pick_ids[t] !== pick) continue;
    for (let k = 0; k < 3; k += 1) {
      const i = indices[t * 3 + k];
      const px = positions[i * 3];
      const py = positions[i * 3 + 1];
      const pz = positions[i * 3 + 2];
      if ((px - x) ** 2 + (pz - z) ** 2 <= r * r) lo = Math.min(lo, py);
    }
  }
  return lo;
}

function pickOf(id: string): number {
  const el = scene().elements.find((row) => row.id === id);
  if (!el) throw new Error(id);
  return el.pick_id;
}

function slopedTerrain(): void {
  const before = new Set(scene().elements.map((el) => el.id));
  createElement(
    'apex.terrain',
    JSON.stringify([[0, 0, 0], [10, 0, 0], [10, 0, 10], [0, 0, 10]]),
    0,
    JSON.stringify({ bottom_offset: 0.2, smooth: false, contour_interval: 5 }),
    'polyline',
  );
  const terrain = scene().elements.find((el) => el.component_id === 'apex.terrain' && !before.has(el.id));
  if (!terrain) throw new Error('missing terrain');
  setSlabShape(terrain.id, JSON.stringify({ z: [0, 0, 2, 2], points: [], creases: [] }));
}

test('level from start stays flat and the low post reaches the slope', () => {
  newProject();
  slopedTerrain();
  const id = place([[5, 9], [5, 1]], {
    seating: 'level_from_start',
    content: 'repeated',
    post_spacing: 20,
    panel_height: 1,
    elevation_offset: 0,
  });
  const view = scene();
  const pick = pickOf(id);
  const mid = topAt(view, pick, 5, 5);
  assert.ok(mid > 2.5, `level panel top ${mid} should stay near 2.8`);
  const post = lowestNear(view, pick, 5, 1, 0.2);
  assert.ok(post < 0.4, `low post bottom ${post}`);
});

test('by ends is a straight curb over a peak', () => {
  newProject();
  const before = new Set(scene().elements.map((el) => el.id));
  createElement(
    'apex.terrain',
    JSON.stringify([[0, 0, 0], [10, 0, 0], [10, 0, 10], [0, 0, 10]]),
    0,
    JSON.stringify({ smooth: false }),
    'polyline',
  );
  const terrain = scene().elements.find((el) => el.component_id === 'apex.terrain' && !before.has(el.id));
  if (!terrain) throw new Error('missing terrain');
  setSlabShape(terrain.id, JSON.stringify({ z: [0, 0, 0, 0], points: [[5, 5, 2]], creases: [] }));
  const id = place([[0, 5], [10, 5]], {
    species: 'apex.site_line.curb',
    seating: 'by_ends',
    content: 'profile',
  });
  selectElement(id);
  const selected = getSelected() as { params: Record<string, unknown> };
  assert.equal(selected.params.species, 'apex.site_line.curb');
  assert.equal(selected.params.content, 'profile');
  const mid = topAt(scene(), pickOf(id), 5, 5);
  assert.ok(mid < 0.5, `curb follows the chord (${mid}), not the peak`);
});

test('site line strings exist in EN and RU', () => {
  const keys = [
    'component.apex.site_line',
    'component.apex.site_line.title',
    'species.apex.site_line.fence',
    'species.apex.site_line.curb',
    'inspector.cat.site_line',
    'param.label.seating',
    'param.label.content',
    'param.label.elevation_offset',
    'param.choice.seating.by_ends',
    'param.choice.seating.level_from_start',
    'param.choice.content.repeated',
    'param.choice.content.profile',
  ];
  for (const key of keys) {
    assert.ok(en[key], `en ${key}`);
    assert.ok(ru[key], `ru ${key}`);
    assert.notEqual(en[key], ru[key], key);
    assert.ok(!/famil/i.test(`${en[key]} ${ru[key]}`), key);
    assert.ok(!/семейств/i.test(ru[key]), key);
  }
  assert.equal(en['param.choice.seating.by_ends'], 'By ends');
  assert.equal(ru['param.choice.seating.by_ends'], 'По концам');
  assert.equal(en['param.choice.seating.level_from_start'], 'Level from start');
  assert.equal(ru['param.choice.seating.level_from_start'], 'Горизонтально от начала');
  assert.equal(en['param.choice.content.repeated'], 'Repeated objects');
  assert.equal(ru['param.choice.content.repeated'], 'Повтор объектов');
  assert.equal(en['param.choice.content.profile'], 'Continuous profile');
  assert.equal(ru['param.choice.content.profile'], 'Сплошной профиль');

  newProject();
  const comps = listComponents() as Array<{ id: string; params: Array<{ id: string; options?: string[] }> }>;
  const line = comps.find((c) => c.id === 'apex.site_line');
  assert.deepEqual(line?.params.find((p) => p.id === 'seating')?.options, ['by_ends', 'level_from_start']);
  assert.deepEqual(line?.params.find((p) => p.id === 'content')?.options, ['repeated', 'profile']);
});
