/**
 * Hands-on check of the built-in sample house: two storeys, flat roofs,
 * Spaces/rooms, plan Fit, and 3D opening views.
 *
 *   APEX_SMOKE_URL=http://localhost:5173/ APEX_SAMPLE_OUT=/tmp/sample node scripts/sample-e2e.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const OUT = process.env.APEX_SAMPLE_OUT ?? '/tmp/apex-sample';
const BASE = process.env.APEX_SMOKE_URL ?? 'http://localhost:5173/';
mkdirSync(OUT, { recursive: true });
const problems = [];
const note = (m) => (console.log('  !! ' + m), problems.push(m));

const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
page.on('pageerror', (e) => note(`page error: ${e.message}`));
await page.addInitScript(() => {
  if (sessionStorage.getItem('apex.sample-e2e')) return;
  sessionStorage.setItem('apex.sample-e2e', '1');
  localStorage.clear();
  // Skip auto-load so we exercise the Getting Started button explicitly.
  localStorage.setItem('apex.gettingStarted.dismissed', '1');
});
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('canvas');
await page.waitForTimeout(600);

// Empty project + Getting Started, then load the house via the button.
await page.evaluate(() => localStorage.removeItem('apex.gettingStarted.dismissed'));
await page.getByRole('button', { name: 'New', exact: true }).click();
await page.waitForTimeout(500);
const loadBtn = page.getByTestId('load-sample-project');
if ((await loadBtn.count()) === 0 || !(await loadBtn.isVisible())) {
  note('Getting Started load button missing after New');
  // Fallback: reload with auto-load enabled.
  await page.evaluate(() => {
    localStorage.removeItem('apex.project');
    localStorage.removeItem('apex.gettingStarted.dismissed');
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('canvas');
  await page.waitForTimeout(2000);
} else {
  await loadBtn.click();
  await page.waitForTimeout(2000);
}

let n = 0;
const shot = async (name) => {
  n += 1;
  const p = `${OUT}/${String(n).padStart(2, '0')}-${name}.png`;
  await page.screenshot({ path: p });
  console.log('  shot', p);
};
const w2c = (x, y, z) => page.evaluate((p) => window.__apexTest.worldToClient(p), [x, y, z]);
const camera = () => page.evaluate(() => window.__apexTest.getCamera());
const nav = async (label) => {
  await page.locator('button', { hasText: new RegExp(`^${label}$`) }).first().click();
  await page.waitForTimeout(500);
};

const counts = await page.evaluate(() => {
  const raw = localStorage.getItem('apex.project');
  if (!raw) return null;
  const j = JSON.parse(raw);
  const els = Object.values(j.document?.elements ?? j.elements ?? {});
  const by = {};
  for (const e of els) by[e.component_id] = (by[e.component_id] ?? 0) + 1;
  const spaces = Object.values(j.document?.spaces ?? j.spaces ?? {});
  const levels = j.document?.levels ?? j.levels ?? [];
  return {
    by,
    spaces: spaces.length,
    levels: Array.isArray(levels) ? levels.length : Object.keys(levels).length,
    spaceNames: spaces.map((s) => s.name ?? s.params?.label).filter(Boolean),
  };
});
console.log('  counts:', JSON.stringify(counts));
if (!counts) note('no project in localStorage after sample load');
else {
  if ((counts.by['apex.wall'] ?? 0) < 10) note(`expected many walls, got ${counts.by['apex.wall']}`);
  if ((counts.by['apex.roof'] ?? 0) < 2) note(`expected ≥2 flat roofs, got ${counts.by['apex.roof']}`);
  if ((counts.by['apex.column'] ?? 0) < 2) note(`expected columns under the cantilever, got ${counts.by['apex.column']}`);
  if ((counts.by['apex.stair'] ?? 0) < 1) note('missing stair');
  if ((counts.by['apex.slab'] ?? 0) < 2) note(`expected ≥2 slabs, got ${counts.by['apex.slab']}`);
  if ((counts.by['apex.site_line'] ?? 0) < 6) note(`expected ≥6 site lines, got ${counts.by['apex.site_line']}`);
  if ((counts.by['apex.gate'] ?? 0) < 1) note('missing gate');
  if ((counts.by['apex.site_surface'] ?? 0) < 3)
    note(`expected ≥3 site surfaces, got ${counts.by['apex.site_surface']}`);
  if ((counts.by['apex.terrain'] ?? 0) < 1) note('missing terrain');
  if (counts.levels < 3) note(`expected 3 levels, got ${counts.levels}`);
  if (counts.spaces < 10) note(`expected ≥10 spaces, got ${counts.spaces}`);
}

const spaceLabels = await page.locator('.space-label').count();
console.log('  space overlay labels:', spaceLabels);
if (spaceLabels < 2) note(`expected space labels visible, got ${spaceLabels}`);

// Plan.
await nav('Plan');
await nav('Fit');
const afterFit = await camera();
if (!(afterFit.pitch > 1.4)) note(`Fit left Plan (pitch ${afterFit.pitch})`);
await shot('plan-fit');

// Wheel zoom anchored at living-room centre.
const [cx, cy] = await w2c(9, 0, 3.5);
await page.mouse.move(cx, cy);
for (let i = 0; i < 4; i += 1) {
  await page.mouse.wheel(0, -240);
  await page.waitForTimeout(80);
}
await page.waitForTimeout(300);
const [cx2, cy2] = await w2c(9, 0, 3.5);
const drift = Math.hypot(cx2 - cx, cy2 - cy);
console.log(`  wheel zoom drift ${drift.toFixed(1)} px`);
if (drift > 6) note(`wheel zoom drifted ${drift.toFixed(1)} px from the cursor`);
await shot('plan-zoomed-living');
await nav('Fit');
const fit2 = await camera();
if (!(fit2.pitch > 1.4)) note('second Fit left Plan');

// Level 1 plan.
await page.getByTestId('browser-tab-views').click(); // levels live in the Виды tab
const levelRows = page.locator('.level-list li');
if ((await levelRows.count()) >= 2) {
  await levelRows.nth(1).click();
  await page.waitForTimeout(400);
  await nav('Fit');
  await shot('plan-l1');
  await levelRows.nth(0).click();
  await page.waitForTimeout(300);
}

// 3D views of openings and the house.
await page.keyboard.press('Escape');
await nav('3D');
await nav('Fit');
await shot('3d-fit');
await nav('Persp');
const views = [
  ...[0, 1, 2, 3].map((k) => [`door-entrance-yaw${k}`, [2, 1.2, 0], (k * Math.PI) / 2 + 0.35, 0.3, 5]),
  ...[0, 1].map((k) => [`window-living-yaw${k}`, [9, 1.4, 0], (k * Math.PI) / 2 + 0.35, 0.22, 8]),
  ...[0, 1].map((k) => [`cantilever-yaw${k}`, [5, 2.2, -2], (k * Math.PI) / 2 + 0.4, 0.28, 12]),
  ['overview', [6, 3, 4], 0.85, 0.42, 32],
  ['yard', [8, 1.2, -2], 2.4, 0.38, 28],
];
for (const [name, target, yaw, pitch, distance] of views) {
  await page.evaluate((c) => window.__apexTest.setCamera(c), { target, yaw, pitch, distance });
  await page.waitForTimeout(400);
  await shot(`3d-${name}`);
}

console.log(problems.length ? `PROBLEMS:\n- ${problems.join('\n- ')}` : 'sample checks passed');
await browser.close();
process.exit(problems.length ? 1 : 0);
