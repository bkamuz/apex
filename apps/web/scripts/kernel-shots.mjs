// Screenshots of a wall with a door and two windows under each kernel.
// Usage: APEX_URL=http://127.0.0.1:5173/ OUT=/tmp/shots node scripts/kernel-shots.mjs
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.APEX_URL ?? 'http://127.0.0.1:5173/';
const OUT = process.env.OUT ?? 'kernel-shots';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const results = {};
for (const kernel of ['mesh', 'smlib']) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('console', (m) => m.type() === 'error' && console.log(`[${kernel}] console:`, m.text()));
  await page.addInitScript(() => localStorage.clear());
  await page.goto(`${BASE}?kernel=${kernel}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__apexTest?.setKernel);
  const info = await page.evaluate(async (k) => {
    const mod = await import('/src/wasm/apex.ts');
    mod.apexCreateElement('apex.wall', [[0, 0, 0], [6, 0, 0]]);
    const wall = mod.apexListElements().filter((e) => e.component_id === 'apex.wall').pop().id;
    mod.apexCreateElementWithParent('apex.door', [[1, 0, 0]], wall, { width: 0.9, height: 2.1 });
    mod.apexCreateElementWithParent('apex.window', [[3.2, 0, 0]], wall, { width: 1.2, height: 1.4 });
    mod.apexCreateElementWithParent('apex.window', [[5, 0, 0]], wall, { width: 0.8, height: 1.2 });
    const t0 = performance.now();
    window.__apexTest.setKernel(k);
    for (let i = 0; i < 200 && mod.apexKernelStatus().pending > 0; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const ms = performance.now() - t0;
    mod.apexSelectElement(null);
    const scene = mod.apexGetScene();
    return {
      ms,
      status: mod.apexKernelStatus(),
      stats: window.__apexTest.kernelStats(),
      triangles: scene.indices.length / 3,
    };
  }, kernel);
  await page.getByTestId('view-3d').click();
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    window.__apexTest.setCamera({ target: [3, 1.2, 0], distance: 7.5, yaw: 0.45, pitch: 0.25 });
  });
  await page.waitForTimeout(600);
  await page.locator('canvas').first().screenshot({ path: `${OUT}/wall-openings-${kernel}.png` });
  results[kernel] = info;
  await page.close();
}
console.log(JSON.stringify(results, null, 2));
await browser.close();
