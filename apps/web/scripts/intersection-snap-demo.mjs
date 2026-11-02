/**
 * Intersection snap demo + bench on the sample house: two grid axes crossing,
 * Wall tool, cursor ~9 px off the crossing → X marker at the exact point.
 * Usage: APEX_SMOKE_URL=http://127.0.0.1:5173/ OUT=dir node scripts/intersection-snap-demo.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'fs';

const BASE = process.env.APEX_SMOKE_URL ?? 'http://localhost:5173/';
const OUT = process.env.OUT ?? '/workspace/apex-snap-shots';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.addInitScript((LOCALE) => {
  localStorage.clear();
  localStorage.setItem('apex.gettingStarted.dismissed', '1');
  if (LOCALE) localStorage.setItem('apex.locale', LOCALE);
}, process.env.LOCALE ?? '');
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__apexTest?.loadSampleProject);
await page.evaluate(() => window.__apexTest.loadSampleProject());
await page.waitForTimeout(1500);
const cmd = (c) => page.evaluate((x) => window.__apexTest.command(x), c);

const elements = await page.evaluate(() => window.__apexTest.api.listElements());
const walls = (elements.elements ?? elements).filter?.((e) => e.component_id === 'apex.wall') ?? [];
console.log('walls in sample:', walls.length);

// Two crossing grid axes just outside the house, plus a wall axis crossing one.
const X = { p: [-2, 0, 3] };
await cmd({ op: 'create_grid_axis', points: [[-6, 0, 3], [4, 0, 3]] });
await cmd({ op: 'create_grid_axis', points: [[-2, 0, -4], [-2, 0, 9]] });
await page.evaluate(() => window.__apexTest.clearSelection());

async function useTool(name) {
  const btn = page.getByRole('button', { name, exact: true });
  if ((await btn.count()) === 0 || !(await btn.first().isVisible())) {
    for (const tab of await page.locator('.tools-tab').all()) {
      await tab.click();
      await page.waitForTimeout(50);
      if ((await btn.count()) > 0 && (await btn.first().isVisible())) break;
    }
  }
  await btn.first().click();
  await page.waitForTimeout(150);
}

const status = () => page.evaluate(() => document.body.innerText.match(/snap: \w+|привязка: \S+/)?.[0] ?? 'none');
const report = {};
// The sample opens in plan view; P toggles to 3D.
for (const view of ['plan', '3d']) {
  if (view === '3d') {
    await page.keyboard.press('p');
    await page.waitForTimeout(800);
    await page.evaluate(() =>
      window.__apexTest.setCamera({ target: [-2, 0, 3], yaw: 0.5, pitch: 0.9, distance: 16 }),
    );
    await page.waitForTimeout(400);
  }
  await useTool(process.env.WALL_TOOL ?? 'Wall');
  const c = await page.evaluate((p) => window.__apexTest.worldToClient(p), X.p);
  // Cursor 6 px right, 7 px down of the crossing: near both axes.
  await page.mouse.move(c[0] + 6, c[1] + 7);
  await page.waitForTimeout(400);
  const s1 = await status();
  await page.screenshot({
    path: `${OUT}/intersection-${view}.png`,
    clip: { x: c[0] - 220, y: c[1] - 160, width: 440, height: 320 },
  });
  await page.screenshot({ path: `${OUT}/intersection-${view}-full.png` });
  // Bench: 300 pointermoves around the crossing and along the house.
  await page.evaluate(() => window.__apexTest.resetSnapStats());
  for (let i = 0; i < 300; i++) {
    const a = (i / 300) * Math.PI * 8;
    await page.mouse.move(c[0] + Math.cos(a) * (5 + i), c[1] + Math.sin(a) * (5 + i * 0.5));
  }
  const st = await page.evaluate(() => window.__apexTest.snapStats());
  report[view] = { status: s1, calls: st.calls, avgMs: +(st.ms / st.calls).toFixed(4), maxMs: +st.maxMs.toFixed(3) };
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
}
const geom = await page.evaluate(() => {
  if (!document.querySelector('.plan')) {}
  return window.__apexTest.api.elementSnapGeometry([]);
});
writeFileSync(`${OUT}/snap-geometry.json`, JSON.stringify(geom));
console.log(JSON.stringify(report, null, 1), 'segments', geom.segments.length, 'points', geom.points.length);
await browser.close();
