/**
 * AP-69: short recording of mouse sweep with grid heads staying visible.
 */
import { chromium } from 'playwright';
import { mkdirSync, copyFileSync } from 'fs';

const OUT = process.env.OUT ?? '/cursor/stores/self/media/ap-69';
const ART = process.env.ART ?? '/opt/cursor/artifacts/ap-69';
const BASE = process.env.APEX_SMOKE_URL ?? 'http://localhost:5173/';

mkdirSync(OUT, { recursive: true });
mkdirSync(ART, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  recordVideo: { dir: ART, size: { width: 1440, height: 900 } },
});
const page = await context.newPage();

await page.addInitScript(() => {
  localStorage.removeItem('apex.project');
  localStorage.removeItem('apex.browser');
  localStorage.setItem('apex.gettingStarted.dismissed', '1');
  localStorage.setItem('apex.theme', 'light');
  localStorage.setItem('apex.locale', 'en');
});

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('canvas');
await page.waitForFunction(() => !!window.__apexTest?.loadSampleProject, null, {
  timeout: 60000,
});
await page.evaluate(() => {
  window.__apexTest.loadSampleProject();
  window.__apexTest.clearSelection?.();
});
await page.waitForTimeout(800);

const axon = page.getByRole('button', { name: 'Axon', exact: true });
if ((await axon.count()) > 0) await axon.first().click();
const threeD = page.getByRole('button', { name: '3D', exact: true });
if ((await threeD.count()) > 0) await threeD.first().click();
await page.waitForTimeout(500);
const fit = page.getByRole('button', { name: 'Fit', exact: true });
if ((await fit.count()) > 0) {
  await fit.first().click();
  await page.waitForTimeout(400);
}

const canvas = page.getByTestId('viewport-canvas');
const box = await canvas.boundingBox();
if (!box) throw new Error('no canvas box');

const before = await page.locator('.grid-axis-label').count();
const steps = 20;
for (let i = 0; i <= steps; i++) {
  const t = i / steps;
  const x = box.x + box.width * (0.2 + 0.6 * t);
  const y = box.y + box.height * (0.3 + 0.25 * Math.sin(t * Math.PI * 2));
  await page.mouse.move(x, y);
  await page.waitForTimeout(60);
}
await page.waitForTimeout(400);
const after = await page.locator('.grid-axis-label').count();
console.log(JSON.stringify({ before, after }));

await context.close();
await browser.close();

// Playwright writes webm under ART; rename the newest.
import { readdirSync, statSync, renameSync } from 'fs';
import { join } from 'path';
const files = readdirSync(ART)
  .filter((f) => f.endsWith('.webm'))
  .map((f) => ({ f, m: statSync(join(ART, f)).mtimeMs }))
  .sort((a, b) => b.m - a.m);
if (files[0]) {
  const src = join(ART, files[0].f);
  const destArt = join(ART, 'hover-heads-stay.webm');
  const destOut = join(OUT, 'hover-heads-stay.webm');
  renameSync(src, destArt);
  copyFileSync(destArt, destOut);
  console.log('saved', destOut);
}
if (after < Math.max(2, Math.floor(before * 0.5))) process.exit(1);
