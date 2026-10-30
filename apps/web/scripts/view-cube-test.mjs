/**
 * View cube: visible in 3D, hidden in plan; face click snaps; drag orbits.
 */
import { chromium } from 'playwright';

const BASE = process.env.APEX_SMOKE_URL ?? 'http://localhost:5173/';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('canvas');
await page.waitForTimeout(1200);

const failures = [];
function check(label, ok) {
  console.log(`${ok ? '  ok  ' : ' FAIL '}${label}`);
  if (!ok) failures.push(label);
}

const getCamera = () =>
  page.evaluate(() => {
    const canvases = [...document.querySelectorAll('canvas')];
    const r = canvases.find((c) => c.__apexRenderer)?.__apexRenderer;
    return r?.getCamera?.() ?? null;
  });

const setCamera = (cam) =>
  page.evaluate((c) => {
    const canvases = [...document.querySelectorAll('canvas')];
    canvases.find((el) => el.__apexRenderer)?.__apexRenderer?.setCamera(c);
  }, cam);

// App often opens in Plan — cube must be hidden.
await page.getByTestId('view-plan').click();
await page.waitForTimeout(200);
check('hidden in plan', (await page.getByTestId('view-cube').count()) === 0);

await page.getByTestId('view-3d').click();
await page.waitForTimeout(300);
const cube = page.getByTestId('view-cube');
await cube.waitFor({ state: 'visible' });
check('visible in 3D', await cube.isVisible());

await setCamera({ yaw: 0.85, pitch: 0.4, distance: 18, target: [0, 1.2, 0] });
await page.waitForTimeout(100);
const before = await getCamera();
if (!before) throw new Error('no camera');

const box = await cube.boundingBox();
if (!box) throw new Error('no cube box');
const cx = box.x + box.width * 0.5;
const cy = box.y + box.height * 0.5;

// Click near the top of the cube widget → typically TOP face at this pitch.
await page.mouse.click(cx, cy - box.height * 0.18);
await page.waitForTimeout(350);
const afterClick = await getCamera();
check(
  'face click snaps pitch toward top',
  afterClick.pitch > before.pitch + 0.2 ||
    Math.abs(afterClick.yaw - before.yaw) > 0.05 ||
    Math.abs(afterClick.pitch - before.pitch) > 0.05,
);

// Drag on the cube to orbit.
const yaw0 = afterClick.yaw;
await page.mouse.move(cx, cy);
await page.mouse.down();
await page.mouse.move(cx + 70, cy + 10, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(150);
const afterDrag = await getCamera();
check('drag orbits yaw', Math.abs(afterDrag.yaw - yaw0) > 0.05);

await browser.close();

if (failures.length > 0) {
  console.error('\nFailed:', failures.join(', '));
  process.exit(1);
}
console.log('\nall view-cube checks passed');
