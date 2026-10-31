/**
 * AP-27: prove hover/selection x-ray silhouette outline reads through
 * occluding geometry in 3D (and plan).
 *
 * Usage:
 *   APEX_SMOKE_URL=http://localhost:5173/ \
 *     OUT=/opt/cursor/artifacts/screenshots/ap-27 \
 *     node scripts/ap27-xray-outline-demo.mjs
 */
import { mkdirSync, copyFileSync } from 'node:fs';
import { chromium } from 'playwright';

const BASE = process.env.APEX_SMOKE_URL ?? 'http://localhost:5173/';
const OUT = process.env.OUT ?? '/opt/cursor/artifacts/screenshots/ap-27';
const MEDIA = '/cursor/stores/self/media/ap-27';
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

await page.getByRole('button', { name: 'Select', exact: true }).click().catch(() => {});
await page.getByRole('button', { name: '3D', exact: true }).click();
await page.waitForTimeout(200);

const hint = async () =>
  (await page.getByTestId('topbar-hint').textContent())?.replace(/\s+/g, ' ').trim();

const canvas = page.locator('[data-testid="viewport-canvas"]').first();
const box = await canvas.boundingBox();
if (!box) throw new Error('no canvas');

// --- 1) Hover stack: wall + door — olive x-ray outline on door behind wall face ---
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
await page.waitForTimeout(350);
let stack = await page.evaluate(({ x, y }) => window.__apexTest.pickCandidates(x, y), {
  x: aim[0],
  y: aim[1],
});
console.log('door stack:', JSON.stringify(stack));
console.log('hover hint:', await hint());
await saveBoth(page, '01-hover-wall-outline.png');

// Tab to door (typically behind / nested in the wall mesh stack).
await page.keyboard.press('Tab');
await page.waitForTimeout(300);
console.log('tab door hint:', await hint());
await saveBoth(page, '02-hover-door-xray.png');

await page.mouse.click(aim[0], aim[1]);
await page.waitForTimeout(350);
console.log('selected door:', await hint());
await saveBoth(page, '03-selected-door-outline.png');

// --- 2) Far north wall selected; camera south of house so south envelope occludes it ---
await page.evaluate(() => window.__apexTest.clearSelection?.());
await page.keyboard.press('Escape');
await page.waitForTimeout(100);

// North envelope wall (~z=8) — behind south facade from this camera.
const farWallId = await page.evaluate(() =>
  window.__apexTest.selectNear('wall', [5.0, 1.5, 8.0]),
);
console.log('selected far wall:', farWallId);

await page.evaluate(() => {
  window.__apexTest.setCamera({
    target: [5.0, 1.5, 4.0],
    yaw: 0, // look toward +Z: south wall in front, north wall buried
    pitch: -0.12,
    distance: 16,
  });
});
await page.waitForTimeout(450);
await saveBoth(page, '04-selected-far-wall-xray.png');

// Closer: south wall fills the frame; orange north-wall silhouette must punch through.
await page.evaluate(() => {
  window.__apexTest.setCamera({
    target: [5.0, 1.5, 2.0],
    yaw: 0.05,
    pitch: -0.05,
    distance: 9,
  });
});
await page.waitForTimeout(400);
await saveBoth(page, '05-selected-far-wall-through-south.png');

// --- 3) Plan: hover + selection outline ---
await page.getByRole('button', { name: 'Plan', exact: true }).click();
await page.waitForTimeout(300);
await page.getByRole('button', { name: 'Fit', exact: true }).click().catch(() => {});
await page.waitForTimeout(400);
await page.evaluate(() => window.__apexTest.clearSelection?.());
await page.keyboard.press('Escape');
await page.waitForTimeout(100);

const planAim = await page.evaluate(() => window.__apexTest.worldToClient([5.0, 0.05, 4.0]));
if (planAim) {
  await page.mouse.move(planAim[0], planAim[1]);
  await page.waitForTimeout(350);
  console.log('plan hover:', await hint());
  await saveBoth(page, '06-plan-hover-outline.png');
  await page.keyboard.press('Tab');
  await page.waitForTimeout(250);
  console.log('plan tab:', await hint());
  await saveBoth(page, '07-plan-tab-outline.png');
  await page.mouse.click(planAim[0], planAim[1]);
  await page.waitForTimeout(300);
  await saveBoth(page, '08-plan-selected-outline.png');
}

// Restore 3D and re-prove buried hover via Tab behind near wall.
await page.getByRole('button', { name: '3D', exact: true }).click();
await page.waitForTimeout(200);
await page.evaluate(() => window.__apexTest.clearSelection?.());
await page.evaluate(() => {
  window.__apexTest.setCamera({
    target: [11.3, 1.1, 1.3],
    yaw: -Math.PI * 0.55,
    pitch: -0.22,
    distance: 7.5,
  });
});
await page.waitForTimeout(350);
aim = await page.evaluate(() => window.__apexTest.worldToClient([11.3, 1.05, 1.3]));
if (aim) {
  await page.mouse.move(aim[0], aim[1]);
  await page.waitForTimeout(200);
  await page.keyboard.press('Tab'); // Door behind/in wall
  await page.waitForTimeout(300);
  console.log('final door hover:', await hint());
  await saveBoth(page, '09-hover-door-xray-final.png');
}

console.log(JSON.stringify({ out: OUT, media: MEDIA, stack, farWallId }, null, 2));
await browser.close();
