/**
 * Visual: drag a shared wall endpoint so joined peers stretch; screenshot mid-drag + after commit.
 * Usage: APEX_SMOKE_URL=http://localhost:5173/ OUT=... node scripts/wall-node-drag-demo.mjs
 */
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const BASE = process.env.APEX_SMOKE_URL ?? 'http://localhost:5173/';
const OUT = process.env.OUT ?? '/opt/cursor/artifacts/screenshots/ap-28';
const STORE = '/cursor/stores/self/media/ap-28';
mkdirSync(OUT, { recursive: true });
mkdirSync(STORE, { recursive: true });

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
await page.waitForTimeout(400);

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

// Select mid partition wall (x≈5).
const midId = await page.evaluate(() => window.__apexTest.selectNear('wall', [5, 1.5, 4]));
await page.waitForTimeout(150);

const anchors = await page.evaluate(async () => {
  const mod = await import('/src/wasm/apex.ts');
  const sel = mod.apexGetSelected();
  return sel?.anchors ?? null;
});
if (!anchors || anchors.length < 2) throw new Error(`no anchors for ${midId}`);

const end = anchors[anchors.length - 1];
const handle = await page.evaluate((pt) => window.__apexTest.worldToClient(pt), end);
if (!handle) throw new Error('worldToClient failed for endpoint');

const targetWorld = [end[0] + 1.2, end[1], end[2] + 0.8];
const target = await page.evaluate((pt) => window.__apexTest.worldToClient(pt), targetWorld);
if (!target) throw new Error('worldToClient failed for target');

const canvas = page.locator('canvas').first();
const box = await canvas.boundingBox();
if (!box) throw new Error('no canvas');

await page.screenshot({ path: `${OUT}/before.png` });
await page.screenshot({ path: `${STORE}/before.png` });

await page.mouse.move(handle[0], handle[1]);
await page.mouse.down();
await page.waitForTimeout(40);

const steps = 12;
for (let i = 1; i <= steps; i++) {
  const t = i / steps;
  const x = handle[0] + (target[0] - handle[0]) * t;
  const y = handle[1] + (target[1] - handle[1]) * t;
  await page.mouse.move(x, y);
  await page.waitForTimeout(25);
}

const midPath = `${OUT}/during-drag.png`;
await page.screenshot({ path: midPath });
await page.screenshot({ path: `${STORE}/during-drag.png` });

await page.mouse.up();
await page.waitForTimeout(400);

const afterPath = `${OUT}/after-commit.png`;
await page.screenshot({ path: afterPath });
await page.screenshot({ path: `${STORE}/after-commit.png` });

const check = await page.evaluate(async () => {
  const mod = await import('/src/wasm/apex.ts');
  const walls = mod.apexListElements().filter((e) => e.component_id === 'apex.wall');
  const mid = mod.apexGetSelected();
  return {
    selected: mid?.id ?? null,
    anchors: mid?.anchors ?? null,
    wallCount: walls.length,
  };
});

console.log(JSON.stringify({ midId, midPath, afterPath, check }, null, 2));
await browser.close();
