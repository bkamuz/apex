/**
 * Realistic two-storey house, built through the UI like a user would:
 * grid, walls, doors, windows, slabs, stair, roof, rooms, plan views with
 * dimensions and room names, a 3D view, and an A1 sheet exported to
 * SVG / DXF / PDF.
 *
 * Clicks are real mouse events. `window.__apexTest.worldToClient` is only
 * used to aim them at exact world coordinates (Shift snaps to the 1 m grid).
 *
 *   APEX_SMOKE_URL=http://127.0.0.1:5173/ APEX_HOUSE_OUT=/tmp/house node scripts/house-e2e.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';

/** Optional: skip the build and start from a saved project.json (sheet/export debugging). */
const RESUME = process.env.APEX_HOUSE_RESUME ? readFileSync(process.env.APEX_HOUSE_RESUME, 'utf8') : null;

const OUT = process.env.APEX_HOUSE_OUT ?? '/tmp/apex-house';
const BASE = process.env.APEX_SMOKE_URL ?? 'http://localhost:5173/';
mkdirSync(OUT, { recursive: true });

const problems = [];
const note = (msg) => {
  console.log('  !! ' + msg);
  problems.push(msg);
};

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
const page = await context.newPage();
page.on('pageerror', (e) => note(`page error: ${e.message}`));
const promptAnswers = [];
page.on('dialog', async (d) => {
  if (d.type() === 'prompt') await d.accept(promptAnswers.shift() ?? 'Note');
  else await d.dismiss();
});
await page.addInitScript((resume) => {
  if (sessionStorage.getItem('apex.house-e2e')) return;
  sessionStorage.setItem('apex.house-e2e', '1');
  localStorage.clear();
  localStorage.setItem('apex.gettingStarted.dismissed', '1');
  if (resume) localStorage.setItem('apex.project', resume);
}, RESUME);
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('canvas');
await page.waitForTimeout(800);

let shotN = 0;
async function shot(name) {
  shotN += 1;
  const p = `${OUT}/${String(shotN).padStart(2, '0')}-${name}.png`;
  await page.screenshot({ path: p });
  console.log('  shot', p);
  return p;
}
async function errorText() {
  const banner = page.locator('.error-banner');
  return (await banner.count()) && (await banner.first().isVisible()) ? (await banner.first().textContent()) : '';
}
async function checkError(step) {
  const t = await errorText();
  if (t) note(`${step}: error banner "${t.trim()}"`);
}

async function tabFor(name) {
  const btn = page.getByRole('button', { name, exact: true });
  if ((await btn.count()) > 0 && (await btn.first().isVisible())) return btn.first();
  for (const tab of await page.locator('.tools-tab').all()) {
    await tab.click();
    await page.waitForTimeout(50);
    if ((await btn.count()) > 0 && (await btn.first().isVisible())) return btn.first();
  }
  throw new Error(`tool not found: ${name}`);
}
async function useTool(name) {
  await page.keyboard.press('Escape');
  await (await tabFor(name)).click();
  await page.waitForTimeout(120);
}
async function rawClient(x, z, y) {
  return page.evaluate(([x, y, z]) => window.__apexTest?.worldToClient([x, y, z]), [x, y, z]);
}
async function canvasBox() {
  return page.locator('canvas').first().boundingBox();
}
async function client(x, z, y) {
  const p = await rawClient(x, z, y);
  const b = await canvasBox();
  if (!p || p[0] < b.x || p[1] < b.y || p[0] > b.x + b.width || p[1] > b.y + b.height) {
    throw new Error(`world point (${x},${z}) off screen: ${p}`);
  }
  return p;
}
/** Pan (middle drag) and wheel-zoom until the site rectangle fills the canvas. */
async function frameSite(y = 0) {
  for (let i = 0; i < 30; i += 1) {
    const b = await canvasBox();
    const pts = [];
    for (const [x, z] of [[-3, -3], [13, -3], [13, 11], [-3, 11]]) pts.push(await rawClient(x, z, y));
    if (pts.some((p) => !p)) return note('site not projectable');
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const tx = b.x + b.width / 2;
    const ty = b.y + b.height / 2;
    const frac = Math.max((Math.max(...xs) - Math.min(...xs)) / b.width, (Math.max(...ys) - Math.min(...ys)) / b.height);
    const centred = Math.abs(cx - tx) < 30 && Math.abs(cy - ty) < 30;
    if (centred && frac > 0.6 && frac < 0.92) return;
    if (!centred) {
      // Drag from a point we can grab to the canvas centre.
      const sx = Math.min(Math.max(cx, b.x + 5), b.x + b.width - 5);
      const sy = Math.min(Math.max(cy, b.y + 5), b.y + b.height - 5);
      await page.mouse.move(sx, sy);
      await page.mouse.down({ button: 'middle' });
      await page.mouse.move(sx + (tx - cx) / 2, sy + (ty - cy) / 2, { steps: 4 });
      await page.mouse.move(sx + (tx - cx), sy + (ty - cy), { steps: 4 });
      await page.mouse.up({ button: 'middle' });
    } else {
      await page.mouse.move(tx, ty);
      await page.mouse.wheel(0, frac >= 0.92 ? 100 : -100);
    }
    await page.waitForTimeout(100);
  }
  note('could not frame the site (pan/zoom)');
}
let elev = 0;
async function hover(x, z) {
  const [cx, cy] = await client(x, z, elev);
  await page.mouse.move(cx, cy);
}
async function clickW(x, z, { dbl = false, snap = true } = {}) {
  const [cx, cy] = await client(x, z, elev);
  if (snap) await page.keyboard.down('Shift');
  await page.mouse.move(cx, cy);
  if (dbl) await page.mouse.dblclick(cx, cy);
  else await page.mouse.click(cx, cy);
  if (snap) await page.keyboard.up('Shift');
  await page.waitForTimeout(120);
}
async function polyline(points, opts) {
  for (let i = 0; i < points.length; i += 1) {
    await clickW(points[i][0], points[i][1], { ...opts, dbl: i === points.length - 1 });
  }
  await page.waitForTimeout(200);
}
async function fit() {
  await page.mouse.move(5, 500);
  await page.keyboard.press('Escape');
  await page.keyboard.press('f');
  await page.waitForTimeout(400);
  await frameSite(elev);
}
async function sceneCounts() {
  return page.evaluate(() => {
    const raw = localStorage.getItem('apex.project');
    if (!raw) return null;
    const j = JSON.parse(raw);
    const els = j.document?.elements ?? j.elements ?? [];
    const by = {};
    for (const e of Object.values(els)) by[e.component_id] = (by[e.component_id] ?? 0) + 1;
    return by;
  });
}

// Footprint 10 x 8 m. Axes 1-3 at x = 0/5/10, A-C at z = 0/4/8.
// Rooms: Living (x 0-5), Bedroom (x 5-10, z 0-4), Kitchen (x 5-10, z 4-8).
const AX = [0, 5, 10];
const AZ = [0, 4, 8];

async function drawStorey({ entrance }) {
  await page.getByTestId('tools-tab-apex.building').click();
  await useTool('Wall');
  await page.getByRole('button', { name: 'Line', exact: true }).click();
  // Exterior loop, closed by clicking the start again.
  for (const [x, z] of [[0, 0], [10, 0], [10, 8], [0, 8], [0, 0]]) await clickW(x, z);
  for (const seg of [[[5, 0], [5, 8]], [[5, 4], [10, 4]]]) {
    await useTool('Wall');
    await clickW(...seg[0]);
    await clickW(...seg[1]);
    await page.keyboard.press('Escape');
  }
  await checkError('walls');

  await useTool('Door');
  const doors = [[5, 2], [5, 6]];
  if (entrance) doors.push([2, 0]);
  for (const [x, z] of doors) await clickW(x, z, { snap: false });
  await useTool('Window');
  for (const [x, z] of [[7.5, 0], [10, 2], [10, 6], [7.5, 8], [2.5, 8], [0, 4], ...(entrance ? [] : [[2, 0]])])
    await clickW(x, z, { snap: false });
  await page.keyboard.press('Escape');
  await checkError('openings');
  if (entrance) {
    // Diagonal (45°) test wall east of the house, with a door and a window,
    // so the 3D close-ups prove openings follow non-axis walls too.
    await useTool('Wall');
    await clickW(10.8, 0.8, { snap: false });
    await clickW(12.8, 2.8, { snap: false });
    await page.keyboard.press('Escape');
    await useTool('Door');
    await clickW(11.3, 1.3, { snap: false });
    await useTool('Window');
    await clickW(12.2, 2.2, { snap: false });
    await page.keyboard.press('Escape');
    await checkError('diagonal wall');
  }
}

if (!RESUME) {
// ---------------------------------------------------------------- Level 0
const firstViewRow = page.locator('[data-testid^="view-row-"]').filter({ hasText: /Plan/i }).first();
await firstViewRow.click();
await page.waitForTimeout(500);
await frameSite(0);

await page.getByTestId('tools-tab-apex.basics').click().catch(() => {});
await useTool('Grid axis');
for (const x of AX) {
  await clickW(x, -2);
  await clickW(x, 10);
}
for (const z of AZ) {
  await clickW(-2, z);
  await clickW(12, z);
}
await page.keyboard.press('Escape');
await fit();
await checkError('grid');
await shot('l0-grid');

await drawStorey({ entrance: true });
await useTool('Slab');
await polyline([[0, 0], [10, 0], [10, 8], [0, 8]]);
await page.keyboard.press('Escape');
await checkError('slab L0');
await shot('l0-walls-openings');

// ---------------------------------------------------------------- Level 1
await page.getByRole('button', { name: '+ Level' }).click();
await page.waitForTimeout(400);
const l1 = page.locator('.level-list li').nth(1);
await l1.click();
await page.waitForTimeout(400);
const badge = await page.locator('.level-list li.active-level').textContent();
if (!/1/.test(badge ?? '')) note(`level 1 did not activate (active: ${badge})`);
elev = 3;
await page.getByTestId('new-plan-view').click();
await page.waitForTimeout(500);
const l1Row = page.locator('[data-testid^="view-row-"]').filter({ hasText: /Plan/i }).nth(1);
await l1Row.click();
await page.waitForTimeout(500);
await fit();

await drawStorey({ entrance: false });
await useTool('Slab');
await polyline([[0, 0], [10, 0], [10, 8], [0, 8]]);
await page.keyboard.press('Escape');
await checkError('slab L1');

// Stair from level 0 up; it should cut the L1 slab.
await page.locator('.level-list li').nth(0).click();
await page.waitForTimeout(300);
elev = 0;
await useTool('Stair');
await clickW(1, 1.5, { snap: false });
await clickW(1, 6, { snap: false });
await page.keyboard.press('Escape');
await checkError('stair');

// Roof on level 1, ridge along axis B.
await page.locator('.level-list li').nth(1).click();
await page.waitForTimeout(300);
elev = 3;
await useTool('Pitched roof');
await clickW(-0.5, 4);
await clickW(10.5, 4);
await page.keyboard.press('Escape');
await checkError('roof');

// Close the gables the BIM way: attach the L1 end walls' tops to the roof.
for (const [x, z] of [[0, 1], [10, 1]]) {
  await page.keyboard.press('Escape');
  await clickW(x, z, { snap: false });
  await page.waitForTimeout(200);
  const box = page.locator('.field').filter({ hasText: 'Attach top to roof' }).locator('input[type=checkbox]');
  if ((await box.count()) === 0) {
    note(`gable wall at x=${x}: no "Attach top to roof" field (selection missed?)`);
    continue;
  }
  await box.first().check();
  await page.waitForTimeout(300);
}
await page.keyboard.press('Escape');
await checkError('attach gables');

// Rooms on both levels.
for (const [i, e] of [[0, 0], [1, 3]]) {
  await page.locator('.level-list li').nth(i).click();
  await page.waitForTimeout(300);
  elev = e;
  await useTool('Detect rooms');
  await clickW(2, 2, { snap: false });
  await page.waitForTimeout(300);
  const info = await page.getByTestId('topbar-hint').textContent().catch(() => '');
  console.log(`  rooms L${i}:`, info?.trim());
}
console.log('  elements:', JSON.stringify(await sceneCounts()));

// ---------------------------------------------------------------- Annotate
async function openView(re) {
  const row = page.locator('[data-testid^="view-row-"]').filter({ hasText: re }).first();
  await row.click();
  await page.waitForTimeout(500);
  const tab = page.locator('.view-tab-open').filter({ hasText: re }).first();
  if ((await tab.count()) > 0) await tab.click();
  await page.waitForTimeout(400);
}
async function dim(a, b) {
  await useTool('Dimension');
  await clickW(a[0], a[1], { snap: false });
  await clickW(b[0], b[1], { snap: false });
}
async function annotatePlan(levelIdx, e, names) {
  await page.locator('.level-list li').nth(levelIdx).click();
  elev = e;
  const planRows = page.locator('[data-testid^="view-row-"]').filter({ hasText: /Plan/i });
  await planRows.nth(levelIdx).click();
  await page.waitForTimeout(600);
  await fit();
  await page.getByTestId('tools-tab-apex.annotate').click();
  // Axis-to-axis chain + overall, both directions (clicks on the axis lines).
  await dim([0, -1], [5, -1]);
  await dim([5, -1], [10, -1]);
  await dim([0, -1.8], [10, -1.8]);
  await dim([-1, 0], [-1, 4]);
  await dim([-1, 4], [-1, 8]);
  await dim([-1.8, 0], [-1.8, 8]);
  // Per-room clear dimensions (wall face to face).
  await dim([0.1, 7.3], [4.9, 7.3]);
  await dim([5.1, 1], [9.9, 1]);
  await dim([9, 0.1], [9, 3.9]);
  await dim([9, 4.1], [9, 7.9]);
  await checkError(`dimensions L${levelIdx}`);
  // Room names: select the room and rename it in Properties (the plan tag
  // and the sheet's room tag follow the space name).
  for (const [text, x, z] of names) {
    await page.keyboard.press('Escape');
    await clickW(x, z, { snap: false });
    const input = page.getByTestId('space-name');
    if (await input.isVisible().catch(() => false)) {
      await input.fill(text);
      await input.press('Enter');
    } else {
      note(`could not select the room at (${x}, ${z}) to rename it to ${text}`);
    }
  }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
}
await annotatePlan(0, 0, [['LIVING', 3.5, 6], ['BEDROOM', 7.5, 2], ['KITCHEN', 7.5, 6]]);
await page.getByTestId('save-view').click().catch(() => {});
await shot('plan-l0-dimensions');
await annotatePlan(1, 3, [['HALL / STAIR', 3.5, 6], ['BEDROOM 2', 7.5, 2], ['BEDROOM 3', 7.5, 6]]);
await page.getByTestId('save-view').click().catch(() => {});
await shot('plan-l1-dimensions');

// ---------------------------------------------------------------- 3D
await page.getByTestId('new-3d-view').click();
await page.waitForTimeout(500);
await openView(/3D/i);
await page.keyboard.press('3');
await fit();
await page.getByTestId('save-view').click().catch(() => {});
await shot('3d-view');
{
  // Close-ups of hosted openings from inside/outside, several yaws each.
  const targets = [
    ['door-x-wall-entrance', [2, 1.05, 0]],
    ['door-y-wall-interior', [5, 1.05, 2]],
    ['window-y-wall', [0, 1.6, 4]],
    ['door-diagonal', [11.3, 1.05, 1.3]],
    ['window-diagonal', [12.2, 1.6, 2.2]],
  ];
  for (const [name, t] of targets) {
    for (const [k, yaw] of [0.4, 0.4 + Math.PI / 2, 0.4 + Math.PI, 0.4 + 1.5 * Math.PI].entries()) {
      await page.evaluate(([t, yaw]) => window.__apexTest.setCamera({ target: t, distance: 3.2, yaw, pitch: 0.22 }), [t, yaw]);
      await page.waitForTimeout(250);
      await shot(`3d-close-${name}-${k}`);
    }
  }
  // Gable ends: far views of both, then the wall/roof junction.
  for (const [name, t, dist, yaw, pitch] of [
    ['gable-far-a', [5, 4, 4], 24, 0.9, 0.25],
    ['gable-far-b', [5, 4, 4], 24, 0.9 + Math.PI, 0.25],
    ['gable-junction-a', [10, 6.8, 1.5], 7, 0.9, 0.15],
    ['gable-junction-b', [0, 6.8, 6.5], 7, 0.9 + Math.PI, 0.15],
  ]) {
    await page.evaluate(([t, d, yaw, pitch]) => window.__apexTest.setCamera({ target: t, distance: d, yaw, pitch }), [t, dist, yaw, pitch]);
    await page.waitForTimeout(300);
    await shot(`3d-${name}`);
  }
  await fit();
}

writeFileSync(`${OUT}/project.json`, await page.evaluate(() => localStorage.getItem('apex.project') ?? ''));
}
// ---------------------------------------------------------------- Sheet
await page.getByTestId('new-sheet-paper-size').selectOption('A1');
await page.getByTestId('new-sheet-paper-orientation').selectOption('landscape');
await page.getByTestId('new-sheet').click();
await page.waitForTimeout(400);
await page.locator('[data-testid^="sheet-row-"]').first().dblclick();
await page.waitForTimeout(800);
const paper = page.locator('.sheet-paper');
await paper.waitFor({ state: 'visible' });
const pb = await paper.boundingBox();
const viewRows = page.locator('[data-testid^="view-row-"]');
const targets = [
  [/Plan/i, 0, 0.24, 0.42],
  [/Plan/i, 1, 0.7, 0.42],
  [/3D/i, 0, 0.5, 0.8],
];
for (const [re, n, fx, fy] of targets) {
  await viewRows.filter({ hasText: re }).nth(n).dragTo(paper, {
    targetPosition: { x: pb.width * fx, y: pb.height * fy },
    sourcePosition: { x: 30, y: 10 },
  });
  await page.waitForTimeout(900);
}
const vps = page.locator('[data-testid^="live-viewport-"]');
const vpCount = await vps.count();
if (vpCount !== 3) note(`expected 3 viewports on sheet, got ${vpCount}`);
for (let i = 0; i < Math.min(2, vpCount); i += 1) {
  await vps.nth(i).click({ position: { x: 10, y: 10 }, force: true });
  await page.waitForTimeout(200);
  const sel = page.getByTestId('viewport-scale-select');
  if (await sel.count()) {
    const opts = await sel.locator('option').allTextContents();
    const want = opts.find((o) => /1\s*:\s*100\b/.test(o));
    if (want) await sel.selectOption({ label: want });
    else note(`no 1:100 option (${opts.join(', ')})`);
    await page.waitForTimeout(500);
  } else note('viewport scale select not shown after selecting viewport');
}
await page.waitForTimeout(800);
await shot('sheet-a1');

async function download(testId, name) {
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 8000 }).catch(() => null),
    page.getByTestId(testId).click(),
  ]);
  if (!dl) {
    note(`${testId}: no file download`);
    return null;
  }
  const p = `${OUT}/${name}`;
  await dl.saveAs(p);
  console.log('  saved', p);
  return p;
}
await download('export-sheet-svg', 'sheet.svg');
await download('export-sheet-dxf', 'sheet.dxf');
const pdf = await download('export-sheet-pdf', 'sheet.pdf');
if (!pdf) note('PDF export did not download a file');
else if (!readFileSync(pdf).subarray(0, 5).toString().startsWith('%PDF')) note('sheet.pdf is not a PDF');

writeFileSync(`${OUT}/problems.json`, JSON.stringify(problems, null, 2));
await context.close();
await browser.close();
console.log(problems.length ? `${problems.length} problem(s)` : 'house built without problems');
