/**
 * AP-69: grid bubble heads must survive pointer hover (pick) without vanishing,
 * while still occluding behind solids in 3D.
 *
 * Usage:
 *   OUT=/cursor/stores/.../media/ap-69 ART=/opt/cursor/artifacts/ap-69 \
 *     node apps/web/scripts/ap69-axis-hover-occlusion.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync, copyFileSync, writeFileSync } from 'fs';

const OUT = process.env.OUT ?? '/cursor/stores/self/media/ap-69';
const ART = process.env.ART ?? '/opt/cursor/artifacts/ap-69';
const BASE = process.env.APEX_SMOKE_URL ?? 'http://localhost:5173/';

mkdirSync(OUT, { recursive: true });
mkdirSync(ART, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
});

await page.addInitScript(() => {
  localStorage.removeItem('apex.project');
  localStorage.removeItem('apex.browser');
  localStorage.setItem('apex.gettingStarted.dismissed', '1');
  localStorage.setItem('apex.theme', 'light');
  localStorage.setItem('apex.locale', 'en');
});

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('canvas');
await page.waitForFunction(() => !!window.__apexTest?.loadSampleProject, null, {
  timeout: 60000,
});
await page.evaluate(() => {
  window.__apexTest.loadSampleProject();
  window.__apexTest.clearSelection?.();
});
await page.waitForTimeout(800);

const axon = page.getByRole('button', { name: 'Axon', exact: true });
if ((await axon.count()) > 0) await axon.first().click();
const threeD = page.getByRole('button', { name: '3D', exact: true });
if ((await threeD.count()) > 0) await threeD.first().click();
await page.waitForTimeout(600);

const fit = page.getByRole('button', { name: 'Fit', exact: true });
if ((await fit.count()) > 0) {
  await fit.first().click();
  await page.waitForTimeout(500);
}

const canvas = page.getByTestId('viewport-canvas');
const box = await canvas.boundingBox();
if (!box) throw new Error('viewport canvas missing bounding box');

const countLabels = async () =>
  page.locator('.grid-axis-label').count();

const before = await countLabels();
if (before < 2) {
  throw new Error(`expected grid heads before hover, got ${before}`);
}

// Direct FBO-clash probe: bake occlusion, pick (overwrites shared buffer),
// then re-query a currently-visible grid head. Without invalidating
// occlusionSig, pick ids are misread as near window-Z → false occluded.
const probe = await page.evaluate(() => {
  const canvas = /** @type {HTMLCanvasElement & { __apexRenderer?: any }} */ (
    document.querySelector('[data-testid="viewport-canvas"]')
  );
  const renderer = canvas?.__apexRenderer;
  if (!renderer) return { error: 'no renderer' };
  const el = document.querySelector('.grid-axis-label[data-world]');
  if (!el) return { error: 'no labels' };
  const world = /** @type {[number, number, number]} */ (
    el.getAttribute('data-world').split(',').map(Number)
  );
  renderer.beginOverlayOcclusion();
  const beforePick = renderer.isWorldOccluded(world);
  const rect = canvas.getBoundingClientRect();
  renderer.pick(rect.left + rect.width * 0.5, rect.top + rect.height * 0.5);
  const afterPick = renderer.isWorldOccluded(world);
  return {
    world,
    text: el.textContent,
    beforePick,
    afterPick,
    labelCount: document.querySelectorAll('.grid-axis-label').length,
  };
});

const beforePath = `${OUT}/before-hover-3d-viewport.png`;
await page.screenshot({
  path: beforePath,
  clip: { x: box.x, y: box.y, width: box.width, height: box.height },
});
copyFileSync(beforePath, `${ART}/before-hover-3d-viewport.png`);

// Sweep the pointer across the model so Select hover runs pickAll repeatedly.
const steps = 12;
for (let i = 0; i <= steps; i++) {
  const t = i / steps;
  const x = box.x + box.width * (0.25 + 0.5 * t);
  const y = box.y + box.height * (0.35 + 0.2 * Math.sin(t * Math.PI));
  await page.mouse.move(x, y);
  await page.waitForTimeout(40);
}
// Allow GridAxisLabels rAF to refresh after the last pick.
await page.waitForTimeout(250);

const afterHover = await countLabels();
const afterHoverPath = `${OUT}/after-hover-3d-viewport.png`;
await page.screenshot({
  path: afterHoverPath,
  clip: { x: box.x, y: box.y, width: box.width, height: box.height },
});
copyFileSync(afterHoverPath, `${ART}/after-hover-3d-viewport.png`);

const probeOk =
  !probe?.error &&
  probe.beforePick === false &&
  probe.afterPick === false;
const hoverOk = afterHover >= Math.max(2, Math.floor(before * 0.5));
const report = {
  before,
  afterHover,
  probe,
  probeOk,
  hoverOk,
  ok: probeOk && hoverOk,
};
writeFileSync(`${OUT}/hover-occlusion-report.json`, JSON.stringify(report, null, 2));
writeFileSync(`${ART}/hover-occlusion-report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

if (!report.ok) {
  await browser.close();
  process.exit(1);
}

await browser.close();
