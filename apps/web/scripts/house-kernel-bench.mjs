// Browser timings for the two-storey house: full settle per kernel, then
// three edits (move a wall, swap a window's species, edit the roof), each
// timed until the external kernel has no pending jobs.
// Usage: APEX_URL=http://127.0.0.1:5173/ HOUSE=house.json node scripts/house-kernel-bench.mjs
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const BASE = process.env.APEX_URL ?? 'http://127.0.0.1:5173/';
const HOUSE = readFileSync(process.env.HOUSE ?? 'e2e_house.json', 'utf8');
const RUNS = Number(process.env.RUNS ?? 3);

const browser = await chromium.launch();
const results = {};
for (const kernel of ['mesh', 'smlib']) {
  const page = await browser.newPage();
  page.on('console', (m) => (m.type() === 'error' || m.text().startsWith('BENCH')) && console.log(`[${kernel}] console:`, m.text()));
  await page.addInitScript(() => localStorage.clear());
  await page.goto(`${BASE}?kernel=mesh`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__apexTest?.setKernel);
  results[kernel] = await page.evaluate(
    async ({ k, house, runs }) => {
      const mod = await import('/src/wasm/apex.ts');
      const settle = async () => {
        for (let i = 0; i < 4000 && mod.apexKernelStatus().pending > 0; i++) {
          await new Promise((r) => setTimeout(r, 2));
        }
      };
      const timed = async (f) => {
        const t0 = performance.now();
        f();
        await settle();
        const ms = performance.now() - t0;
        log('edit', ms, JSON.stringify(mod.apexKernelStatus()));
        return ms;
      };
      const log = (...a) => console.warn('BENCH', ...a);
      const out = { full: [], 'move wall': [], 'window species': [], 'roof overhang': [] };
      for (let run = 0; run < runs; run++) {
        log('import');
        mod.apexImportProject(house);
        log('imported');
        if (k !== 'mesh') window.__apexTest.setKernel('mesh');
        out.full.push(await timed(() => window.__apexTest.setKernel(k)));
        log('full', out.full.at(-1));
        const els = mod.apexListElements();
        const geo = (id) => mod.apexRunQuery({ op: 'element_geometry', id })?.bbox;
        const mid = els.find((e) => {
          if (e.component_id !== 'apex.wall') return false;
          const b = geo(e.id);
          return b && b.max[0] - b.min[0] < 0.5 && b.min[0] > 4 && b.min[1] < 1;
        });
        const win = els.find((e) => e.component_id === 'apex.window');
        const roof = els.find((e) => e.component_id === 'apex.roof.pitched');
        const ex = (c) => {
          const r = mod.apexExecuteCommand(c);
          if (r && r.ok === false) throw new Error(JSON.stringify(r));
        };
        out['move wall'].push(await timed(() => ex({ op: 'move_elements', ids: [mid.id], delta: [0.3, 0, 0] })));
        out['window species'].push(
          await timed(() => ex({ op: 'set_element_species', id: win.id, species: 'apex.window.double-1500x1400' })),
        );
        out['roof overhang'].push(await timed(() => ex({ op: 'update_element', id: roof.id, params: { overhang: 0.7 } })));
      }
      const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
      return Object.fromEntries(
        Object.entries(out).map(([n, a]) => [n, Math.round(med(a))]),
      );
    },
    { k: kernel, house: HOUSE, runs: RUNS },
  );
  await page.close();
}
console.log(JSON.stringify(results));
await browser.close();
