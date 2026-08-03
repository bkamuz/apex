import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const OUT = '/opt/cursor/artifacts/screenshots';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

page.on('console', (msg) => {
  if (msg.type() === 'error') console.log('CONSOLE', msg.type(), msg.text());
});
page.on('pageerror', (err) => console.log('PAGEERROR', err.message));

await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/apex-cad-01-load.png`, fullPage: true });

const brand = await page.locator('.brand').textContent();
console.log('brand:', brand);

const canvas = page.locator('canvas');
const box = await canvas.boundingBox();
if (!box) throw new Error('no canvas');

async function clickCanvas(nx, ny) {
  await page.mouse.click(box.x + box.width * nx, box.y + box.height * ny);
  await page.waitForTimeout(180);
}

// Draw a rectangular room with 4 walls (snap will quantize)
const corners = [
  [0.35, 0.55],
  [0.62, 0.55],
  [0.62, 0.72],
  [0.35, 0.72],
];
for (let i = 0; i < corners.length; i++) {
  const a = corners[i];
  const b = corners[(i + 1) % corners.length];
  await clickCanvas(a[0], a[1]);
  await clickCanvas(b[0], b[1]);
  await page.waitForTimeout(250);
}

await page.screenshot({ path: `${OUT}/apex-cad-02-walls.png`, fullPage: true });
const items = await page.locator('.element-list li').count();
console.log('elements after walls:', items);

await page.getByRole('button', { name: 'Select' }).click();
await page.waitForTimeout(200);
if (items > 0) {
  await page.locator('.element-list li').first().click();
  await page.waitForTimeout(300);
  const height = page.locator('input[type="number"]').first();
  await height.fill('4.0');
  await page.getByRole('button', { name: 'Apply' }).click();
  await page.waitForTimeout(400);
}
await page.screenshot({ path: `${OUT}/apex-cad-03-edit.png`, fullPage: true });

const badge = await page.locator('.viewport-badge').textContent();
console.log('badge:', badge);
console.log('done');
await browser.close();

if (items < 1) {
  process.exitCode = 1;
  console.error('expected at least one wall');
}
