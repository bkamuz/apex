/**
 * Manual UI flow for sheet drawing regression (no window.apex shortcuts).
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const OUT = process.env.APEX_DEMO_OUT ?? '/opt/cursor/artifacts/screenshots';
const VIDEO_DIR = process.env.APEX_DEMO_OUT || '/tmp/sheete2e';
const BASE = process.env.APEX_SMOKE_URL ?? 'http://localhost:5173/';

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1400, height: 900 },
  recordVideo: { dir: VIDEO_DIR, size: { width: 1400, height: 900 } },
});
const page = await context.newPage();

page.on('dialog', async (dialog) => {
  if (dialog.type() === 'prompt') {
    await dialog.accept('E2E note');
  } else {
    await dialog.dismiss();
  }
});

await page.addInitScript(() => {
  if (sessionStorage.getItem('apex.sheet-e2e')) return;
  sessionStorage.setItem('apex.sheet-e2e', '1');
  localStorage.removeItem('apex.project');
  localStorage.removeItem('apex.documentTabs');
});

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('canvas');
await page.waitForTimeout(1000);

const canvas = page.locator('canvas').first();
const box = await canvas.boundingBox();
if (!box) throw new Error('no main viewport canvas');

async function clickCanvas(nx, ny) {
  await page.mouse.click(box.x + box.width * nx, box.y + box.height * ny);
  await page.waitForTimeout(180);
}

async function useTool(name) {
  const btn = page.getByRole('button', { name, exact: true });
  if ((await btn.count()) === 0 || !(await btn.first().isVisible())) {
    for (const tab of await page.locator('.tools-tab').all()) {
      await tab.click();
      await page.waitForTimeout(60);
      if ((await btn.count()) > 0 && (await btn.first().isVisible())) break;
    }
  }
  await btn.first().click();
  await page.waitForTimeout(140);
}

// 1. Walls
await page.getByTestId('tools-tab-apex.building').click();
await useTool('Wall');
await page.getByRole('button', { name: 'Line', exact: true }).click();
await clickCanvas(0.3, 0.55);
await clickCanvas(0.62, 0.55);
await clickCanvas(0.62, 0.55);
await clickCanvas(0.62, 0.72);
await clickCanvas(0.62, 0.72);
await clickCanvas(0.3, 0.72);
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/e2e-01-walls-in-viewport.png`, fullPage: true });

// 2. Plan view + annotations
await page.getByTestId('new-plan-view').click();
await page.waitForTimeout(400);
const planRow = page.locator('[data-testid^="view-row-"]').filter({ hasText: /Plan/i }).first();
await planRow.click();
await page.waitForTimeout(600);
const planDocTab = page.locator('.view-tab-open').filter({ hasText: /Plan/i }).first();
if ((await planDocTab.count()) > 0) {
  await planDocTab.click();
  await page.waitForTimeout(400);
}
await page.screenshot({ path: `${OUT}/e2e-02-plan-view-open.png`, fullPage: true });

const annotateTab = page.getByTestId('tools-tab-apex.annotate');
if ((await annotateTab.count()) > 0) {
  await annotateTab.click();
  await useTool('Dimension');
  await clickCanvas(0.3, 0.55);
  await clickCanvas(0.62, 0.55);
  await useTool('Dimension');
  await clickCanvas(0.62, 0.55);
  await clickCanvas(0.62, 0.72);
  await useTool('Text');
  await clickCanvas(0.45, 0.63);
  await page.waitForTimeout(500);
}
await page.screenshot({ path: `${OUT}/e2e-03-plan-with-dimensions.png`, fullPage: true });

// 3. Sheet with ISO size + viewports
await page.getByTestId('new-sheet-paper-size').selectOption('A2');
await page.getByTestId('new-sheet-paper-orientation').selectOption('portrait');
await page.getByTestId('new-sheet').click();
await page.waitForTimeout(500);
await page.locator('[data-testid^="sheet-row-"]').first().dblclick();
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}/e2e-04-empty-sheet-a2.png`, fullPage: true });

const sheetNumber = await page.locator('[data-testid^="sheet-row-"]').first().textContent();
if (!sheetNumber?.includes('S-101')) {
  console.error('FAIL: expected default sheet number S-101, got', sheetNumber);
  process.exitCode = 1;
}

const paper = page.locator('.sheet-paper');
await paper.waitFor({ state: 'visible' });
const paperBox = await paper.boundingBox();
const views = page.locator('[data-testid^="view-row-"]');
const planView = views.nth(0);
const threeDView = views.nth(1);
if (paperBox) {
  if ((await planView.count()) > 0) {
    await planView.dragTo(paper, {
      targetPosition: { x: paperBox.width * 0.38, y: paperBox.height * 0.52 },
      sourcePosition: { x: 40, y: 12 },
    });
    await page.waitForTimeout(1200);
  }
  if ((await threeDView.count()) > 0) {
    await threeDView.dragTo(paper, {
      targetPosition: { x: paperBox.width * 0.72, y: paperBox.height * 0.52 },
      sourcePosition: { x: 40, y: 12 },
    });
    await page.waitForTimeout(1200);
  }
}
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}/e2e-05-sheet-with-viewports.png`, fullPage: true });

const paperSelect = page.getByTestId('sheet-properties-paper-size');
const paperValue = await paperSelect.inputValue();
if (paperValue !== 'A2') {
  console.error('FAIL: sheet toolbar paper should be A2, got', paperValue);
  process.exitCode = 1;
}

// Sample sheet viewport canvas — should not be solid black
const sheetCanvas = page.locator('.sheet-viewport-canvas').first();
const sheetBox = await sheetCanvas.boundingBox();
if (sheetBox) {
  const shot = await sheetCanvas.screenshot();
  mkdirSync(`${OUT}`, { recursive: true });
  const fs = await import('fs');
  fs.writeFileSync(`${OUT}/e2e-05-sheet-viewport-canvas.png`, shot);
  let dark = 0;
  let light = 0;
  for (let i = 0; i < shot.length; i += 4) {
    const r = shot[i];
    const g = shot[i + 1];
    const b = shot[i + 2];
    const a = shot[i + 3];
    if (a < 8) continue;
    if (r < 30 && g < 30 && b < 30) dark += 1;
    if (r > 200 && g > 200 && b > 200) light += 1;
  }
  console.log('viewport pixel sample dark', dark, 'light', light);
  if (dark > light * 4) {
    console.error('FAIL: sheet viewport appears mostly black');
    process.exitCode = 1;
  }
}

const stored = await page.evaluate(() => localStorage.getItem('apex.project'));
console.log('stored project bytes', stored?.length ?? 0, 'has sheets', stored?.includes('"sheets"'));

// Reload persistence
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(2000);
const rowCount = await page.locator('[data-testid^="sheet-row-"]').count();
console.log('sheet rows after reload', rowCount);
if (rowCount > 0) {
  const sheetTab = page.locator('.view-tab-open').filter({ hasText: /Sheet|▦/ }).first();
  if ((await sheetTab.count()) > 0) {
    await sheetTab.click();
  } else {
    await page.locator('[data-testid^="sheet-row-"]').first().dblclick();
  }
  await page.waitForTimeout(1000);
  await page.getByTestId('sheet-workspace').waitFor({ state: 'visible', timeout: 15000 });
} else {
  console.warn('WARN: no sheets in browser after reload — check project import');
}
await page.screenshot({ path: `${OUT}/e2e-06-after-reload-sheet.png`, fullPage: true });

await context.close();
await browser.close();
console.log('E2E artifacts in', OUT);
