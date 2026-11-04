// System packs: prefs + install filter (catalog shape mirrored as fixtures).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultEnabledPackIds,
  loadEnabledPackIds,
  PACK_STORAGE_KEY,
  pluginsForEnabledPacks,
  saveEnabledPackIds,
} from '../src/plugins/packPrefs.ts';

/** Mirrors `systemPacks` / `alwaysOnPlugins` in catalog.ts for Node unit tests. */
const alwaysOn = [
  { id: 'apex.select' },
  { id: 'apex.move' },
  { id: 'apex.copy' },
  { id: 'apex.parent' },
  { id: 'apex.project.json' },
];

const packs = [
  {
    id: 'apex.pack.basics',
    defaultEnabled: true,
    plugins: [
      { id: 'apex.level' },
      { id: 'apex.ref_point' },
      { id: 'apex.ref_plane' },
      { id: 'apex.construction_line' },
      { id: 'apex.grid_axis' },
      { id: 'apex.section_cut' },
    ],
  },
  {
    id: 'apex.pack.building',
    defaultEnabled: true,
    plugins: [
      { id: 'apex.wall' },
      { id: 'apex.column' },
      { id: 'apex.beam' },
      { id: 'apex.slab' },
      { id: 'apex.door' },
      { id: 'apex.window' },
      { id: 'apex.slab_opening' },
      { id: 'apex.stair' },
      { id: 'apex.roof' },
      { id: 'apex.roof.pitched' },
    ],
  },
  {
    id: 'apex.pack.engineering',
    defaultEnabled: true,
    plugins: [{ id: 'apex.pipe' }, { id: 'apex.duct' }, { id: 'apex.cable_tray' }],
  },
  {
    id: 'apex.pack.spaces',
    defaultEnabled: true,
    plugins: [{ id: 'apex.space' }],
  },
  {
    id: 'apex.pack.site',
    defaultEnabled: true,
    plugins: [{ id: 'apex.fence' }, { id: 'apex.gate' }, { id: 'apex.site_surface' }],
  },
  {
    id: 'apex.pack.annotate',
    defaultEnabled: true,
    plugins: [{ id: 'apex.annotate' }],
  },
  {
    id: 'apex.pack.ifc',
    defaultEnabled: true,
    plugins: [{ id: 'apex.export.ifc' }],
  },
];

function memStorage() {
  const m = new Map<string, string>();
  return {
    m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  };
}

test('defaults enable every pack (today’s toolbar)', () => {
  assert.deepEqual(
    defaultEnabledPackIds(packs),
    packs.map((p) => p.id),
  );
  const all = pluginsForEnabledPacks(alwaysOn, packs, defaultEnabledPackIds(packs)).map(
    (p) => p.id,
  );
  assert.ok(all.includes('apex.pipe'));
  assert.ok(all.includes('apex.wall'));
  assert.ok(all.includes('apex.select'));
  assert.ok(all.includes('apex.export.ifc'));
});

test('disabling engineering hides pipe/duct/cable_tray; building stays', () => {
  const enabled = defaultEnabledPackIds(packs).filter((id) => id !== 'apex.pack.engineering');
  const ids = pluginsForEnabledPacks(alwaysOn, packs, enabled).map((p) => p.id);
  assert.equal(ids.includes('apex.pipe'), false);
  assert.equal(ids.includes('apex.duct'), false);
  assert.equal(ids.includes('apex.cable_tray'), false);
  assert.ok(ids.includes('apex.wall'));
  assert.ok(ids.includes('apex.column'));
  assert.ok(ids.includes('apex.select'));
  assert.ok(ids.includes('apex.export.ifc'));
});

test('pack prefs persist enabled ids; missing/invalid → defaults', () => {
  const st = memStorage();
  assert.deepEqual(loadEnabledPackIds(st, packs), defaultEnabledPackIds(packs));
  const withoutEng = defaultEnabledPackIds(packs).filter((id) => id !== 'apex.pack.engineering');
  saveEnabledPackIds(st, withoutEng);
  assert.equal(st.m.get(PACK_STORAGE_KEY), JSON.stringify(withoutEng));
  assert.deepEqual(loadEnabledPackIds(st, packs), withoutEng);
  st.setItem(PACK_STORAGE_KEY, 'not-json');
  assert.deepEqual(loadEnabledPackIds(st, packs), defaultEnabledPackIds(packs));
  st.setItem(PACK_STORAGE_KEY, JSON.stringify(['apex.pack.engineering', 'apex.pack.nope']));
  assert.deepEqual(loadEnabledPackIds(st, packs), ['apex.pack.engineering']);
});
