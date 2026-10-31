/**
 * Bench path-anchor preview vs live setElementPlacement (the laggy path).
 * Usage: APEX_SMOKE_URL=http://localhost:5173/ node scripts/wall-node-drag-bench.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const BASE = process.env.APEX_SMOKE_URL ?? 'http://localhost:5173/';
const N = Number(process.env.RUNS ?? 40);
const OUT_DIR = '/cursor/stores/self/media/ap-28';
mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage();
await page.addInitScript(() => {
  try {
    localStorage.setItem('apex.gettingStarted.dismissed', '1');
  } catch {
    /* ignore */
  }
});
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.__apexTest?.loadSampleProject, null, {
  timeout: 60000,
});

const result = await page.evaluate(async (n) => {
  const mod = await import('/src/wasm/apex.ts');

  const pickMidWall = () => {
    const walls = mod.apexListElements().filter((e) => e.component_id === 'apex.wall');
    const mid =
      walls.find((e) => {
        const a = e.anchors?.[0];
        const b = e.anchors?.[1];
        if (!a || !b) return false;
        return Math.abs(a[0] - 5) < 0.2 && Math.abs(b[0] - 5) < 0.2;
      }) ?? walls[0];
    if (!mid) throw new Error('no walls');
    return mid;
  };

  const timed = (fn) => {
    const t0 = performance.now();
    for (let i = 0; i < n; i++) fn(i);
    return (performance.now() - t0) / n;
  };

  window.__apexTest.loadSampleProject();
  let mid = pickMidWall();
  let baseAnchors = (mid.anchors ?? []).map((p) => [...p]);
  const editEnd = (i) => {
    const pts = baseAnchors.map((p) => [...p]);
    const end = pts[pts.length - 1];
    end[0] += 0.02 * (i + 1);
    end[2] += 0.01 * (i + 1);
    return pts;
  };
  mod.apexSelectElement(mid.id);
  mod.apexPreviewPathAnchorEdit(mid.id, editEnd(0));

  const ghostMs = timed((i) => {
    mod.apexPreviewPathAnchorEdit(mid.id, editEnd(i));
  });
  const ghostSample = mod.apexPreviewPathAnchorEdit(mid.id, editEnd(n - 1));

  // Live mutate path (what previewAnchors used to do every pointermove).
  window.__apexTest.loadSampleProject();
  mid = pickMidWall();
  baseAnchors = (mid.anchors ?? []).map((p) => [...p]);
  mod.apexSelectElement(mid.id);
  mod.apexSetElementPlacement(mid.id, editEnd(0), 0, false);

  const liveMs = timed((i) => {
    mod.apexSetElementPlacement(mid.id, editEnd(i), 0, false);
  });

  // Commit correctness smoke: peer count / scene still builds after real edit.
  window.__apexTest.loadSampleProject();
  mid = pickMidWall();
  baseAnchors = (mid.anchors ?? []).map((p) => [...p]);
  mod.apexSelectElement(mid.id);
  const committed = mod.apexSetElementPlacement(mid.id, editEnd(20), 0, true);

  return {
    walls: mod.apexListElements().filter((e) => e.component_id === 'apex.wall').length,
    mover: mid.id,
    n,
    ghostMs: +ghostMs.toFixed(3),
    liveMutateMs: +liveMs.toFixed(3),
    speedup: +(liveMs / Math.max(ghostMs, 0.001)).toFixed(2),
    hideIds: ghostSample.hide_ids?.length ?? 0,
    ghostTris: Math.floor((ghostSample.indices?.length ?? 0) / 3),
    sceneTrisAfterCommit: Math.floor((committed.indices?.length ?? 0) / 3),
  };
}, N);

writeFileSync(`${OUT_DIR}/bench.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
await browser.close();
