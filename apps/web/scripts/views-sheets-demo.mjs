import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const OUT = process.env.APEX_DEMO_OUT ?? '/opt/cursor/artifacts/screenshots';
const BASE = process.env.APEX_SMOKE_URL ?? 'http://localhost:5173/';

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

await page.addInitScript(() => {
  localStorage.removeItem('apex.project');
  localStorage.removeItem('apex.documentTabs');
});

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="view-tab-bar"]', { timeout: 30000 });
await page.waitForTimeout(800);

await page.screenshot({ path: `${OUT}/views-01-tabs.png`, fullPage: true });
await page.getByTestId('views-sheets-panel').screenshot({ path: `${OUT}/views-02-browser.png` });

const split = page.getByTestId('toggle-split');
if (await split.isVisible()) {
  await split.click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/views-03-split.png`, fullPage: true });
}

await page.getByTestId('save-view').click();
await page.waitForTimeout(400);

await page.getByTestId('new-sheet').click();
await page.waitForTimeout(500);
await page.locator('[data-testid^="sheet-row-"]').first().dblclick();
await page.waitForTimeout(800);

const paper = page.locator('.sheet-paper');
await paper.waitFor({ state: 'visible' });
const paperBox = await paper.boundingBox();

async function dragViewToPaper(index, xFrac, yFrac) {
  const row = page.locator('[data-testid^="view-row-"]').nth(index);
  if ((await row.count()) === 0 || !paperBox) return;
  await row.dragTo(paper, {
    targetPosition: { x: paperBox.width * xFrac, y: paperBox.height * yFrac },
    sourcePosition: { x: 40, y: 12 },
  });
  await page.waitForTimeout(900);
}

if (paperBox) {
  await dragViewToPaper(0, 0.32, 0.55);
  await dragViewToPaper(1, 0.72, 0.55);
}

await page.screenshot({ path: `${OUT}/views-06-sheet-two-viewports.png`, fullPage: true });

const downloadPromise = page.waitForEvent('download', { timeout: 20000 }).catch(() => null);
await page.getByTestId('export-sheet-svg').click();
await page.waitForTimeout(3000);
const download = await downloadPromise;
if (download) {
  await download.saveAs(`${OUT}/demo-sheet.svg`);
}

console.log('Demo artifacts in', OUT);
await browser.close();
