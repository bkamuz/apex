/**
 * Visual demo: hover olive highlight + Tab cycle (no toolbar focus steal).
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

const hint = async () =>
  (await page.getByTestId('topbar-hint').textContent())?.replace(/\s+/g, ' ').trim();

const focusTag = async () =>
  page.evaluate(() => {
    const el = document.activeElement;
    if (!(el instanceof HTMLElement)) return null;
    return {
      tag: el.tagName,
      testId: el.getAttribute('data-testid'),
      label: el.getAttribute('aria-label') || el.textContent?.trim()?.slice(0, 40) || '',
    };
  });

// Click Select — focus lands on the toolbar button first (the bug report case).
await page.getByRole('button', { name: 'Select', exact: true }).click();
await page.waitForTimeout(80);
console.log('focus after Select click:', await focusTag());

await page.getByRole('button', { name: '3D', exact: true }).click();
await page.waitForTimeout(150);

// Face the exterior diagonal wall + door head-on so the olive wash is obvious.
await page.evaluate(() => {
  window.__apexTest.setCamera({
    target: [11.5, 1.15, 1.5],
    yaw: (-Math.PI * 3) / 4,
    pitch: -0.12,
    distance: 5.5,
  });
});
await page.waitForTimeout(400);

const canvas = page.locator('[data-testid="viewport-canvas"]').first();
const box = await canvas.boundingBox();
if (!box) throw new Error('no canvas');

// Probe a few points on the door leaf until wall+opening share the stack.
let aim = null;
let stack = [];
for (const pt of [
  [11.35, 1.1, 1.35],
  [11.3, 1.2, 1.3],
  [11.4, 0.9, 1.4],
  [11.25, 1.4, 1.25],
]) {
  const client = await page.evaluate((p) => window.__apexTest.worldToClient(p), pt);
  if (!client) continue;
  await page.mouse.move(client[0], client[1]);
  await page.waitForTimeout(120);
  const hits = await page.evaluate(({ x, y }) => window.__apexTest.pickCandidates(x, y), {
    x: client[0],
    y: client[1],
  });
  const cats = hits.map((h) => h.category);
  if (cats.includes('opening') && cats.includes('wall')) {
    aim = client;
    stack = hits;
    break;
  }
}
if (!aim) {
  aim = await page.evaluate(() => window.__apexTest.worldToClient([11.3, 1.1, 1.3]));
  stack = await page.evaluate(({ x, y }) => window.__apexTest.pickCandidates(x, y), {
    x: aim[0],
    y: aim[1],
  });
}

await page.mouse.move(aim[0], aim[1]);
await page.waitForTimeout(300);

console.log('stack:', JSON.stringify(stack));
console.log('hover hint:', await hint());
console.log('focus after hover:', await focusTag());
await saveBoth(page, '01-hover.png');

// Tab must cycle picks, NOT walk toolbar buttons.
const focusBeforeTab = await focusTag();
await page.keyboard.press('Tab');
await page.waitForTimeout(250);
const focusAfterTab = await focusTag();
console.log('tab1 hint:', await hint());
console.log('focus after Tab:', focusAfterTab);
await saveBoth(page, '02-tab-cycle.png');

if (
  focusBeforeTab &&
  focusAfterTab &&
  focusBeforeTab.tag === 'BUTTON' &&
  focusAfterTab.tag === 'BUTTON' &&
  focusBeforeTab.label !== focusAfterTab.label
) {
  console.error('FAIL: Tab moved toolbar focus', focusBeforeTab, '→', focusAfterTab);
  process.exitCode = 1;
} else {
  console.log('ok: Tab did not advance toolbar focus');
}

await page.keyboard.press('Tab');
await page.waitForTimeout(200);
console.log('tab2 hint:', await hint());
await saveBoth(page, '03-tab-cycle-2.png');

await page.keyboard.press('Shift+Tab');
await page.waitForTimeout(200);
console.log('shift-tab:', await hint());
await page.mouse.click(aim[0], aim[1]);
await page.waitForTimeout(350);
console.log('click hint:', await hint());
await saveBoth(page, '04-click-select.png');

const props = await page
  .locator('.sidebar-right, aside.inspector, [class*="propert"]')
  .first()
  .textContent()
  .catch(() => '');
console.log('props:', props?.replace(/\s+/g, ' ').slice(0, 180));

// Window stack
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

await page.mouse.move(aim[0], aim[1]);
await page.waitForTimeout(150);
await page.keyboard.press('Tab');
await page.waitForTimeout(100);
await page.keyboard.press('Shift+Tab');
await page.waitForTimeout(200);
await saveBoth(page, '08-shift-tab.png');

console.log(JSON.stringify({ out: OUT, media: MEDIA, stack }, null, 2));
await browser.close();
