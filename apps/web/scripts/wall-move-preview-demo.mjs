/**
 * Visual smoke: load house, Move a mid wall with stretch peers, screenshot.
 * Usage: APEX_SMOKE_URL=http://localhost:5173/ OUT=/opt/cursor/artifacts/screenshots node scripts/wall-move-preview-demo.mjs
 */
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const BASE = process.env.APEX_SMOKE_URL ?? 'http://localhost:5173/';
const OUT = process.env.OUT ?? '/opt/cursor/artifacts/screenshots';
mkdirSync(OUT, { recursive: true });
mkdirSync('/cursor/stores/self/media/wall-move-perf', { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.addInitScript(() => {
  try {
    localStorage.setItem('apex.gettingStarted.dismissed', '1');
  } catch {
    /* ignore */
  }
});
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.__apexTest?.loadSampleProject, null, { timeout: 60000 });
await page.evaluate(() => window.__apexTest.loadSampleProject());
await page.waitForTimeout(500);

// Plan-ish top view
await page.evaluate(() => {
  const cam = window.__apexTest.getCamera();
  if (cam) {
    window.__apexTest.setCamera({
      ...cam,
      pitch: -Math.PI / 2 + 0.02,
      yaw: 0,
      distance: 22,
      target: [5, 0, 4],
    });
  }
});
await page.waitForTimeout(200);

const midId = await page.evaluate(() => window.__apexTest.selectNear('wall', [5, 1.5, 4]));
await page.keyboard.press('m');
await page.waitForTimeout(100);

const canvas = page.locator('canvas').first();
const box = await canvas.boundingBox();
if (!box) throw new Error('no canvas');

const worldToClient = async (p) =>
  page.evaluate((pt) => window.__apexTest.worldToClient(pt), p);

const base = await worldToClient([5, 0, 4]);
const target = await worldToClient([5.8, 0, 4]);
if (!base || !target) throw new Error('worldToClient failed');

await page.mouse.click(base[0], base[1]);
await page.waitForTimeout(50);
// Drag preview path (pointer moves before second click)
for (let i = 1; i <= 8; i++) {
  const t = i / 8;
  const x = base[0] + (target[0] - base[0]) * t;
  const y = base[1] + (target[1] - base[1]) * t;
  await page.mouse.move(x, y);
  await page.waitForTimeout(30);
}
const previewPath = `${OUT}/wall-move-preview.png`;
await page.screenshot({ path: previewPath });
await page.screenshot({ path: '/cursor/stores/self/media/wall-move-perf/wall-move-preview.png' });

await page.mouse.click(target[0], target[1]);
await page.waitForTimeout(300);
const afterPath = `${OUT}/wall-move-after.png`;
await page.screenshot({ path: afterPath });
await page.screenshot({ path: '/cursor/stores/self/media/wall-move-perf/wall-move-after.png' });

console.log(JSON.stringify({ midId, previewPath, afterPath }, null, 2));
await browser.close();
