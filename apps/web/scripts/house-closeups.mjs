/**
 * 3D close-ups of a saved house project (windows, slab edges, stair).
 *   APEX_HOUSE_RESUME=project.json APEX_CLOSE_OUT=/tmp/x node scripts/house-closeups.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'fs';
const OUT = process.env.APEX_CLOSE_OUT ?? '/tmp/apex-house-close';
const BASE = process.env.APEX_SMOKE_URL ?? 'http://127.0.0.1:5173/';
const project = readFileSync(process.env.APEX_HOUSE_RESUME, 'utf8');
const shots = JSON.parse(process.env.APEX_CLOSE_SHOTS ?? '[]');
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
page.on('pageerror', (e) => console.log('page error', e.message));
await page.addInitScript((p) => {
  if (sessionStorage.getItem('apex.close')) return;
  sessionStorage.setItem('apex.close', '1');
  localStorage.clear();
  localStorage.setItem('apex.gettingStarted.dismissed', '1');
  localStorage.setItem('apex.project', p);
}, project);
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('canvas');
await page.waitForTimeout(1200);
await page.locator('[data-testid^="view-row-"]').filter({ hasText: /3D/ }).first().click();
await page.waitForTimeout(500);
await page.locator('button', { hasText: /^Persp$/ }).first().click();
await page.waitForTimeout(300);
for (const [name, cam] of shots) {
  await page.evaluate((c) => window.__apexTest.setCamera(c), cam);
  await page.waitForTimeout(300);
  await page.mouse.move(5, 5);
  await page.screenshot({ path: `${OUT}/${name}.png` });
}
const clicks = JSON.parse(process.env.APEX_CLOSE_CLICKS ?? '[]');
for (const [x, y] of clicks) {
  await page.mouse.click(x, y);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/click-${x}-${y}.png` });
}
await browser.close();
