/**
 * Close-up screenshots of the sample house plan symbols and 3D openings.
 *   APEX_SMOKE_URL=http://localhost:5173/ APEX_SAMPLE_OUT=/tmp/x node scripts/sample-closeups.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
const OUT = process.env.APEX_SAMPLE_OUT ?? '/tmp/apex-closeups';
const BASE = process.env.APEX_SMOKE_URL ?? 'http://localhost:5173/';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 })).newPage();
await page.addInitScript(() => {
  if (sessionStorage.getItem('apex.closeups')) return;
  sessionStorage.setItem('apex.closeups', '1');
  localStorage.clear();
  // Auto-load house on first visit (no dismissed flag).
});
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('canvas');
await page.waitForTimeout(1500);
// If auto-load did not run, click the button.
if ((await page.getByTestId('load-sample-project').count()) > 0) {
  await page.getByTestId('load-sample-project').click();
  await page.waitForTimeout(1200);
}
const nav = async (label) => {
  await page.locator('button', { hasText: new RegExp(`^${label}$`) }).first().click();
  await page.waitForTimeout(400);
};
const w2c = (p) => page.evaluate((q) => window.__apexTest.worldToClient(q), p);
const clip = async (name, center, half = 160) => {
  const [x, y] = await w2c(center);
  await page.screenshot({ path: `${OUT}/${name}.png`, clip: { x: x - half, y: y - half, width: 2 * half, height: 2 * half } });
};
await nav('Plan');
await nav('Fit');
const [cx, cy] = await w2c([5, 0, 4]);
await page.mouse.move(cx, cy);
for (let i = 0; i < 3; i += 1) { await page.mouse.wheel(0, -240); await page.waitForTimeout(60); }
await page.waitForTimeout(400);
await page.keyboard.press('Escape');
await page.mouse.move(5, 5);
await page.screenshot({ path: `${OUT}/plan-zoomed.png` });
await clip('plan-entrance-door', [2, 0, 0.3]);
await clip('plan-interior-door', [5, 0, 2]);
await clip('plan-partition', [5, 0, 4]);
await clip('plan-stair', [1, 0, 3.5], 220);
await clip('plan-kitchen-space', [7.5, 0, 6]);
await nav('3D');
await nav('Persp');
const views = [
  ['3d-door-entrance-out', [2, 1.05, 0], -Math.PI / 2 + 0.3, 0.15, 4],
  ['3d-door-entrance-in', [2, 1.05, 0], Math.PI / 2 + 0.3, 0.25, 4],
  ['3d-door-interior', [5, 1.05, 2], 0.3, 0.25, 4],
  ['3d-window-west-out', [0, 1.6, 4], Math.PI + 0.3, 0.15, 3.5],
  ['3d-window-west-in', [0, 1.6, 4], 0.3, 0.2, 3.5],
  ['3d-overview', [5, 4, 4], 0.9, 0.35, 28],
];
for (const [name, target, yaw, pitch, distance] of views) {
  await page.evaluate((c) => window.__apexTest.setCamera(c), { target, yaw, pitch, distance });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/${name}.png`, clip: { x: 200, y: 100, width: 900, height: 700 } });
}
await browser.close();
