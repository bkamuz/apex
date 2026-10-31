/**
 * Visual demo: Revit-like hover + Tab cycle + click select on stacked hits
 * (door/window nested in a wall from the sample house), in 3D.
 *
 * Usage:
 *   APEX_SMOKE_URL=http://127.0.0.1:5173/ OUT=/opt/cursor/artifacts/screenshots/tab-pick \
 *     node scripts/tab-pick-demo.mjs
 */
import { mkdirSync, copyFileSync } from 'node:fs';
import { chromium } from 'playwright';

const BASE = process.env.APEX_SMOKE_URL ?? 'http://127.0.0.1:5173/';
const OUT = process.env.OUT ?? '/opt/cursor/artifacts/screenshots/tab-pick';
const MEDIA = '/cursor/stores/self/media/tab-pick';
mkdirSync(OUT, { recursive: true });
mkdirSync(MEDIA, { recursive: true });

async function saveBoth(page, name) {
  const a = `${OUT}/${name}`;
  const b = `${MEDIA}/${name}`;
  await page.screenshot({ path: a });
  try {
    copyFileSync(a, b);
  } catch {
    /* ignore */
  }
  return a;
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('pageerror', (err) => console.log('PAGEERROR', err.message));

await page.addInitScript(() => {
  try {
    localStorage.removeItem('apex.project');
    localStorage.setItem('apex.gettingStarted.dismissed', '1');
  } catch {
    /* ignore */
  }
});

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.__apexTest?.loadSampleProject, null, {
  timeout: 60000,
});
await page.evaluate(() => window.__apexTest.loadSampleProject());
await page.waitForTimeout(1000);

await page.evaluate(() => window.__apexTest.clearSelection?.());
await page.keyboard.press('Escape');
await page.waitForTimeout(80);

// Select tool + 3D navigation.
await page.getByRole('button', { name: 'Select', exact: true }).click().catch(() => {});
await page.getByRole('button', { name: '3D', exact: true }).click();
await page.waitForTimeout(200);

const hint = async () =>
  (await page.getByTestId('topbar-hint').textContent())?.replace(/\s+/g, ' ').trim();

const canvas = page.locator('[data-testid="viewport-canvas"]').first();
const box = await canvas.boundingBox();
if (!box) throw new Error('no canvas');

// Diagonal wall + door (east of house) — reliable multi-hit stack in 3D.
await page.evaluate(() => {
  window.__apexTest.setCamera({
    target: [11.3, 1.1, 1.3],
    yaw: -Math.PI * 0.55,
    pitch: -0.22,
    distance: 7.5,
  });
});
await page.waitForTimeout(400);

let aim = await page.evaluate(() => window.__apexTest.worldToClient([11.3, 1.05, 1.3]));
if (!aim) throw new Error('worldToClient failed');

await page.mouse.move(aim[0], aim[1]);
await page.waitForTimeout(300);

let stack = await page.evaluate(({ x, y }) => window.__apexTest.pickCandidates(x, y), {
  x: aim[0],
  y: aim[1],
});
console.log('door stack:', JSON.stringify(stack));
console.log('hover hint:', await hint());
await saveBoth(page, '01-hover.png');

const px = aim[0];
const py = aim[1];

await page.keyboard.press('Tab');
await page.waitForTimeout(250);
console.log('tab1 hint:', await hint());
await saveBoth(page, '02-tab-cycle.png');

await page.keyboard.press('Tab');
await page.waitForTimeout(250);
console.log('tab2 hint:', await hint());
await saveBoth(page, '03-tab-cycle-2.png');

// Shift+Tab back to Door, then click to commit selection (orange).
await page.keyboard.press('Shift+Tab');
await page.waitForTimeout(200);
console.log('shift-tab to door:', await hint());
await page.mouse.click(px, py);
await page.waitForTimeout(350);
console.log('click hint:', await hint());
await saveBoth(page, '04-click-select.png');

const props = await page.locator('.sidebar-right, aside.inspector, [class*="propert"]').first().textContent().catch(() => '');
console.log('props:', props?.replace(/\s+/g, ' ').slice(0, 180));

// Window on south wall [7.5, 0].
await page.evaluate(() => window.__apexTest.clearSelection?.());
await page.evaluate(() => {
  window.__apexTest.setCamera({
    target: [7.5, 1.4, 0.0],
    yaw: Math.PI * 0.12,
    pitch: -0.3,
    distance: 8,
  });
});
await page.waitForTimeout(300);
const win = await page.evaluate(() => window.__apexTest.worldToClient([7.5, 1.45, 0.08]));
if (win) {
  await page.mouse.move(win[0], win[1]);
  await page.waitForTimeout(250);
  const wstack = await page.evaluate(({ x, y }) => window.__apexTest.pickCandidates(x, y), {
    x: win[0],
    y: win[1],
  });
  console.log('window stack:', JSON.stringify(wstack));
  console.log('win hover:', await hint());
  await saveBoth(page, '05-window-hover.png');
  await page.keyboard.press('Tab');
  await page.waitForTimeout(200);
  console.log('win tab:', await hint());
  await saveBoth(page, '06-window-tab.png');
  await page.mouse.click(win[0], win[1]);
  await page.waitForTimeout(300);
  await saveBoth(page, '07-window-select.png');
}

await page.mouse.move(px, py);
await page.waitForTimeout(150);
await page.keyboard.press('Tab');
await page.waitForTimeout(100);
await page.keyboard.press('Shift+Tab');
await page.waitForTimeout(200);
console.log('shift-tab:', await hint());
await saveBoth(page, '08-shift-tab.png');

console.log(JSON.stringify({ out: OUT, media: MEDIA, stack }, null, 2));
await browser.close();
