import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs';

const OUT = '/opt/cursor/artifacts/screenshots/ap-36';
const MEDIA = '/cursor/stores/self/media/ap-36';
mkdirSync(OUT, { recursive: true });
mkdirSync(MEDIA, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.addInitScript(() => {
  try {
    localStorage.setItem('apex.gettingStarted.dismissed', '1');
    localStorage.setItem('apex.geometryKernel', 'mesh');
  } catch {}
});
await page.goto('http://127.0.0.1:5173/?kernel=mesh', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__apexTest?.loadSampleProject, null, { timeout: 60000 });
await page.evaluate(() => {
  window.__apexTest.setKernel('mesh');
  window.__apexTest.loadSampleProject();
});
await page.waitForTimeout(1000);

function isWallFaceOpeningBand(y, a, b) {
  const bands = [0.88, 2.12, 2.32, 3.88, 5.12, 5.32];
  if (!bands.some((t) => Math.abs(y - t) < 0.04)) return false;
  // Exclude ramp/slab far east of house
  const x = (a[0] + b[0]) / 2;
  const z = (a[2] + b[2]) / 2;
  if (x > 10.5 || x < -1.5 || z > 9 || z < -2) return false;
  return true;
}

async function analyze() {
  return page.evaluate(({ isWallFaceOpeningBandSrc }) => {
    // eslint-disable-next-line no-new-func
    const isWallFaceOpeningBand = eval(`(${isWallFaceOpeningBandSrc})`);
    return (async () => {
      const mod = await import('/src/wasm/apex.ts');
      const scene = mod.apexGetScene();
      const edges = scene.edge_positions || [];
      const pos = scene.positions;
      const idx = scene.indices;
      const nrm = scene.normals;
      const longEdges = [];
      for (let i = 0; i + 5 < edges.length; i += 6) {
        const a = [edges[i], edges[i+1], edges[i+2]];
        const b = [edges[i+3], edges[i+4], edges[i+5]];
        const dx = Math.abs(a[0]-b[0]), dy = Math.abs(a[1]-b[1]), dz = Math.abs(a[2]-b[2]);
        const len = Math.hypot(dx, dy, dz);
        if (len < 1.5 || dy > 0.03) continue;
        const y = (a[1]+b[1])/2;
        if (!isWallFaceOpeningBand(y, a, b)) continue;
        if (dx > 0.08 && dz > 0.08) continue;
        longEdges.push({ y:+y.toFixed(3), len:+len.toFixed(3), a:a.map(v=>+v.toFixed(3)), b:b.map(v=>+v.toFixed(3)) });
      }
      const triSeams = [];
      if (pos && idx && nrm) {
        for (let t = 0; t + 2 < idx.length; t += 3) {
          const pts = [0,1,2].map((k) => {
            const i = idx[t+k];
            return [pos[i*3], pos[i*3+1], pos[i*3+2]];
          });
          const n = [nrm[idx[t]*3], nrm[idx[t]*3+1], nrm[idx[t]*3+2]];
          if (Math.abs(n[1]) >= 0.2 || (Math.abs(n[0]) < 0.85 && Math.abs(n[2]) < 0.85)) continue;
          for (const [u,v] of [[0,1],[1,2],[2,0]]) {
            const a = pts[u], b = pts[v];
            const dy = Math.abs(a[1]-b[1]);
            const len = Math.hypot(a[0]-b[0], a[2]-b[2], dy);
            if (dy > 0.02 || len < 1.5) continue;
            const y = (a[1]+b[1])/2;
            if (!isWallFaceOpeningBand(y, a, b)) continue;
            triSeams.push({ y:+y.toFixed(3), len:+len.toFixed(3), a:a.map(v=>+v.toFixed(3)), b:b.map(v=>+v.toFixed(3)) });
          }
        }
      }
      return { edgeCount: edges.length/6, longEdges, triSeams };
    })();
  }, { isWallFaceOpeningBandSrc: isWallFaceOpeningBand.toString() });
}

async function shot(name, cam) {
  await page.evaluate((c) => window.__apexTest.setCamera(c), cam);
  await page.waitForTimeout(500);
  const p = `${OUT}/${name}`;
  await page.screenshot({ path: p });
  copyFileSync(p, `${MEDIA}/${name}`);
}

const kitchenCam = { target: [7.5, 1.4, 0.15], distance: 8, yaw: 0.1, pitch: 0.1 };
await shot('10-fixed-before-kitchen.png', kitchenCam);
const before = await analyze();

const west = await page.evaluate(() => window.__apexTest.selectNear('wall', [0.2, 1.2, 4]));
await page.evaluate(
  (id) => window.__apexTest.command({ op: 'move_elements', ids: [id], delta: [-0.8, 0, -0.8] }),
  west,
);
await page.waitForTimeout(1200);
const after = await analyze();
await shot('11-fixed-after-corner-kitchen.png', kitchenCam);
await shot('12-fixed-after-corner-south.png', {
  target: [4, 1.3, -0.2], distance: 9, yaw: 0.15, pitch: 0.1,
});

const report = {
  west,
  before,
  after,
  ok: after.longEdges.length === 0 && after.triSeams.length === 0,
};
writeFileSync(`${MEDIA}/verify.json`, JSON.stringify(report, null, 2));
writeFileSync(`${OUT}/verify.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exit(1);
await browser.close();
