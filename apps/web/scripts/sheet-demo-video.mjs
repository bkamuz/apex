import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const OUT = '/opt/cursor/artifacts';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1400, height: 900 },
  recordVideo: { dir: OUT, size: { width: 1400, height: 900 } },
});
const page = await context.newPage();

await page.addInitScript(() => {
  localStorage.removeItem('apex.project');
  localStorage.removeItem('apex.documentTabs');
});

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="view-tab-bar"]', { timeout: 30000 });
await page.waitForTimeout(500);

await page.getByTestId('save-view').click();
await page.waitForTimeout(300);
await page.getByTestId('new-sheet').click();
await page.waitForTimeout(400);
await page.locator('[data-testid^="sheet-row-"]').first().dblclick();
await page.waitForTimeout(700);

const paper = page.locator('.sheet-paper');
await paper.waitFor({ state: 'visible' });
const paperBox = await paper.boundingBox();
const viewRow = page.locator('[data-testid^="view-row-"]').first();
if (paperBox && (await viewRow.count()) > 0) {
  await viewRow.dragTo(paper, {
    targetPosition: { x: paperBox.width * 0.45, y: paperBox.height * 0.5 },
    sourcePosition: { x: 40, y: 12 },
  });
  await page.waitForTimeout(1000);
}

await page.locator('.sheet-viewport').first().click();
await page.waitForTimeout(500);
const scaleSelect = page.getByTestId('viewport-scale-select');
if (await scaleSelect.isVisible()) {
  await scaleSelect.selectOption('50');
  await page.waitForTimeout(800);
  await scaleSelect.selectOption('100');
  await page.waitForTimeout(800);
}

await page.waitForTimeout(500);
await context.close();
await browser.close();

console.log('Video written to', OUT);
