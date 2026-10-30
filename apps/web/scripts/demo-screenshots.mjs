import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const OUT = '/opt/cursor/artifacts/screenshots';
const BASE = process.env.APEX_SMOKE_URL ?? 'http://localhost:5173/';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('dialog', (d) => d.accept());
await page.addInitScript(() => localStorage.removeItem('apex.gettingStarted.dismissed'));
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('canvas');
await page.waitForTimeout(800);

await page.getByRole('button', { name: 'New', exact: true }).click();
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/demo-01-getting-started.png`, fullPage: true });

await page.getByTestId('load-sample-project').click();
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/demo-02-sample-loaded.png`, fullPage: true });

await page.getByRole('button', { name: 'Plan', exact: true }).click();
await page.waitForTimeout(250);
await page.getByTestId('fit-view').click();
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/demo-03-plan-fit.png`, fullPage: true });

await page.getByRole('button', { name: 'New', exact: true }).click();
await page.waitForTimeout(300);
for (const tab of await page.locator('.tools-tab').all()) {
  await tab.click();
  if ((await page.getByRole('button', { name: 'Wall', exact: true }).count()) > 0) break;
}
await page.getByRole('button', { name: 'Wall', exact: true }).click();
const box = await page.locator('canvas').boundingBox();
const click = async (nx, ny) => {
  await page.mouse.click(box.x + box.width * nx, box.y + box.height * ny);
  await page.waitForTimeout(250);
};
await click(0.35, 0.5);
await click(0.55, 0.5);
await click(0.55, 0.65);
await page.screenshot({ path: `${OUT}/demo-04-wall-chain.png`, fullPage: true });

await page.getByRole('button', { name: 'Select', exact: true }).click();
await page.locator('[data-kind="instance"]').filter({ hasText: /^Wall/ }).first().click();
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/demo-05-wall-thickness.png`, fullPage: true });

await page.getByRole('button', { name: 'New', exact: true }).click();
await page.waitForTimeout(300);
await page.getByTestId('load-sample-project').click();
await page.waitForTimeout(1000);
if ((await page.locator('.level-list li').count()) < 2) {
  await page.getByRole('button', { name: '+ Level', exact: true }).click();
  await page.waitForTimeout(400);
}
await page.locator('.level-list li').nth(1).click();
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/demo-06-level-active.png`, fullPage: true });

const spaceItem = page.locator('[data-kind="space"]').first();
if ((await spaceItem.count()) > 0) {
  await spaceItem.click();
  await page.waitForTimeout(400);
}
await page.screenshot({ path: `${OUT}/demo-07-space-selected.png`, fullPage: true });

await page.getByRole('button', { name: 'Plan', exact: true }).click();
await page.waitForTimeout(250);
await page.getByTestId('fit-view').click();
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/demo-08-house-spaces-plan.png`, fullPage: true });

await browser.close();
console.log('demo screenshots saved to', OUT);
