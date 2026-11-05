/**
 * Full-chrome README gallery: sample house with yard (fence/gate/surfaces/topo).
 *
 *   APEX_SMOKE_URL=http://localhost:5173/ \
 *   APEX_README_OUT=/tmp/readme-shots \
 *   APEX_README_DOCS=docs/images \
 *   APEX_README_MEDIA=/path/to/media/ap-63 \
 *   node apps/web/scripts/readme-screenshots.mjs
 *
 * Extra media dirs (colon-separated): APEX_README_MEDIA_EXTRA=…
 */
import { chromium } from 'playwright';
import { copyFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const OUT = process.env.APEX_README_OUT ?? '/tmp/apex-readme-shots';
const DOCS = process.env.APEX_README_DOCS ?? null;
const MEDIA = process.env.APEX_README_MEDIA ?? null;
const MEDIA_EXTRA = (process.env.APEX_README_MEDIA_EXTRA ?? '')
  .split(':')
  .map((s) => s.trim())
  .filter(Boolean);
const BASE = process.env.APEX_SMOKE_URL ?? 'http://localhost:5173/';
mkdirSync(OUT, { recursive: true });
for (const dir of [MEDIA, ...MEDIA_EXTRA].filter(Boolean)) {
  mkdirSync(dir, { recursive: true });
}

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
  localStorage.setItem('apex.theme', 'light');
  localStorage.setItem('apex.locale', 'en');
});

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('canvas');
await page.waitForFunction(() => typeof window.__apexTest?.loadSampleProject === 'function');
await page.waitForTimeout(600);

const sampleCounts = async () =>
  page.evaluate(() => {
    const raw = localStorage.getItem('apex.project');
    if (!raw) return null;
    const j = JSON.parse(raw);
    const els = Object.values(j.document?.elements ?? j.elements ?? {});
    const by = {};
    for (const e of els) by[e.component_id] = (by[e.component_id] ?? 0) + 1;
    return by;
  });

let counts = await sampleCounts();
const ready =
  counts &&
  (counts['apex.fence'] ?? 0) >= 4 &&
  (counts['apex.terrain'] ?? 0) >= 1;
if (!ready) {
  const loadBtn = page.getByTestId('load-sample-project');
  if ((await loadBtn.count()) > 0 && (await loadBtn.isVisible())) {
    await loadBtn.click();
  } else {
    await page.evaluate(() => window.__apexTest.loadSampleProject());
  }
  await page.waitForTimeout(2000);
  counts = await sampleCounts();
}
console.log('  sample counts:', JSON.stringify(counts));
if (!counts?.['apex.terrain']) {
  console.warn('  !! expected apex.terrain in sample');
}

const publish = (name, src) => {
  if (MEDIA) copyFileSync(src, join(MEDIA, `${name}.png`));
  for (const dir of MEDIA_EXTRA) copyFileSync(src, join(dir, `${name}.png`));
  if (DOCS && !name.startsWith('apex-site-') && !name.startsWith('apex-topo-')) {
    // Gallery files only for docs/images (exclude media-only bonuses by prefix).
  }
  if (DOCS) {
    const gallery = new Set([
      'apex-3d-overview',
      'apex-plan',
      'apex-inspector',
      'apex-settings-extensions',
    ]);
    if (gallery.has(name)) copyFileSync(src, join(DOCS, `${name}.png`));
  }
};

const shot = async (name) => {
  const p = join(OUT, `${name}.png`);
  await page.screenshot({ path: p });
  console.log('  shot', p);
  publish(name, p);
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

// Clear sticky status notice if present (Escape / Select).
await page.keyboard.press('Escape');
await page.waitForTimeout(150);

// --- 1) 3D overview: yard + SE topo grade + Site tab --------------------------
await nav('3D');
await nav('Axon');
await clickTab('Site');
// From SE so the falling topo pad / driveway reads clearly; axes must sit under solids.
await page.evaluate((c) => window.__apexTest.setCamera(c), {
  target: [6, 0.8, 3],
  yaw: 0.55,
  pitch: 0.48,
  distance: 34,
});
await page.waitForTimeout(600);
await page.getByRole('button', { name: 'Select', exact: true }).click().catch(() => {});
await page.waitForTimeout(200);
await shot('apex-3d-overview');

// --- 2) Plan with yard + Site tools -------------------------------------------
await nav('Plan');
await nav('Fit');
await page.waitForTimeout(400);
const canvas = page.getByTestId('viewport-canvas');
const box = await canvas.boundingBox();
if (box) {
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.wheel(0, 520);
  await page.waitForTimeout(300);
}
await clickTab('Site');
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
await shot('apex-plan');

// --- 3) Selection / inspector (wall) — axes must not punch through walls ------
await nav('3D');
await nav('Axon');
await clickTab('Architecture');
await page.getByRole('button', { name: 'Select', exact: true }).click();
await page.waitForTimeout(200);
await page.evaluate((c) => window.__apexTest.setCamera(c), {
  target: [5, 1.8, 4],
  yaw: 0.95,
  pitch: 0.32,
  distance: 26,
});
await page.waitForTimeout(300);
const wallItem = page.locator('[data-kind="instance"]').filter({ hasText: /^Wall/ }).first();
if ((await wallItem.count()) > 0) {
  await wallItem.click();
  await page.waitForTimeout(400);
}
await shot('apex-inspector');

// --- 4) Settings · Extensions -------------------------------------------------
await page.getByTestId('settings-menu-summary').click();
await page.waitForSelector('[data-testid="settings-dialog"]');
await page.getByTestId('settings-tab-extensions').click();
await page.waitForTimeout(400);
await shot('apex-settings-extensions');
await page.keyboard.press('Escape');
await page.waitForTimeout(200);

// --- Bonus (media only): Site tools + terrain selected -----------------------
await clickTab('Site');
await page.getByRole('button', { name: 'Terrain', exact: true }).click().catch(async () => {
  await page.getByRole('button', { name: /Terrain|Рельеф/i }).first().click().catch(() => {});
});
await page.waitForTimeout(200);
await nav('3D');
await page.evaluate((c) => window.__apexTest.setCamera(c), {
  target: [8, 0.4, 2],
  yaw: 0.35,
  pitch: 0.5,
  distance: 30,
});
await page.waitForTimeout(300);
await page.getByRole('button', { name: 'Select', exact: true }).click().catch(() => {});
await page.waitForTimeout(200);
const topoItem = page
  .locator('[data-kind="instance"]')
  .filter({ hasText: /Terrain|Рельеф/i })
  .first();
if ((await topoItem.count()) > 0) {
  await topoItem.click();
  await page.waitForTimeout(400);
}
await shot('apex-terrain');

await clickTab('Site');
await page.getByRole('button', { name: 'Fence', exact: true }).click().catch(() => {});
await page.waitForTimeout(200);
await page.evaluate((c) => window.__apexTest.setCamera(c), {
  target: [5, 1.0, 4],
  yaw: 1.0,
  pitch: 0.4,
  distance: 32,
});
await page.waitForTimeout(400);
await shot('apex-site-tools');

await browser.close();
console.log('README screenshots ready in', OUT);
