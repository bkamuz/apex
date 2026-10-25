import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const OUT = process.env.APEX_SMOKE_OUT ?? '/opt/cursor/artifacts/screenshots';
const BASE = process.env.APEX_SMOKE_URL ?? 'http://localhost:5173/';

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('canvas');
await page.waitForTimeout(1200);

const canvas = page.locator('canvas');
const box = await canvas.boundingBox();
if (!box) throw new Error('no canvas');

async function clickCanvas(nx, ny) {
  await page.mouse.click(box.x + box.width * nx, box.y + box.height * ny);
  await page.waitForTimeout(160);
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

await page.getByTestId('tools-tab-apex.building').click();
await useTool('Wall');
// L corner + T stem
await clickCanvas(0.35, 0.55);
await clickCanvas(0.55, 0.55);
await clickCanvas(0.55, 0.55);
await clickCanvas(0.55, 0.72);
await clickCanvas(0.45, 0.72);
await clickCanvas(0.45, 0.55);

await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/join-demo-3d-after.png`, fullPage: false });

await page.getByTestId('view-plan').click();
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/join-demo-plan-after.png`, fullPage: false });

await browser.close();
console.log('saved join demo to', OUT);
