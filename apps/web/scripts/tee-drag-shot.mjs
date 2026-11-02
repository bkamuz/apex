// Drag a T-abutting wall end along its host; screenshot mid-drag.
// Usage: APEX_SMOKE_URL=... OUT=dir NAME=prefix [KERNEL=mesh] node scripts/tee-drag-shot.mjs
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
const BASE = process.env.APEX_SMOKE_URL ?? 'http://localhost:5173/';
const OUT = process.env.OUT ?? '/tmp/tee-shots';
const NAME = process.env.NAME ?? 'tee';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.addInitScript(() => localStorage.setItem('apex.gettingStarted.dismissed', '1'));
const url = process.env.KERNEL ? `${BASE}?kernel=${process.env.KERNEL}` : BASE;
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.__apexTest?.loadSampleProject, null, { timeout: 60000 });
await page.evaluate(() => window.__apexTest.loadSampleProject());
await page.waitForTimeout(1500);
await page.evaluate(() => {
  const cam = window.__apexTest.getCamera();
  window.__apexTest.setCamera({ ...cam, pitch: -Math.PI / 2 + 0.02, yaw: 0, distance: 22, target: [5, 0, 4] });
});
await page.waitForTimeout(300);
await page.evaluate(() => window.__apexTest.selectNear('wall', [5, 1.5, 4]));
await page.waitForTimeout(300);
const anchors = await page.evaluate(async () => (await import('/src/wasm/apex.ts')).apexGetSelected()?.anchors);
const end = anchors[anchors.length - 1];
const h = await page.evaluate((p) => window.__apexTest.worldToClient(p), end);
const t = await page.evaluate((p) => window.__apexTest.worldToClient(p), [end[0] + 1.5, end[1], end[2]]);
await page.mouse.move(h[0], h[1]);
await page.mouse.down();
const times = [];
for (let i = 1; i <= 12; i++) {
  const t0 = Date.now();
  await page.mouse.move(h[0] + (t[0] - h[0]) * i / 12, h[1] + (t[1] - h[1]) * i / 12);
  await page.waitForTimeout(40);
  times.push(Date.now() - t0);
}
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/${NAME}-during-drag.png` });
await page.mouse.up();
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/${NAME}-after.png` });
const after = await page.evaluate(async () => {
  const m = await import('/src/wasm/apex.ts');
  return m.apexListElements().filter((e) => e.category === 'wall').map((e) => { m.apexSelectElement(e.id); return [e.name, m.apexGetSelected()?.anchors]; });
});
console.log(JSON.stringify({ anchors, end, times, after }));
await browser.close();
