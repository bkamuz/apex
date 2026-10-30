/**
 * Bench Move ghost preview on the house sample.
 * Usage: APEX_SMOKE_URL=http://localhost:5173/ node scripts/wall-move-preview-bench.mjs
 */
import { chromium } from 'playwright';

const BASE = process.env.APEX_SMOKE_URL ?? 'http://localhost:5173/';
const N = Number(process.env.RUNS ?? 60);

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.__apexTest?.loadSampleProject, null, {
  timeout: 60000,
});

const result = await page.evaluate(async (n) => {
  const mod = await import('/src/wasm/apex.ts');
  const ghost = await import('/src/tools/transformGhost.ts');

  window.__apexTest.loadSampleProject();

  const scene = mod.apexGetScene();
  const walls = mod.apexListElements().filter((e) => e.component_id === 'apex.wall');
  // Mid partition wall (x≈5) tends to stretch several peers.
  const mid =
    walls.find((e) => {
      const a = e.anchors?.[0];
      const b = e.anchors?.[1];
      if (!a || !b) return false;
      return Math.abs(a[0] - 5) < 0.2 && Math.abs(b[0] - 5) < 0.2;
    }) ?? walls[0];
  mod.apexSelectElement(mid.id);
  const originals = [{ kind: 'element', id: mid.id, anchors: mid.anchors ?? [] }];

  const warm = () => {
    ghost.buildTranslatedGhostMesh(scene, originals, [0.2, 0, 0]);
    mod.apexPreviewStretchTranslate([0.2, 0, 0]);
  };
  warm();

  const timed = (fn) => {
    const t0 = performance.now();
    for (let i = 0; i < n; i++) fn(i);
    return (performance.now() - t0) / n;
  };

  const moversMs = timed((i) => {
    ghost.buildTranslatedGhostMesh(scene, originals, [0.01 * i, 0, 0]);
  });
  const stretchMs = timed((i) => {
    mod.apexPreviewStretchTranslate([0.01 * i, 0, 0]);
  });
  const hybridMs = timed((i) => {
    const delta = [0.01 * i, 0, 0];
    const movers = ghost.buildTranslatedGhostMesh(scene, originals, delta);
    const stretch = mod.apexPreviewStretchTranslate(delta);
    let stretchMesh = null;
    if (stretch?.indices?.length) {
      stretchMesh = {
        positions: stretch.positions instanceof Float32Array ? stretch.positions : new Float32Array(stretch.positions),
        normals: stretch.normals instanceof Float32Array ? stretch.normals : new Float32Array(stretch.normals),
        indices: stretch.indices instanceof Uint32Array ? stretch.indices : new Uint32Array(stretch.indices),
      };
    }
    ghost.mergeGhostMeshes(movers, stretchMesh);
  });

  return {
    walls: walls.length,
    mover: mid.id,
    n,
    moversMs: +moversMs.toFixed(3),
    stretchMs: +stretchMs.toFixed(3),
    hybridMs: +hybridMs.toFixed(3),
    sceneTris: Math.floor((scene.indices?.length ?? 0) / 3),
  };
}, N);

console.log(JSON.stringify(result, null, 2));
await browser.close();
