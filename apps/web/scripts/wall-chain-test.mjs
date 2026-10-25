/**
 * Wall line tool chains segments until finish (unit-level behaviour via page.evaluate).
 */
import { chromium } from 'playwright';

const BASE = process.env.APEX_SMOKE_URL ?? 'http://localhost:5173/';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('canvas');
await page.waitForTimeout(800);

const countWalls = () =>
  page.locator('[data-kind="instance"]').filter({ hasText: /^Wall/ }).count();

await page.getByRole('button', { name: 'New', exact: true }).click();
await page.waitForTimeout(400);

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

await useTool('Wall');
await page.waitForTimeout(120);

const canvas = page.locator('canvas');
const box = await canvas.boundingBox();
if (!box) throw new Error('no canvas');

async function click(nx, ny) {
  await page.mouse.click(box.x + box.width * nx, box.y + box.height * ny);
  await page.waitForTimeout(350);
}

await click(0.35, 0.55);
await click(0.55, 0.55);
const afterTwo = await countWalls();
await click(0.55, 0.72);
const afterThree = await countWalls();

const failures = [];
if (afterTwo !== 1) failures.push(`expected 1 wall after 2 clicks, got ${afterTwo}`);
if (afterThree !== 2) failures.push(`expected 2 walls after 3 clicks (chain), got ${afterThree}`);

await browser.close();
if (failures.length) {
  console.error('FAIL', failures.join('; '));
  process.exit(1);
}
console.log('wall-chain test passed');
