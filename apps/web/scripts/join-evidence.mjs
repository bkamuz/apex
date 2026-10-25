/**
 * Join evidence: closed room (L corners), center X, south T, east T — Fit + Plan/3D.
 * Usage: OUT_SUFFIX=-after node scripts/join-evidence.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const OUT = process.env.APEX_SMOKE_OUT ?? '/opt/cursor/artifacts/screenshots';
const SUFFIX = process.env.OUT_SUFFIX ?? '';
const BASE = process.env.APEX_SMOKE_URL ?? 'http://localhost:5173/';

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

await page.addInitScript(() => {
  localStorage.removeItem('apex.project');
  localStorage.removeItem('apex.browser');
});

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('canvas');
await page.waitForTimeout(1400);

const canvas = page.locator('canvas');
const box = await canvas.boundingBox();
if (!box) throw new Error('no canvas');

async function clickCanvas(nx, ny) {
  await page.mouse.click(box.x + box.width * nx, box.y + box.height * ny);
  await page.waitForTimeout(180);
}

async function useTool(name) {
  const btn = page.getByRole('button', { name, exact: true });
  if ((await btn.count()) === 0 || !(await btn.first().isVisible())) {
    for (const tab of await page.locator('.tools-tab').all()) {
      await tab.click();
      await page.waitForTimeout(50);
      if ((await btn.count()) > 0 && (await btn.first().isVisible())) break;
    }
  }
  await btn.click();
  await page.waitForTimeout(120);
}

async function placeWall(a, b) {
  await clickCanvas(a[0], a[1]);
  await clickCanvas(b[0], b[1]);
}

await page.getByTestId('tools-tab-apex.building').click();
await useTool('Wall');
await page.getByRole('button', { name: 'Line', exact: true }).click();

const x0 = 0.32;
const x1 = 0.6;
const z0 = 0.36;
const z1 = 0.64;
const xm = (x0 + x1) / 2;
const zm = (z0 + z1) / 2;

for (const [a, b] of [
  [[x0, z0], [x1, z0]],
  [[x1, z0], [x1, z1]],
  [[x1, z1], [x0, z1]],
  [[x0, z1], [x0, z0]],
]) {
  await placeWall(a, b);
}

await placeWall([x0, zm], [x1, zm]);
await placeWall([xm, z0], [xm, z1]);
await placeWall([xm, z1], [xm, 0.78]);
await placeWall([x1, zm], [0.82, zm]);
await placeWall([0.82, zm], [0.82, 0.46]);

await page.waitForTimeout(600);
await page.keyboard.press('Escape');
await page.keyboard.press('Escape');
await useTool('Select');
await clickCanvas(0.08, 0.08);
await page.waitForTimeout(200);

async function fitAndShot(name) {
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/${name}${SUFFIX}.png`, fullPage: false });
}

await fitAndShot('join-evidence-3d');
await page.getByTestId('view-plan').click();
await page.waitForTimeout(500);
await fitAndShot('join-evidence-plan');

await page.locator('[data-kind="instance"]').nth(4).click();
await page.waitForTimeout(350);
await page.screenshot({
  path: `${OUT}/join-evidence-inspector${SUFFIX}.png`,
  fullPage: false,
});

const count = await page.locator('[data-kind="instance"]').count();
console.log(`elements: ${count}, saved to ${OUT} suffix "${SUFFIX}"`);
if (count < 9) process.exitCode = 1;

await browser.close();
