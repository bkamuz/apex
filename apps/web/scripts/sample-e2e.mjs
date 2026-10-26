/**
 * Hands-on check of the built-in sample project: plan symbols, 3D openings,
 * boolean picking (column as B, Tab cycling), cursor-anchored wheel zoom and
 * Fit staying in Plan.
 *
 *   APEX_SMOKE_URL=http://localhost:5180/ APEX_SAMPLE_OUT=/tmp/sample node scripts/sample-e2e.mjs
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
});
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('canvas');
await page.getByTestId('load-sample-project').click();
await page.waitForTimeout(800);

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
const errorText = async () => {
  const b = page.locator('.error-banner');
  return (await b.count()) && (await b.first().isVisible()) ? await b.first().textContent() : '';
};

// Plan.
await nav('Plan');
await nav('Fit');
const afterFit = await camera();
if (!(afterFit.pitch > 1.4)) note(`Fit left Plan (pitch ${afterFit.pitch})`);
await shot('plan-fit');

// Wheel zoom anchored at the cursor: the world point under it must stay put.
const [cx, cy] = await w2c(2, 0, 2.5);
await page.mouse.move(cx, cy);
for (let i = 0; i < 4; i += 1) {
  await page.mouse.wheel(0, -240);
  await page.waitForTimeout(80);
}
await page.waitForTimeout(300);
const [cx2, cy2] = await w2c(2, 0, 2.5);
const drift = Math.hypot(cx2 - cx, cy2 - cy);
console.log(`  wheel zoom drift ${drift.toFixed(1)} px`);
if (drift > 6) note(`wheel zoom drifted ${drift.toFixed(1)} px from the cursor`);
await shot('plan-zoomed-at-column');
await nav('Fit');
const fit2 = await camera();
if (!(fit2.pitch > 1.4)) note('second Fit left Plan');

// Boolean: wall (A) − column (B), both picked in Plan.
await page.keyboard.press('Escape');
await page.locator('button', { hasText: /^Boolean$/ }).first().click();
await page.waitForTimeout(200);
const [ax, ay] = await w2c(0, 0, 1.0);
await page.mouse.move(ax, ay);
await page.mouse.click(ax, ay);
await page.waitForTimeout(200);
const [bx, by] = await w2c(2, 0, 2.5);
await page.mouse.move(bx, by);
await page.waitForTimeout(100);
await page.keyboard.press('Tab');
await page.keyboard.press('Shift+Tab');
await page.mouse.click(bx, by);
await page.waitForTimeout(500);
const err = await errorText();
if (err) note(`boolean B pick: ${err}`);
const bools = await page.evaluate(() =>
  JSON.parse(localStorage.getItem('apex.project') ?? '{}'),
);
console.log('  boolean error:', err || 'none');
await shot('plan-boolean-wall-minus-column');
await page.keyboard.press('Control+z');
await page.waitForTimeout(400);
void bools;

// 3D views of the openings.
await page.keyboard.press('Escape');
await nav('3D');
await nav('Fit');
await shot('3d-fit');
await nav('Persp');
const views = [
  ...[0, 1, 2, 3].map((k) => [`door-south-yaw${k}`, [1.6, 1.0, 0], (k * Math.PI) / 2 + 0.35, 0.3, 4.5]),
  ...[0, 1, 2, 3].map((k) => [`door-interior-yaw${k}`, [3.5, 1.0, 3.8], (k * Math.PI) / 2 + 0.35, 0.3, 4.5]),
  ...[0, 1, 2, 3].map((k) => [`window-east-yaw${k}`, [6, 1.4, 2.5], (k * Math.PI) / 2 + 0.35, 0.2, 4]),
  ...[0, 1, 2, 3].map((k) => [`window-north-yaw${k}`, [1.75, 1.4, 5], (k * Math.PI) / 2 + 0.35, 0.2, 4]),
  ['overview', [3, 1.5, 2.5], 0.7, 0.6, 13],
];
for (const [name, target, yaw, pitch, distance] of views) {
  await page.evaluate((c) => window.__apexTest.setCamera(c), { target, yaw, pitch, distance });
  await page.waitForTimeout(400);
  await shot(`3d-${name}`);
}

console.log(problems.length ? `PROBLEMS:\n- ${problems.join('\n- ')}` : 'sample checks passed');
await browser.close();
process.exit(problems.length ? 1 : 0);
