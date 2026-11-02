// Screenshot the properties panel for every element kind.
// Usage: APEX_SMOKE_URL=http://localhost:5182/ OUT=dir [LANG=ru] node scripts/props-panel-shots.mjs
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
const BASE = process.env.APEX_SMOKE_URL ?? 'http://localhost:5173/';
const OUT = process.env.OUT ?? '/tmp/props-shots';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const KERNEL = process.env.KERNEL ?? 'mesh';
const page = await browser.newPage({ viewport: { width: 1440, height: 1500 } });
await page.addInitScript((lang) => {
  localStorage.setItem('apex.gettingStarted.dismissed', '1');
  if (lang) localStorage.setItem('apex.locale', lang);
}, process.env.LANG_UI ?? '');
await page.goto(`${BASE}?kernel=${KERNEL}`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.__apexTest?.loadSampleProject, null, { timeout: 60000 });
await page.evaluate(() => window.__apexTest.loadSampleProject());
await page.waitForTimeout(1200);
// Extra kinds the sample lacks: a user genus, an extending genus, datums.
await page.evaluate(() => {
  const T = window.__apexTest;
  T.command({ op: 'define_genus', id: 'user.shelf', name: 'Shelf', placement: { kind: 'point' },
    params: [{ id: 'width', default: 1.2 }, { id: 'depth', default: 0.4 }, { id: 'height', default: 0.9 }],
    body: [{ id: 'board', item: 'solid', shape: 'box', min: [0, 0, 0], max: ['width', 'height', 'depth'] }] });
  T.command({ op: 'create_element', component: 'user.shelf', points: [[12, 0, 2]], params: { width: 1.5 } });
  T.command({ op: 'create_element', component: 'user.shelf', points: [[14, 0, 2]] });
  T.command({ op: 'create_reference', kind: 'point', points: [[12, 0, 6]] });
  T.command({ op: 'create_reference', kind: 'plane', points: [[12, 0, 8], [14, 0, 8]] });
});
await page.waitForTimeout(500);
const els = await page.evaluate(() => window.__apexTest.api.listElements().map((e) => ({ id: e.id, c: e.category, comp: e.component_id })));
const pick = (pred) => els.find(pred)?.id;
// An instance override on the first window, so the badge + reset show.
const win = pick((e) => e.comp === 'apex.window');
if (win) await page.evaluate((i) => window.__apexTest.command({ op: 'update_element', id: i, params: { sill: 1.05 } }), win);
const shots = [
  ['wall', pick((e) => e.c === 'wall')],
  ['slab', pick((e) => e.c === 'slab')],
  ['roof', pick((e) => e.c === 'roof')],
  ['window', pick((e) => e.comp === 'apex.window')],
  ['door', pick((e) => e.comp === 'apex.door')],
  ['stair', pick((e) => e.c === 'stair')],
  ['genus-instance', els.filter((e) => e.comp === 'user.shelf')[0]?.id],
];
const shoot = async (name) => {
  await page.waitForTimeout(400);
  const panel = page.locator('aside.inspector');
  await panel.evaluate((n) => { n.style.maxHeight = 'none'; n.style.height = 'auto'; n.style.overflow = 'visible'; });
  await panel.screenshot({ path: `${OUT}/${name}.png` });
  console.log('shot', name);
};
for (const [name, id] of shots) {
  if (!id) { console.log('skip', name); continue; }
  await page.evaluate((i) => { window.__apexTest.clearSelection(); window.__apexTest.selectElements([i]); }, id);
  await shoot(name);
}
const walls = els.filter((e) => e.c === 'wall').slice(0, 3).map((e) => e.id);
await page.evaluate((ids) => { window.__apexTest.clearSelection(); window.__apexTest.selectElements(ids); }, walls);
await shoot('multi-walls');
const mixed = [walls[0], pick((e) => e.comp === 'apex.window')].filter(Boolean);
await page.evaluate((ids) => { window.__apexTest.clearSelection(); window.__apexTest.selectElements(ids); }, mixed);
await shoot('multi-mixed');
const scene = await page.evaluate(async () => (await import('/src/wasm/apex.ts')).apexGetScene());
for (const [kind, list, name] of [
  ['grid', scene.grid_axes, 'grid'],
  ['reference', (scene.references ?? []).filter((r) => r.kind === 'point'), 'ref-point'],
  ['reference', (scene.references ?? []).filter((r) => r.kind === 'plane'), 'ref-plane'],
  ['space', scene.spaces, 'space'],
]) {
  const id = list?.[0]?.id;
  if (!id) { console.log('skip', name); continue; }
  await page.evaluate(([k, i]) => { window.__apexTest.clearSelection(); window.__apexTest.selectDatum(k, i); }, [kind, id]);
  await shoot(name);
}
await browser.close();
