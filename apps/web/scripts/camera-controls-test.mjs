/**
 * Camera control regression: RMB orbit, MMB pan, wheel zoom, and capture isolation.
 * Uses canvas.__apexRenderer.getCamera() (see ViewportRenderer constructor).
 */
import { chromium } from 'playwright';

const BASE = process.env.APEX_SMOKE_URL ?? 'http://localhost:5173/';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('canvas');
await page.waitForTimeout(1200);

const getCamera = () =>
  page.evaluate(() => {
    const r = document.querySelector('canvas')?.__apexRenderer;
    return r?.getCamera?.() ?? null;
  });

const canvas = page.locator('canvas');
const box = await canvas.boundingBox();
if (!box) throw new Error('no canvas');

const cx = box.x + box.width * 0.5;
const cy = box.y + box.height * 0.5;

const failures = [];
function check(label, ok) {
  console.log(`${ok ? '  ok  ' : ' FAIL '}${label}`);
  if (!ok) failures.push(label);
}

const before = await getCamera();
if (!before) throw new Error('__apexRenderer not attached');

// RMB orbit
await page.mouse.move(cx, cy);
await page.mouse.down({ button: 'right' });
await page.mouse.move(cx + 120, cy + 80, { steps: 12 });
await page.mouse.up({ button: 'right' });
await page.waitForTimeout(200);
const afterRmb = await getCamera();
check('RMB orbit changes yaw', Math.abs(afterRmb.yaw - before.yaw) > 0.01);

// MMB pan
await page.mouse.move(cx, cy);
await page.mouse.down({ button: 'middle' });
await page.mouse.move(cx + 80, cy + 50, { steps: 10 });
await page.mouse.up({ button: 'middle' });
await page.waitForTimeout(200);
const afterMmb = await getCamera();
check(
  'MMB pan moves target',
  Math.hypot(afterMmb.target[0] - afterRmb.target[0], afterMmb.target[2] - afterRmb.target[2]) >
    0.001,
);

// Wheel zoom
await page.mouse.wheel(0, -400);
await page.waitForTimeout(200);
const afterWheel = await getCamera();
check('Wheel zoom changes distance', Math.abs(afterWheel.distance - afterMmb.distance) > 0.01);

// React must not release ViewportRenderer capture on LMB pointerup during RMB drag.
await page.mouse.move(cx, cy);
await page.mouse.down({ button: 'right' });
await page.mouse.move(cx + 40, cy + 20, { steps: 3 });
const yawOrbitStart = (await getCamera()).yaw;
await page.evaluate(() => {
  const canvas = document.querySelector('canvas');
  canvas.dispatchEvent(
    new PointerEvent('pointerup', {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: 2,
      pointerId: 1,
      pointerType: 'mouse',
      clientX: 100,
      clientY: 100,
    }),
  );
});
await page.mouse.move(cx + 120, cy + 80, { steps: 8 });
const yawAfterChord = (await getCamera()).yaw;
await page.mouse.up({ button: 'right' });
check(
  'RMB orbit survives unrelated LMB pointerup',
  Math.abs(yawAfterChord - yawOrbitStart) > 0.05,
);

await browser.close();

if (failures.length > 0) {
  console.error('\nFailed:', failures.join(', '));
  process.exit(1);
}

console.log('\nall camera checks passed');
