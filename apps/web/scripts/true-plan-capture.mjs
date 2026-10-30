/**
 * Capture Plan view evidence + camera axis metrics for true top-down AP-23.
 * Usage: APEX_SMOKE_OUT=... APEX_LABEL=before|after node scripts/true-plan-capture.mjs
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.APEX_SMOKE_URL ?? 'http://localhost:5173/';
const OUT = process.env.APEX_SMOKE_OUT ?? '/opt/cursor/artifacts/screenshots/true-plan';
const LABEL = process.env.APEX_LABEL ?? 'shot';

fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.addInitScript(() => {
  if (!sessionStorage.getItem('apex.true-plan-cap')) {
    localStorage.removeItem('apex.project');
    localStorage.removeItem('apex.browser');
    sessionStorage.setItem('apex.true-plan-cap', '1');
  }
});

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="viewport-canvas"]');
await page.waitForTimeout(600);

const houseOk = await page.evaluate(() => window.__apexTest?.loadSampleProject?.() === true);
if (!houseOk) throw new Error('loadSampleProject failed');
await page.waitForTimeout(800);

await page.getByTestId('view-plan').click();
await page.waitForTimeout(700);

// Fit so the house fills the frame.
const fit = page.getByRole('button', { name: /fit/i });
if ((await fit.count()) > 0) {
  await fit.first().click();
  await page.waitForTimeout(400);
}

const metrics = await page.evaluate(() => {
  const r = document.querySelector('[data-testid="viewport-canvas"]')?.__apexRenderer;
  if (!r) return null;
  const cam = r.getCamera();
  const eye = r.getEyePosition?.() ?? null;
  // Reconstruct eye from yaw/pitch if helper missing.
  const { target, distance, yaw, pitch } = cam;
  const cp = Math.cos(pitch);
  const eyeFromOrbit = [
    target[0] + distance * Math.sin(yaw) * cp,
    target[1] + distance * Math.sin(pitch),
    target[2] + distance * Math.cos(yaw) * cp,
  ];
  const e = eye ?? eyeFromOrbit;
  const dx = e[0] - target[0];
  const dy = e[1] - target[1];
  const dz = e[2] - target[2];
  const horiz = Math.hypot(dx, dz);
  const tiltDeg = (Math.atan2(horiz, Math.abs(dy)) * 180) / Math.PI;
  return {
    navigation: r.getViewNavigation?.(),
    projection: r.getProjection?.(),
    yaw,
    pitch,
    pitchDeg: (pitch * 180) / Math.PI,
    distance,
    target,
    eye: e,
    horizontalOffset: horiz,
    tiltFromVerticalDeg: tiltDeg,
    pitchLimitShortfallDeg: ((Math.PI / 2 - pitch) * 180) / Math.PI,
  };
});

const canvas = page.getByTestId('viewport-canvas');
await canvas.screenshot({ path: path.join(OUT, `${LABEL}-plan-canvas.png`) });
await page.screenshot({ path: path.join(OUT, `${LABEL}-plan-full.png`), fullPage: false });

fs.writeFileSync(path.join(OUT, `${LABEL}-metrics.json`), JSON.stringify(metrics, null, 2));
console.log(JSON.stringify({ label: LABEL, metrics }, null, 2));

await browser.close();
