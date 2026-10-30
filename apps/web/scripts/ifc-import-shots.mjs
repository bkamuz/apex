/**
 * Capture IFC Open before/after screenshots for AP-21.
 *
 * Expects the Vite app at APEX_SMOKE_URL. Imports the given .ifc via the
 * Open file input and frames the 3D view.
 */
import { chromium } from 'playwright';
import { mkdirSync, copyFileSync, existsSync } from 'fs';
import { basename, resolve } from 'path';

const OUT = process.env.APEX_SMOKE_OUT ?? '/opt/cursor/artifacts/screenshots';
const MEDIA =
  process.env.APEX_IFC_MEDIA ??
  '/cursor/stores/bc-01a16d7d-837c-77fb-8314-11d75ba13086/media/ifc-ifcopenshell';
const BASE = process.env.APEX_SMOKE_URL ?? 'http://localhost:5173/';
const LABEL = process.env.APEX_IFC_LABEL ?? 'after';
const IFC_PATH = resolve(
  process.env.APEX_IFC_FILE ?? '/workspace/crates/apex-ifc/tests/fixtures/demo-box.ifc',
);

mkdirSync(OUT, { recursive: true });
mkdirSync(MEDIA, { recursive: true });

if (!existsSync(IFC_PATH)) {
  throw new Error(`missing IFC file: ${IFC_PATH}`);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('pageerror', (err) => console.log('PAGEERROR', err.message));

await page.addInitScript(() => {
  localStorage.removeItem('apex.project');
  localStorage.removeItem('apex.browser');
  localStorage.setItem('apex.gettingStarted.dismissed', '1');
});

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('canvas');
await page.waitForTimeout(800);

const fileInput = page.locator('input[type="file"][accept*=".ifc"], input[type="file"]').first();
await fileInput.setInputFiles(IFC_PATH);
// IFC-Lite tessellation + mesh ingest can take several seconds on public samples.
await page.waitForFunction(
  () => {
    const status = document.querySelector('[data-testid="status-line"], .status-line, footer');
    const text = status?.textContent ?? '';
    return /Opened IFC:|Opened IFC\b/i.test(text) || /error|fail/i.test(text);
  },
  { timeout: 120_000 },
).catch(() => {});
await page.waitForTimeout(800);

// Prefer a 3D view if a view tab exists.
const view3d = page.getByRole('button', { name: /3D|3d|Perspective/i }).first();
if ((await view3d.count()) > 0) {
  await view3d.click().catch(() => {});
  await page.waitForTimeout(400);
}

// Nudge orbit for a readable angle.
const canvas = page.getByTestId('viewport-canvas');
const box = await canvas.boundingBox();
if (box) {
  const cx = box.x + box.width * 0.55;
  const cy = box.y + box.height * 0.45;
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(cx + 120, cy + 40);
  await page.mouse.up({ button: 'middle' });
  await page.waitForTimeout(200);
  // Zoom out a bit (wheel)
  await page.mouse.wheel(0, 1200);
  await page.waitForTimeout(300);
}

const stem = basename(IFC_PATH).replace(/\.ifc$/i, '');
const name = `${LABEL}-${stem}.png`;
const outPath = `${OUT}/${name}`;
const mediaPath = `${MEDIA}/${name}`;
await page.screenshot({ path: outPath, fullPage: true });
copyFileSync(outPath, mediaPath);

const summary = await page.evaluate(() => {
  const status = document.querySelector('[data-testid="status-line"], .status-line, footer');
  return status?.textContent?.trim()?.slice(0, 240) ?? '';
});
console.log(JSON.stringify({ label: LABEL, file: IFC_PATH, outPath, mediaPath, summary }, null, 2));

await browser.close();
