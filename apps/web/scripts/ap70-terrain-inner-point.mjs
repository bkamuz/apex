/**
 * AP-70: discoverable terrain inner-point add (click empty top + status hint).
 */
import { chromium } from 'playwright';
import { mkdirSync, copyFileSync } from 'fs';
import { join } from 'path';

const OUT = process.env.APEX_SMOKE_OUT ?? '/opt/cursor/artifacts/ap-70';
const MEDIA =
  process.env.APEX_MEDIA_OUT ??
  '/cursor/stores/bc-01a16d7d-837c-77fb-8314-11d75ba13086/media/ap-70';
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

async function selectTerrain() {
  await page.getByRole('button', { name: 'Select', exact: true }).click().catch(() => {});
  const id = await page.evaluate(() => window.__apexTest.selectLast('apex.terrain'));
  if (!id) throw new Error('selectLast(apex.terrain) failed');
  await page.waitForTimeout(400);
  await page.waitForSelector('[data-section="slab-shape"]');
  return id;
}

async function statusText() {
  return ((await page.getByTestId('topbar-hint').textContent()) ?? '').replace(/\s+/g, ' ').trim();
}

async function innerPointCount() {
  return page.locator('[data-section="slab-shape"] [data-testid^="shape-handle-"]').evaluateAll((els) =>
    els.filter((el) => /P\d+/.test(el.textContent ?? '')).length,
  );
}

async function setLocale(locale) {
  const switcher = page.getByTestId('language-switcher');
  if ((await switcher.count()) > 0) {
    await switcher.selectOption(locale);
  } else {
    // Compact status-bar language chip cycles EN ↔ RU.
    const chip = page.getByTestId('status-language');
    const want = locale.toUpperCase();
    for (let i = 0; i < 3; i++) {
      const cur = ((await chip.textContent()) ?? '').trim().toUpperCase();
      if (cur.includes(want)) break;
      await chip.click();
      await page.waitForTimeout(150);
    }
  }
  await page.waitForTimeout(300);
}

await page.getByRole('button', { name: '3D', exact: true }).click().catch(() => {});
await page.getByRole('button', { name: 'Axon', exact: true }).click().catch(() => {});
await page.evaluate((c) => window.__apexTest.setCamera(c), {
  target: [8, 0.4, 2],
  yaw: 0.35,
  pitch: 0.5,
  distance: 30,
});
await page.waitForTimeout(400);

const terrainId = await selectTerrain();
const enHint = await statusText();
console.log('EN status:', enHint.slice(0, 220));
if (!/click empty spot|add a point/i.test(enHint)) {
  throw new Error(`EN terrain hint missing: ${enHint}`);
}
await shot('01-terrain-selected-en-hint');

await setLocale('ru');
await selectTerrain();
const ruHint = await statusText();
console.log('RU status:', ruHint.slice(0, 220));
if (!/Рельеф|клик|добавить/i.test(ruHint)) {
  throw new Error(`RU terrain hint missing: ${ruHint}`);
}
await shot('02-terrain-selected-ru-hint');

await setLocale('en');
await page.getByRole('button', { name: '3D', exact: true }).click().catch(() => {});
await page.evaluate((c) => window.__apexTest.setCamera(c), {
  target: [8, 0.4, 2],
  yaw: 0.35,
  pitch: 0.5,
  distance: 30,
});
await page.waitForTimeout(300);
await selectTerrain();

const before = await innerPointCount();
console.log('inner points before:', before);

const canvas = page.getByTestId('viewport-canvas');
const box = await canvas.boundingBox();
if (!box) throw new Error('no canvas');

const handleClients = await page.evaluate(() => {
  const handles = window.__apexTest.getEditHandles() ?? [];
  return handles.map((p) => window.__apexTest.worldToClient(p)).filter(Boolean);
});
console.log('handles on screen', handleClients.length);

/** True if (cx,cy) is near an existing height handle. */
function nearHandle(cx, cy) {
  const r2 = 14 * 14;
  for (const c of handleClients) {
    const dx = c[0] - cx;
    const dy = c[1] - cy;
    if (dx * dx + dy * dy < r2) return true;
  }
  return false;
}

let added = false;
let used = null;
for (let ny = 0.35; ny <= 0.82; ny += 0.04) {
  for (let nx = 0.48; nx <= 0.92; nx += 0.04) {
    const cx = box.x + box.width * nx;
    const cy = box.y + box.height * ny;
    if (nearHandle(cx, cy)) continue;

    const top = await page.evaluate(
      ({ x, y, id }) => {
        const stack = window.__apexTest.pickCandidates(x, y);
        return stack.length > 0 && stack[0].id === id;
      },
      { x: cx, y: cy, id: terrainId },
    );
    if (!top) continue;

    await page.mouse.click(cx, cy);
    await page.waitForTimeout(300);
    const after = await innerPointCount();
    if (after > before) {
      added = true;
      used = { nx, ny, after, mode: 'click' };
      break;
    }
    // Reselect if click failed / stole focus.
    await selectTerrain();
  }
  if (added) break;
}

if (!added) {
  throw new Error(`plain click did not add an inner point (before=${before})`);
}
console.log('added', used);

await shot('03-inner-point-added-click');

const panel = (await page.locator('[data-section="slab-shape"]').textContent()) ?? '';
console.log('panel snippet:', panel.slice(0, 280).replace(/\s+/g, ' '));
if (!/empty spot|свободному месту/i.test(panel)) {
  throw new Error('inspector missing click-to-add copy');
}
await shot('04-inspector-hint');

console.log('AP-70 OK');
await browser.close();
