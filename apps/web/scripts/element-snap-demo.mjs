/**
 * Demo screenshots for shared element snap (AP-38).
 * Acceptance: slab vertex drag snaps to wall end / mid / edge.
 */
import { chromium } from 'playwright';
import { copyFileSync, mkdirSync } from 'fs';

const OUT = process.env.APEX_SMOKE_OUT ?? '/opt/cursor/artifacts/screenshots';
const MEDIA = '/cursor/stores/self/media/ap-38';
const BASE = process.env.APEX_SMOKE_URL ?? 'http://localhost:5173/';

mkdirSync(OUT, { recursive: true });
mkdirSync(MEDIA, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

await page.addInitScript(() => {
  localStorage.removeItem('apex.project');
  localStorage.removeItem('apex.browser');
  localStorage.setItem('apex.gettingStarted.dismissed', '1');
});

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('canvas');
await page.waitForFunction(() => window.__apexTest?.command);
await page.waitForTimeout(400);

const cmd = (c) => page.evaluate((command) => window.__apexTest.command(command), c);

// Wall along X from (0,0,0)→(8,0,0) — snap sources: ends, mid, edge.
await cmd({
  op: 'create_element',
  component: 'apex.wall',
  points: [
    [0, 0, 0],
    [8, 0, 0],
  ],
});
// Orthogonal wall for context.
await cmd({
  op: 'create_element',
  component: 'apex.wall',
  points: [
    [0, 0, 0],
    [0, 0, 6],
  ],
});
// Slab with a free corner near the wall (will drag toward wall snaps).
await cmd({
  op: 'create_element',
  component: 'apex.slab',
  points: [
    [1, 0, 1.5],
    [5, 0, 1.5],
    [5, 0, 5],
    [1, 0, 5],
  ],
});

await page.evaluate(() => {
  window.__apexTest.setCamera({
    target: [4, 0, 2.5],
    yaw: 0,
    pitch: Math.PI / 2 - 0.02,
    distance: 14,
  });
});
await page.waitForTimeout(300);

const slabId = await page.evaluate(() => window.__apexTest.selectLast('apex.slab'));
if (!slabId) throw new Error('slab not created');
await page.waitForTimeout(200);

// Activate Select tool.
await page.keyboard.press('v');
await page.waitForTimeout(100);

const handles = await page.evaluate(() => window.__apexTest.getEditHandles());
console.log('handles', handles);
if (!handles || handles.length < 4) throw new Error(`expected slab handles, got ${JSON.stringify(handles)}`);

// Corner nearest the wall (smallest z among those with x≈1).
const corner = handles.reduce((best, h) => {
  const score = h[2] + Math.abs(h[0] - 1) * 0.01;
  if (!best || score < best.score) return { h, score };
  return best;
}, null).h;
console.log('drag corner', corner);

async function dragToward(worldTarget, shotName, expectKind) {
  const from = await page.evaluate((p) => window.__apexTest.worldToClient(p), corner);
  const to = await page.evaluate((p) => window.__apexTest.worldToClient(p), worldTarget);
  if (!from || !to) throw new Error(`worldToClient failed ${shotName}`);
  console.log(shotName, { from, to, expectKind });

  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  // Approach in steps so snap can engage.
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = from[0] + (to[0] - from[0]) * t;
    const y = from[1] + (to[1] - from[1]) * t;
    await page.mouse.move(x, y);
    await page.waitForTimeout(30);
  }
  await page.waitForTimeout(120);

  const status = await page.locator('.topbar .info span, header .info span, [class*="status"] span').first().textContent().catch(() => '');
  const bodyText = await page.evaluate(() => document.body.innerText);
  console.log('status snippet', (status || '').slice(0, 120));
  const snapped = /snap:\s*(end|mid|edge|vertex|point)/i.test(bodyText);
  console.log('snap visible in UI?', snapped, expectKind);

  await page.screenshot({ path: `${OUT}/${shotName}.png`, fullPage: true });
  copyFileSync(`${OUT}/${shotName}.png`, `${MEDIA}/${shotName}.png`);
  console.log('wrote', `${MEDIA}/${shotName}.png`);

  await page.mouse.up();
  await page.waitForTimeout(100);
  // Undo the committed drag so the next shot starts from the same slab.
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(150);
  await page.evaluate((id) => {
    // re-select slab (undo may clear selection)
    const hit = window.__apexTest.selectLast('apex.slab');
    return hit ?? id;
  }, slabId);
  await page.keyboard.press('v');
  await page.waitForTimeout(200);
}

// Wall end at (0,0,0), mid at (4,0,0), edge near (2.5,0,0).
await dragToward([0.05, 0, 0.05], 'snap-slab-to-wall-end', 'end');
await dragToward([4, 0, 0.05], 'snap-slab-to-wall-mid', 'mid');
await dragToward([2.5, 0, 0.05], 'snap-slab-to-wall-edge', 'edge');

// Placement snap: start placing another slab near the wall end.
await page.keyboard.press('Escape');
await page.waitForTimeout(100);
const placeBtn = page.locator('button', { hasText: /Slab|Плита/i }).first();
if (await placeBtn.count()) {
  await placeBtn.click();
} else {
  // Fall back: activate via tool registry if labeled differently.
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => /slab|плит/i.test(b.textContent || ''));
    btn?.click();
  });
}
await page.waitForTimeout(150);
const endClient = await page.evaluate(() => window.__apexTest.worldToClient([0, 0, 0]));
const nearEnd = await page.evaluate(() => window.__apexTest.worldToClient([0.15, 0, 0.15]));
if (endClient && nearEnd) {
  await page.mouse.move(nearEnd[0], nearEnd[1]);
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}/snap-place-near-wall-end.png`, fullPage: true });
  copyFileSync(`${OUT}/snap-place-near-wall-end.png`, `${MEDIA}/snap-place-near-wall-end.png`);
  console.log('wrote', `${MEDIA}/snap-place-near-wall-end.png`);
}

await browser.close();
console.log('element-snap demo done');
