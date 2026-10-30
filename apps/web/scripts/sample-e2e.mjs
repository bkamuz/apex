/**
 * Hands-on check of the built-in sample house: two storeys, pitched roof,
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
  if ((counts.by['apex.roof.pitched'] ?? 0) < 1) note('missing pitched roof');
  if ((counts.by['apex.stair'] ?? 0) < 1) note('missing stair');
  if ((counts.by['apex.slab'] ?? 0) < 2) note(`expected ≥2 slabs, got ${counts.by['apex.slab']}`);
  if (counts.levels < 2) note(`expected 2 levels, got ${counts.levels}`);
  if (counts.spaces < 4) note(`expected ≥4 spaces, got ${counts.spaces}`);
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
const [cx, cy] = await w2c(2.5, 0, 4);
await page.mouse.move(cx, cy);
for (let i = 0; i < 4; i += 1) {
  await page.mouse.wheel(0, -240);
  await page.waitForTimeout(80);
}
await page.waitForTimeout(300);
const [cx2, cy2] = await w2c(2.5, 0, 4);
const drift = Math.hypot(cx2 - cx, cy2 - cy);
console.log(`  wheel zoom drift ${drift.toFixed(1)} px`);
if (drift > 6) note(`wheel zoom drifted ${drift.toFixed(1)} px from the cursor`);
await shot('plan-zoomed-living');
await nav('Fit');
const fit2 = await camera();
if (!(fit2.pitch > 1.4)) note('second Fit left Plan');

// Level 1 plan.
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
  ...[0, 1, 2, 3].map((k) => [`door-entrance-yaw${k}`, [2, 1.05, 0], (k * Math.PI) / 2 + 0.35, 0.3, 4.5]),
  ...[0, 1].map((k) => [`door-interior-yaw${k}`, [5, 1.05, 2], (k * Math.PI) / 2 + 0.35, 0.3, 4.5]),
  ...[0, 1].map((k) => [`window-west-yaw${k}`, [0, 1.6, 4], (k * Math.PI) / 2 + 0.35, 0.2, 4]),
  ['overview', [5, 4, 4], 0.9, 0.35, 28],
  ['gable', [5, 5, 4], 0.9 + Math.PI, 0.3, 24],
];
for (const [name, target, yaw, pitch, distance] of views) {
  await page.evaluate((c) => window.__apexTest.setCamera(c), { target, yaw, pitch, distance });
  await page.waitForTimeout(400);
  await shot(`3d-${name}`);
}

console.log(problems.length ? `PROBLEMS:\n- ${problems.join('\n- ')}` : 'sample checks passed');
await browser.close();
process.exit(problems.length ? 1 : 0);
