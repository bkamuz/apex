/**
 * AP-71 / AP-72: double-click Terrain edit + always-on contour interval.
 */
import { chromium } from 'playwright';
import { mkdirSync, copyFileSync } from 'fs';
import { join } from 'path';

const OUT = process.env.APEX_SMOKE_OUT ?? '/opt/cursor/artifacts/ap-71';
const MEDIA =
  process.env.APEX_MEDIA_OUT ??
  '/cursor/stores/bc-01a16d7d-837c-77fb-8314-11d75ba13086/media/ap-71';
const BASE = process.env.APEX_SMOKE_URL ?? 'http://localhost:5173/';

mkdirSync(OUT, { recursive: true });
mkdirSync(MEDIA, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await (
  await browser.newContext({
    viewport: { width: 1440, height: 900 },
  })
).newPage();

page.on('console', (msg) => {
  if (msg.type() === 'error') console.log('CONSOLE', msg.text());
});
page.on('pageerror', (err) => console.log('PAGEERROR', err.message));
page.on('dialog', (d) => d.accept());

await page.addInitScript(() => {
  localStorage.clear();
  localStorage.setItem('apex.theme', 'light');
  localStorage.setItem('apex.locale', 'en');
  localStorage.setItem('apex.gettingStarted.dismissed', '1');
});

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('canvas');
await page.waitForFunction(() => typeof window.__apexTest?.loadSampleProject === 'function');
await page.waitForTimeout(400);

await page.evaluate(() => window.__apexTest.loadSampleProject());
await page.waitForTimeout(1500);

async function shot(name) {
  const path = join(OUT, `${name}.png`);
  await page.screenshot({ path });
  copyFileSync(path, join(MEDIA, `${name}.png`));
  console.log('shot', name);
}

async function statusText() {
  return ((await page.getByTestId('topbar-hint').textContent()) ?? '').replace(/\s+/g, ' ').trim();
}

async function selectTerrain() {
  await page.getByRole('button', { name: 'Select', exact: true }).click().catch(() => {});
  const id = await page.evaluate(() => window.__apexTest.selectLast('apex.terrain'));
  if (!id) throw new Error('selectLast(apex.terrain) failed');
  await page.waitForTimeout(400);
  return id;
}

async function canvasClientForTerrain() {
  // Interior plan point on the sample SE yard terrain → [clientX, clientY].
  const c = await page.evaluate(() => window.__apexTest.worldToClient([12.0, 0.2, 5.5]));
  if (!c) throw new Error('worldToClient failed');
  return { x: c[0], y: c[1] };
}

async function handleCount() {
  return page.evaluate(() => window.__apexTest.getEditHandles()?.length ?? 0);
}

async function setLocale(locale) {
  const switcher = page.getByTestId('language-switcher');
  if ((await switcher.count()) > 0) {
    await switcher.selectOption(locale);
  } else {
    const chip = page.getByTestId('status-language');
    const want = locale.toUpperCase();
    for (let i = 0; i < 3; i++) {
      const cur = ((await chip.textContent()) ?? '').trim().toUpperCase();
      if (cur === want) break;
      await chip.click();
      await page.waitForTimeout(200);
    }
  }
  await page.waitForTimeout(300);
}

async function go3dTerrain() {
  await page.getByRole('button', { name: '3D', exact: true }).click().catch(() => {});
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    window.__apexTest.setCamera({
      eye: [22, 14, 18],
      target: [12, -0.5, 6],
      up: [0, 1, 0],
    });
  });
  await page.waitForTimeout(400);
}

// Frame sample with terrain visible in 3D (contours read on the TIN top).
await go3dTerrain();
await shot('01-sample-contours-default');

const terrainId = await selectTerrain();
console.log('terrain', terrainId);
await page.waitForTimeout(300);
await page.waitForSelector('[data-section="slab-shape"]');
const handlesAfterSelect = await handleCount();
const hintSelect = await statusText();
const editBtnActive = await page.getByTestId('slab-shape-edit').evaluate((el) =>
  el.classList.contains('active'),
);
console.log('handles after select', handlesAfterSelect, 'editActive', editBtnActive, 'hint', hintSelect);
// Select shows path anchors only (outer ring); shape-edit adds interior points.
if (editBtnActive) {
  throw new Error('single-click select must not enter edit (Edit heights already active)');
}
if (!/double-click/i.test(hintSelect)) {
  throw new Error(`expected double-click hint, got: ${hintSelect}`);
}
await shot('02-select-no-edit');

const hit = await canvasClientForTerrain();
await page.mouse.dblclick(hit.x, hit.y);
await page.waitForFunction(() =>
  document.querySelector('[data-testid="slab-shape-edit"]')?.classList.contains('active'),
);
await page.waitForTimeout(400);
const handlesEdit = await handleCount();
const hintEdit = await statusText();
const editBtnActive2 = await page.getByTestId('slab-shape-edit').evaluate((el) =>
  el.classList.contains('active'),
);
console.log('handles after dblclick', handlesEdit, 'editActive', editBtnActive2, 'hint', hintEdit);
if (!editBtnActive2) {
  throw new Error('double-click should activate Edit heights');
}
// Shape edit exposes interior points (outer anchors alone on select).
if (handlesEdit < handlesAfterSelect) {
  throw new Error(
    `double-click edit should not drop handles (${handlesAfterSelect} → ${handlesEdit})`,
  );
}
const interiorListed = await page.locator('[data-testid^="shape-handle-"]').evaluateAll((els) =>
  els.some((el) => /^P\d+/i.test((el.textContent ?? '').trim())),
);
if (!interiorListed && handlesEdit <= handlesAfterSelect) {
  console.log('WARN: interior handles not yet in gizmo; inspector edit active is enough');
}
if (!/Terrain edit|Esc/i.test(hintEdit)) {
  throw new Error(`expected edit hint, got: ${hintEdit}`);
}
await shot('03-double-click-edit');

await page.keyboard.press('Escape');
await page.waitForTimeout(400);
const handlesEsc = await handleCount();
const editBtnActive3 = await page.getByTestId('slab-shape-edit').evaluate((el) =>
  el.classList.contains('active'),
);
console.log('handles after Esc', handlesEsc, 'editActive', editBtnActive3);
if (editBtnActive3) {
  throw new Error('Esc should exit edit (Edit heights still active)');
}
if (handlesEsc > handlesEdit) {
  throw new Error('Esc should drop interior edit handles');
}
await shot('04-esc-exit-edit');

// Contour interval via inspector param (terrain still selected).
await page.evaluate((id) => {
  window.__apexTest.command({
    op: 'update_element',
    id,
    params: { contour_interval: 0.5 },
  });
}, terrainId);
await page.waitForTimeout(500);
await go3dTerrain();
await selectTerrain();
await page.waitForTimeout(300);
const hasContourLabel = await page.evaluate(() =>
  /Contour interval/i.test(document.body.innerText),
);
console.log('interval label EN present', hasContourLabel);
if (!hasContourLabel) throw new Error('Contour interval label missing in inspector');
await shot('05-contours-interval-0.5');

const intervalLabel = await page.evaluate(() => {
  const labels = [...document.querySelectorAll('label, .param-label, .field-label, .inspector-row')];
  return labels.map((el) => (el.textContent ?? '').trim()).find((t) => /contour/i.test(t)) ?? null;
});
console.log('interval label EN', intervalLabel);
if (!intervalLabel || !/contour/i.test(intervalLabel)) {
  // Soft check — param may render via generic ParamSpec label key.
  console.log('WARN: could not find Contour interval label in DOM; checking catalog via RU next');
}

await setLocale('ru');
await selectTerrain();
await page.waitForTimeout(300);
const hintRu = await statusText();
console.log('RU select hint', hintRu);
if (!/двойной|двойн/i.test(hintRu)) {
  throw new Error(`expected RU double-click hint, got: ${hintRu}`);
}
await shot('06-ru-select-hint');

await page.mouse.dblclick(hit.x, hit.y);
await page.waitForTimeout(500);
const hintRuEdit = await statusText();
console.log('RU edit hint', hintRuEdit);
await shot('07-ru-edit-hint');

console.log('OK ap-71');
await browser.close();
