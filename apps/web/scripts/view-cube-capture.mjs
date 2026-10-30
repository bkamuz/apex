/**
 * Capture view-cube proof shots: face-on (all 6) + isometric angles.
 * Face-on shots must show a square face with horizontal upright text.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.APEX_SMOKE_URL ?? 'http://localhost:5173/';
const OUT = process.env.APEX_CUBE_OUT ?? '/cursor/stores/self/media/view-cube';
const ART = process.env.APEX_CUBE_ART ?? '/opt/cursor/artifacts/screenshots';
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(ART, { recursive: true });

const PITCH_LIM = Math.PI / 2 - 0.01;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { width: 1400, height: 900 },
  deviceScaleFactor: 2,
});
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="viewport-canvas"], canvas');
await page.waitForTimeout(800);

await page.getByTestId('view-3d').click();
await page.waitForTimeout(400);
const cube = page.getByTestId('view-cube');
await cube.waitFor({ state: 'visible' });

const setCamera = (cam) =>
  page.evaluate((c) => {
    const canvases = [...document.querySelectorAll('canvas')];
    canvases.find((el) => el.__apexRenderer)?.__apexRenderer?.setCamera(c);
  }, cam);

const saveCube = async (name) => {
  await page.waitForTimeout(120);
  const dests = [path.join(OUT, name), path.join(ART, name)];
  for (const d of dests) {
    await cube.screenshot({ path: d });
  }
  console.log('wrote', name);
};

/** Enlarge the widget temporarily for high-res face proofs. */
await page.evaluate(() => {
  const el = document.querySelector('.view-cube');
  if (el) {
    el.style.width = '320px';
    el.style.height = '320px';
  }
  const c = document.querySelector('.view-cube canvas');
  if (c) {
    c.style.width = '320px';
    c.style.height = '320px';
  }
});
await page.waitForTimeout(100);

const faceOn = [
  ['view-cube-face-front.png', { yaw: 0, pitch: 0 }],
  ['view-cube-face-back.png', { yaw: Math.PI, pitch: 0 }],
  ['view-cube-face-right.png', { yaw: Math.PI / 2, pitch: 0 }],
  ['view-cube-face-left.png', { yaw: -Math.PI / 2, pitch: 0 }],
  ['view-cube-face-top.png', { yaw: 0, pitch: PITCH_LIM }],
  ['view-cube-face-bottom.png', { yaw: 0, pitch: -PITCH_LIM }],
];

for (const [name, cam] of faceOn) {
  await setCamera({ ...cam, distance: 18, target: [0, 1.2, 0] });
  await saveCube(name);
}

// Isometric / CAD check angles
await setCamera({ yaw: 0.7, pitch: 0.45, distance: 18, target: [0, 1.2, 0] });
await saveCube('view-cube-large-labels.png');
await saveCube('view-cube-closeup.png');

await setCamera({ yaw: 0.35, pitch: 0.25, distance: 18, target: [0, 1.2, 0] });
await saveCube('view-cube-front-check.png');

await setCamera({ yaw: 0.55, pitch: 0.85, distance: 18, target: [0, 1.2, 0] });
await saveCube('view-cube-top-check.png');

await setCamera({ yaw: Math.PI + 0.7, pitch: 0.4, distance: 18, target: [0, 1.2, 0] });
await saveCube('view-cube-labels.png');

await setCamera({ yaw: 0.7, pitch: -0.55, distance: 18, target: [0, 1.2, 0] });
await saveCube('view-cube-bottom-check.png');

// Restore widget size for normal closeups
await page.evaluate(() => {
  const el = document.querySelector('.view-cube');
  if (el) {
    el.style.width = '';
    el.style.height = '';
  }
  const c = document.querySelector('.view-cube canvas');
  if (c) {
    c.style.width = '';
    c.style.height = '';
  }
});
await setCamera({ yaw: 0.7, pitch: 0.45, distance: 18, target: [0, 1.2, 0] });
await saveCube('view-cube-after-click.png');

// Full viewport context
await page.screenshot({ path: path.join(OUT, 'view-cube-3d.png'), fullPage: false });
await page.screenshot({ path: path.join(ART, 'view-cube-3d.png'), fullPage: false });

// Remove obsolete CSS3D debug shots so the media folder only has current proofs
for (const stale of ['view-cube-css3d-check.png', 'view-cube-debug-uv.png', 'view-cube-large-check.png']) {
  for (const dir of [OUT, ART]) {
    const p = path.join(dir, stale);
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      console.log('removed', p);
    }
  }
}

await browser.close();
console.log('capture complete');
