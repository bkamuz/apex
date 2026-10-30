/**
 * Capture plan view screenshots for walkthrough / PR evidence.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.APEX_SMOKE_URL ?? 'http://localhost:5173/';
const OUT = process.env.APEX_SMOKE_OUT ?? '/opt/cursor/artifacts/screenshots';

fs.mkdirSync(OUT, { recursive: true });

const videoDir = '/opt/cursor/artifacts/plan-view-video';
fs.mkdirSync(videoDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1400, height: 900 },
  recordVideo: { dir: videoDir, size: { width: 1400, height: 900 } },
});
const page = await context.newPage();
await page.addInitScript(() => {
  if (!sessionStorage.getItem('apex.plan-demo')) {
    localStorage.removeItem('apex.project');
    localStorage.removeItem('apex.browser');
    sessionStorage.setItem('apex.plan-demo', '1');
  }
});

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('canvas');
await page.waitForTimeout(800);

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

const canvas = page.getByTestId('viewport-canvas');
const box = await canvas.boundingBox();
if (!box) throw new Error('no canvas');

const clickCanvas = async (fx, fy) => {
  await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
  await page.waitForTimeout(120);
};

// Place a simple rectangular room (4 walls).
await useTool('Wall');
await page.waitForTimeout(200);
for (const [fx, fy] of [
  [0.42, 0.48],
  [0.58, 0.48],
  [0.58, 0.62],
  [0.42, 0.62],
  [0.42, 0.48],
]) {
  await clickCanvas(fx, fy);
}
await page.keyboard.press('Enter');
await page.waitForTimeout(400);

await page.getByTestId('view-plan').click();
await page.waitForTimeout(600);
await page.screenshot({ path: path.join(OUT, 'plan-view-top-down.png'), fullPage: false });

// Grid axis on Basics for bubble labels.
await page.locator('.tools-tab').filter({ hasText: 'Basics' }).click();
await useTool('Grid axis');
await clickCanvas(0.35, 0.5);
await clickCanvas(0.65, 0.5);
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(OUT, 'plan-view-grid-axis.png'), fullPage: false });

await page.getByTestId('view-3d').click();
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(OUT, 'plan-view-back-to-3d.png'), fullPage: false });

const pitch = await page.evaluate(() => {
  const r = document.querySelector('[data-testid="viewport-canvas"]')?.__apexRenderer;
  return r?.getCamera?.()?.pitch ?? null;
});
const nav = await page.evaluate(
  () => document.querySelector('[data-testid="viewport-canvas"]')?.__apexRenderer?.getViewNavigation?.(),
);

console.log('plan pitch after 3d restore:', pitch);
console.log('view navigation:', nav);

await context.close();
await browser.close();
const videoPath = (await fs.promises.readdir(videoDir)).find((f) => f.endsWith('.webm'));
if (videoPath) {
  await fs.promises.rename(
    path.join(videoDir, videoPath),
    '/opt/cursor/artifacts/plan-view-demo.webm',
  );
}
console.log('screenshots written to', OUT);
