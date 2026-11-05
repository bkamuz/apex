/**
 * AP-62: before/after shots of grid-axis occlusion in 3D.
 *
 * Usage:
 *   LABEL=before OUT=/cursor/stores/self/media/ap-62 \
 *     node apps/web/scripts/ap62-axes-depth.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync, copyFileSync } from 'fs';

const OUT = process.env.OUT ?? '/cursor/stores/self/media/ap-62';
const ART = process.env.ART ?? '/opt/cursor/artifacts/ap-62';
const BASE = process.env.APEX_SMOKE_URL ?? 'http://localhost:5173/';
const LABEL = process.env.LABEL ?? 'shot';

mkdirSync(OUT, { recursive: true });
mkdirSync(ART, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
});

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

// Prefer 3D axon so axes-through-walls is obvious.
const axon = page.getByRole('button', { name: 'Axon', exact: true });
if ((await axon.count()) > 0) await axon.first().click();
const threeD = page.getByRole('button', { name: '3D', exact: true });
if ((await threeD.count()) > 0) await threeD.first().click();
await page.waitForTimeout(600);

const fit = page.getByRole('button', { name: 'Fit', exact: true });
if ((await fit.count()) > 0) {
  await fit.first().click();
  await page.waitForTimeout(500);
}

const full = `${OUT}/${LABEL}-3d-full.png`;
const crop = `${OUT}/${LABEL}-3d-viewport.png`;
await page.screenshot({ path: full, fullPage: false });

const canvas = page.getByTestId('viewport-canvas');
const box = await canvas.boundingBox();
if (box) {
  await page.screenshot({
    path: crop,
    clip: {
      x: Math.max(0, box.x),
      y: Math.max(0, box.y),
      width: box.width,
      height: box.height,
    },
  });
}

copyFileSync(full, `${ART}/${LABEL}-3d-full.png`);
if (box) copyFileSync(crop, `${ART}/${LABEL}-3d-viewport.png`);
console.log('saved', full, box ? crop : '(no crop)');
await browser.close();
