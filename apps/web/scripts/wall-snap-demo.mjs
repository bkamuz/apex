/**
 * Demo screenshots for joinable placement snap + connected stretch (AP-19).
 */
import { chromium } from 'playwright';
import { copyFileSync, mkdirSync } from 'fs';

const OUT = process.env.APEX_SMOKE_OUT ?? '/opt/cursor/artifacts/screenshots';
const MEDIA = '/cursor/stores/self/media/wall-snap';
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
await page.waitForTimeout(500);

const cmd = (c) => page.evaluate((command) => window.__apexTest.command(command), c);

// Place L-corner walls (exact coincident ends → join + later snap targets).
await cmd({
  op: 'create_element',
  component: 'apex.wall',
  points: [
    [0, 0, 0],
    [5, 0, 0],
  ],
});
await cmd({
  op: 'create_element',
  component: 'apex.wall',
  points: [
    [5, 0, 0],
    [5, 0, 4],
  ],
});

await page.evaluate(() => {
  window.__apexTest.setCamera({
    target: [2.5, 0, 2],
    yaw: 0.55,
    pitch: 0.95,
    distance: 14,
  });
});
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/wall-snap-l-joined.png`, fullPage: true });

const wallIds = await page.evaluate(() => {
  const items = [...document.querySelectorAll('[data-kind="instance"]')];
  return items.map((el) => ({
    id: el.getAttribute('data-id'),
    name: (el.textContent || '').trim(),
  }));
});
console.log('walls', wallIds);
const wallA = wallIds.find((e) => /Wall 1/.test(e.name))?.id;
const wallB = wallIds.find((e) => /Wall 2/.test(e.name))?.id;
if (!wallA || !wallB) throw new Error(`missing walls: ${JSON.stringify(wallIds)}`);

// Move Wall 1 in +Z; connected Wall 2 stretches (shared corner follows).
await cmd({ op: 'move_elements', ids: [wallA], delta: [0, 0, 2] });
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/wall-snap-stretch-after-move.png`, fullPage: true });

// T-junction onto the stretched wall A (now at z≈2).
await cmd({
  op: 'create_element',
  component: 'apex.wall',
  points: [
    [2.5, 0, 5],
    [2.5, 0, 2],
  ],
});
await page.evaluate(() => {
  window.__apexTest.setCamera({
    target: [2.5, 0, 2.5],
    yaw: -0.35,
    pitch: 1.0,
    distance: 16,
  });
});
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/wall-snap-t-and-stretch.png`, fullPage: true });

for (const name of [
  'wall-snap-l-joined.png',
  'wall-snap-stretch-after-move.png',
  'wall-snap-t-and-stretch.png',
]) {
  copyFileSync(`${OUT}/${name}`, `${MEDIA}/${name}`);
  console.log('wrote', `${MEDIA}/${name}`);
}

await browser.close();
console.log('wall-snap demo done');
