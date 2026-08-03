import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const OUT = '/opt/cursor/artifacts/screenshots';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

page.on('console', (msg) => console.log('CONSOLE', msg.type(), msg.text()));
page.on('pageerror', (err) => console.log('PAGEERROR', err.message));

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/apex-01-load.png`, fullPage: true });

const brand = await page.locator('.brand').textContent();
console.log('brand:', brand);

const canvas = page.locator('canvas');
const box = await canvas.boundingBox();
if (!box) throw new Error('no canvas');

// Place wall: two clicks on viewport
await page.mouse.click(box.x + box.width * 0.35, box.y + box.height * 0.55);
await page.waitForTimeout(200);
await page.mouse.click(box.x + box.width * 0.65, box.y + box.height * 0.55);
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/apex-02-wall.png`, fullPage: true });

const items = await page.locator('.element-list li').count();
console.log('elements after wall:', items);

await page.getByRole('button', { name: 'Select' }).click();
await page.waitForTimeout(200);
if (items > 0) {
  await page.locator('.element-list li').first().click();
  await page.waitForTimeout(300);
  const height = page.locator('input[type="number"]').first();
  await height.fill('4.5');
  await page.getByRole('button', { name: 'Apply' }).click();
  await page.waitForTimeout(400);
}
await page.screenshot({ path: `${OUT}/apex-03-edit.png`, fullPage: true });

const selectedName = await page.locator('.inspector-body').textContent();
console.log('inspector:', selectedName?.slice(0, 200));

await browser.close();
console.log('done');
