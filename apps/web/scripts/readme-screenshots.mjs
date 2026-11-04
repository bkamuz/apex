/**
 * Full-chrome README gallery: yard sample on current main (fence/gate/surfaces).
 *
 *   APEX_SMOKE_URL=http://localhost:5173/ \
 *   APEX_README_OUT=/tmp/readme-shots \
 *   node apps/web/scripts/readme-screenshots.mjs
 */
import { chromium } from 'playwright';
import { copyFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const OUT = process.env.APEX_README_OUT ?? '/tmp/apex-readme-shots';
const DOCS = process.env.APEX_README_DOCS ?? null;
const MEDIA = process.env.APEX_README_MEDIA ?? null;
const BASE = process.env.APEX_SMOKE_URL ?? 'http://localhost:5173/';
mkdirSync(OUT, { recursive: true });
if (MEDIA) mkdirSync(MEDIA, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await (
  await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  })
).newPage();
page.on('pageerror', (e) => console.warn('pageerror', e.message));
page.on('dialog', (d) => d.accept());

await page.addInitScript(() => {
  localStorage.clear();
  // Force light theme so chrome polish (active tool contrast) shows clearly.
  localStorage.setItem('apex.theme', 'light');
  localStorage.setItem('apex.locale', 'en');
});

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('canvas');
await page.waitForFunction(() => typeof window.__apexTest?.loadSampleProject === 'function');
await page.waitForTimeout(600);

// Prefer auto-loaded sample; fall back to test hook / Getting Started button.
const hasFence = await page.evaluate(() => {
  const raw = localStorage.getItem('apex.project');
  if (!raw) return false;
  const j = JSON.parse(raw);
  const els = Object.values(j.document?.elements ?? j.elements ?? {});
  return els.some((e) => e.component_id === 'apex.fence');
});
if (!hasFence) {
  const loadBtn = page.getByTestId('load-sample-project');
  if ((await loadBtn.count()) > 0 && (await loadBtn.isVisible())) {
    await loadBtn.click();
  } else {
    await page.evaluate(() => window.__apexTest.loadSampleProject());
  }
  await page.waitForTimeout(1800);
} else {
  await page.waitForTimeout(800);
}

const shot = async (name) => {
  const p = join(OUT, `${name}.png`);
  await page.screenshot({ path: p });
  console.log('  shot', p);
  if (MEDIA) {
    copyFileSync(p, join(MEDIA, `${name}.png`));
  }
  if (DOCS) {
    copyFileSync(p, join(DOCS, `${name}.png`));
  }
};

const clickTab = async (label) => {
  const tab = page.locator('.tools-tab', { hasText: new RegExp(`^${label}$`) }).first();
  if ((await tab.count()) > 0) {
    await tab.click();
    await page.waitForTimeout(250);
  }
};

const nav = async (label) => {
  await page.locator('button', { hasText: new RegExp(`^${label}$`) }).first().click();
  await page.waitForTimeout(400);
};

// --- 1) 3D overview with yard + Site tab active -------------------------------
await nav('3D');
await nav('Axon');
await clickTab('Site');
// Frame the whole yard (−3..13 × −3..11) + house.
await page.evaluate((c) => window.__apexTest.setCamera(c), {
  target: [5, 1.5, 4],
  yaw: 0.85,
  pitch: 0.42,
  distance: 36,
});
await page.waitForTimeout(500);
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
await shot('apex-3d-overview');

// --- 2) Plan with yard fence / surfaces ---------------------------------------
await nav('Plan');
await nav('Fit');
await page.waitForTimeout(400);
// Slight zoom-out so fence loop is fully visible after Fit.
const canvas = page.getByTestId('viewport-canvas');
const box = await canvas.boundingBox();
if (box) {
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.wheel(0, 480);
  await page.waitForTimeout(300);
}
await clickTab('Site');
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
await shot('apex-plan');

// --- 3) Selection / inspector (wall selected in 3D) ---------------------------
await nav('3D');
await nav('Axon');
await clickTab('Architecture');
await page.getByRole('button', { name: 'Select', exact: true }).click();
await page.waitForTimeout(200);
await page.evaluate((c) => window.__apexTest.setCamera(c), {
  target: [5, 2, 4],
  yaw: 0.7,
  pitch: 0.35,
  distance: 28,
});
await page.waitForTimeout(300);
// Pick a wall from the project browser for a clean inspector shot.
const wallItem = page.locator('[data-kind="instance"]').filter({ hasText: /^Wall/ }).first();
if ((await wallItem.count()) > 0) {
  await wallItem.click();
  await page.waitForTimeout(400);
}
await shot('apex-inspector');

// --- 4) Settings · Extensions (Site pack visible) -----------------------------
await page.getByTestId('settings-menu-summary').click();
await page.waitForSelector('[data-testid="settings-dialog"]');
await page.getByTestId('settings-tab-extensions').click();
await page.waitForTimeout(400);
await shot('apex-settings-extensions');
await page.keyboard.press('Escape');
await page.waitForTimeout(200);

// --- Bonus: Site tools ribbon close-up composition (kept in media only) -------
await clickTab('Site');
await page.getByRole('button', { name: 'Fence', exact: true }).click().catch(() => {});
await page.waitForTimeout(200);
await nav('3D');
await page.evaluate((c) => window.__apexTest.setCamera(c), {
  target: [5, 1.2, 4],
  yaw: 1.05,
  pitch: 0.38,
  distance: 32,
});
await page.waitForTimeout(400);
await shot('apex-site-tools');

await browser.close();
console.log('README screenshots ready in', OUT);
