// The two-storey test house under each kernel, plus close-ups of a
// roof/wall attach and a window frame; prints full-rebuild times.
// Usage: APEX_URL=http://127.0.0.1:5173/ HOUSE=house.json OUT=/tmp/shots \
//   node scripts/house-kernel-shots.mjs
// HOUSE: project JSON, e.g. from
//   APEX_DUMP=house.json cargo test -p apex-core --test kernel_scenes dump -- --ignored
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';

const BASE = process.env.APEX_URL ?? 'http://127.0.0.1:5173/';
const OUT = process.env.OUT ?? 'house-shots';
const HOUSE = readFileSync(process.env.HOUSE ?? 'e2e_house.json', 'utf8');
mkdirSync(OUT, { recursive: true });

const views = {
  house: { target: [5, 2.5, 4], distance: 22, yaw: 0.7, pitch: 0.42 },
  roof: { target: [0, 3, 0], distance: 5, yaw: 0.6, pitch: 0.3 },
  window: { target: [0, 1.5, 0], distance: 2.6, yaw: 0.35, pitch: 0.12 },
};

const browser = await chromium.launch();
const results = {};
for (const kernel of ['mesh', 'smlib']) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('console', (m) => m.type() === 'error' && console.log(`[${kernel}] console:`, m.text()));
  await page.addInitScript(() => localStorage.clear());
  await page.goto(`${BASE}?kernel=mesh`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__apexTest?.setKernel);
  const info = await page.evaluate(
    async ({ k, house }) => {
      const mod = await import('/src/wasm/apex.ts');
      mod.apexImportProject(house);
      const t0 = performance.now();
      window.__apexTest.setKernel(k);
      for (let i = 0; i < 2000 && mod.apexKernelStatus().pending > 0; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      const ms = performance.now() - t0;
      mod.apexSelectElement(null);
      const els = mod.apexListElements();
      const roof = els.find((e) => e.component_id === 'apex.roof.pitched');
      const win = els.find((e) => e.component_id === 'apex.window');
      const geo = (id) => mod.apexRunQuery({ op: 'element_geometry', id });
      const center = (id) => {
        const b = geo(id)?.bbox;
        return b ? b.min.map((v, i) => (v + b.max[i]) / 2) : null;
      };
      // Eave corner of the roof, where the attached walls meet it.
      const corner = (id) => {
        const b = geo(id)?.bbox;
        return b ? [b.min[0] + 1.2, b.min[1] + 0.2, b.min[2] + 1.2] : null;
      };
      return {
        ms,
        status: mod.apexKernelStatus(),
        validate: mod.apexRunQuery({ op: 'validate' }),
        elements: els.length,
        roof: roof && corner(roof.id),
        window: win && center(win.id),
        winGeo: win && geo(win.id),
      };
    },
    { k: kernel, house: HOUSE },
  );
  await page.getByTestId('view-3d').click();
  await page.waitForTimeout(400);
  for (const [name, cam] of Object.entries(views)) {
    const target =
      name === 'roof' && info.roof ? info.roof : name === 'window' && info.window ? info.window : cam.target;
    await page.evaluate((c) => window.__apexTest.setCamera(c), { ...cam, target });
    await page.waitForTimeout(700);
    await page.locator('canvas').first().screenshot({ path: `${OUT}/${name}-${kernel}.png` });
  }
  results[kernel] = { ms: info.ms, status: info.status, errors: info.validate?.errors, elements: info.elements, winGeo: info.winGeo, roof: info.roof, window: info.window };
  await page.close();
}
console.log(JSON.stringify(results, null, 2));
await browser.close();
