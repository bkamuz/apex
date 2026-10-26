/**
 * Close-up screenshots of the sample project's plan symbols and 3D openings.
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
});
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('canvas');
await page.getByTestId('load-sample-project').click();
await page.waitForTimeout(800);
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
// Zoom in at the plan centre.
const [cx, cy] = await w2c([3, 0, 2.5]);
await page.mouse.move(cx, cy);
for (let i = 0; i < 3; i += 1) { await page.mouse.wheel(0, -240); await page.waitForTimeout(60); }
await page.waitForTimeout(400);
await page.keyboard.press('Escape');
await page.mouse.move(5, 5);
await page.screenshot({ path: `${OUT}/plan-zoomed.png` });
await clip('plan-south-door', [1.6, 0, 0.3]);
await clip('plan-interior-door', [3.5, 0, 3.8]);
await clip('plan-t-join-south', [3.5, 0, 0]);
await clip('plan-corner-se', [6, 0, 0]);
await clip('plan-stair', [5.2, 0, 2.4], 220);
await nav('3D');
await nav('Persp');
const views = [
  ['3d-door-south-out', [1.6, 1.0, 0], -Math.PI / 2 + 0.3, 0.15, 4],
  ['3d-door-south-in', [1.6, 1.0, 0], Math.PI / 2 + 0.3, 0.25, 4],
  ['3d-door-interior', [3.5, 1.0, 3.8], 0.3, 0.25, 4],
  ['3d-window-east-out', [6, 1.4, 2.5], 0.3, 0.15, 3.5],
  ['3d-window-east-in', [6, 1.4, 2.5], Math.PI + 0.3, 0.2, 3.5],
  ['3d-window-north-out', [1.75, 1.4, 5], Math.PI / 2 + 0.3, 0.15, 3.5],
  ['3d-overview', [3, 1.5, 2.5], 0.7, 0.6, 13],
];
for (const [name, target, yaw, pitch, distance] of views) {
  await page.evaluate((c) => window.__apexTest.setCamera(c), { target, yaw, pitch, distance });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/${name}.png`, clip: { x: 200, y: 100, width: 900, height: 700 } });
}
await browser.close();
