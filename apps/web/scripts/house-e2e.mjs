/**
 * The built-in modern house (apps/web/src/ui/houseSample.ts), checked through
 * the UI: both plan views, a 3D view, and an A1 sheet exported to SVG / DXF / PDF.
 *
 * The model is loaded with `loadSampleProject` so the geometry stays the same
 * as house-mcp. Clicks after that are real mouse events; `worldToClient` only
 * aims the framing pan.
 *
 *   APEX_SMOKE_URL=http://127.0.0.1:5173/ APEX_HOUSE_OUT=/tmp/house node scripts/house-e2e.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';

/** Optional: skip the load and start from a saved project.json (sheet/export debugging). */
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
page.on('dialog', async (d) => {
  if (d.type() === 'prompt') await d.accept('Note');
  else await d.dismiss();
});
await page.addInitScript((resume) => {
  if (sessionStorage.getItem('apex.house-e2e')) return;
  sessionStorage.setItem('apex.house-e2e', '1');
  localStorage.clear();
  localStorage.setItem('apex.gettingStarted.dismissed', '1');
  localStorage.setItem('apex.locale', 'en');
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

async function rawClient(x, z, y) {
  return page.evaluate(([x, y, z]) => window.__apexTest?.worldToClient([x, y, z]), [x, y, z]);
}
async function canvasBox() {
  return page.locator('canvas').first().boundingBox();
}

/** Pan (middle drag) and wheel-zoom until the house rectangle fills the canvas. */
const FRAME = [[-2, -6], [16, -6], [16, 13], [-2, 13]];
async function frameSite(y = 0) {
  for (let i = 0; i < 24; i += 1) {
    const b = await canvasBox();
    const pts = [];
    for (const [x, z] of FRAME) pts.push(await rawClient(x, z, y));
    if (pts.some((p) => !p)) return note('site not projectable');
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const tx = b.x + b.width / 2;
    const ty = b.y + b.height / 2;
    const frac = Math.max((Math.max(...xs) - Math.min(...xs)) / b.width, (Math.max(...ys) - Math.min(...ys)) / b.height);
    const centred = Math.abs(cx - tx) < 30 && Math.abs(cy - ty) < 30;
    if (centred && frac > 0.62 && frac < 0.9) return;
    if (!centred) {
      const sx = Math.min(Math.max(cx, b.x + 5), b.x + b.width - 5);
      const sy = Math.min(Math.max(cy, b.y + 5), b.y + b.height - 5);
      await page.mouse.move(sx, sy);
      await page.mouse.down({ button: 'middle' });
      await page.mouse.move(sx + (tx - cx), sy + (ty - cy), { steps: 4 });
      await page.mouse.up({ button: 'middle' });
    } else {
      await page.mouse.move(tx, ty);
      await page.mouse.wheel(0, frac >= 0.9 ? 100 : -120);
    }
    await page.waitForTimeout(80);
  }
  note('could not frame the site (pan/zoom)');
}

async function sceneInfo() {
  return page.evaluate(() => {
    const raw = localStorage.getItem('apex.project');
    if (!raw) return null;
    const j = JSON.parse(raw);
    const els = Object.values(j.document?.elements ?? j.elements ?? {});
    const by = {};
    for (const e of els) by[e.component_id] = (by[e.component_id] ?? 0) + 1;
    const spaces = Object.values(j.document?.spaces ?? j.spaces ?? {});
    const levels = j.document?.levels ?? j.levels ?? [];
    return {
      by,
      spaces: spaces.length,
      spaceNames: spaces.map((s) => s.name).filter(Boolean),
      levels: Array.isArray(levels) ? levels.length : Object.keys(levels).length,
    };
  });
}

async function openView(re) {
  await page.getByTestId('browser-tab-views').click();
  const row = page.locator('[data-testid^="view-row-"]').filter({ hasText: re }).first();
  if ((await row.count()) === 0) {
    note(`view not found: ${re}`);
    return;
  }
  await row.click();
  await page.waitForTimeout(400);
}

if (!RESUME) {
  await page.waitForFunction(() => typeof window.__apexTest?.loadSampleProject === 'function');
  const loaded = await page.evaluate(() => window.__apexTest.loadSampleProject());
  if (loaded !== true) note('loadSampleProject did not return true');
  await page.waitForTimeout(1200);

  const info = await sceneInfo();
  console.log('  elements:', JSON.stringify(info));
  if (!info) note('no project in localStorage after sample load');
  else {
    const need = [
      ['apex.wall', 20],
      ['apex.roof', 2],
      ['apex.column', 3],
      ['apex.stair', 1],
      ['apex.slab', 2],
      ['apex.site_line', 6],
      ['apex.gate', 2],
      ['apex.site_surface', 8],
      ['apex.terrain', 1],
    ];
    for (const [id, n] of need) {
      if ((info.by[id] ?? 0) < n) note(`expected ≥${n} ${id}, got ${info.by[id] ?? 0}`);
    }
    if (info.levels < 3) note(`expected 3 levels, got ${info.levels}`);
    if (info.spaces < 13) note(`expected 13 rooms, got ${info.spaces}`);
    for (const name of ['sample.room.living', 'sample.room.master', 'sample.room.hall']) {
      if (!info.spaceNames.includes(name)) note(`missing room ${name}`);
    }
  }

  const labels = await page.locator('.space-label').allTextContents();
  if (!labels.some((t) => /Living/.test(t))) note(`plan labels not localized: ${labels.join(' | ')}`);

  await openView(/Ground floor/);
  await page.getByTestId('view-plan').click();
  await frameSite(0);
  await shot('plan-ground');

  await openView(/Upper floor/);
  await page.getByTestId('view-plan').click();
  await frameSite(3.05);
  const upperLabels = await page.locator('.space-label').allTextContents();
  if (!upperLabels.some((t) => /Master bedroom/.test(t))) note(`upper plan labels: ${upperLabels.join(' | ')}`);
  await shot('plan-upper');

  await openView(/^3D/);
  await page.getByTestId('view-3d').click();
  await page.getByTestId('view-persp').click();
  const views = [
    ['overview', [6, 2.2, 3], 0.65, 0.38, 28],
    ['south-glazing', [7, 1.6, 1], 2.35, 0.32, 22],
    ['cantilever', [5, 2.2, -2], 1.1, 0.28, 16],
    ['yard', [8, 0.6, -4], 2.6, 0.42, 26],
  ];
  for (const [name, target, yaw, pitch, distance] of views) {
    await page.evaluate((c) => window.__apexTest.setCamera(c), { target, yaw, pitch, distance });
    await page.waitForTimeout(350);
    await shot(`3d-${name}`);
  }

  writeFileSync(`${OUT}/project.json`, await page.evaluate(() => localStorage.getItem('apex.project') ?? ''));
}

// ---------------------------------------------------------------- Sheet
await page.getByTestId('browser-tab-views').click();
const sheetsGroup = page.locator('.browser-tree-group').filter({ hasText: /Sheets|Листы/ }).last();
if ((await page.getByTestId('new-sheet-paper-size').count()) === 0) {
  await sheetsGroup.locator('.browser-tree-toggle').click();
  await page.waitForTimeout(200);
}
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
  [/Ground floor/i, 0.24, 0.42],
  [/Upper floor/i, 0.7, 0.42],
  [/3D/i, 0.5, 0.8],
];
for (const [re, fx, fy] of targets) {
  await viewRows.filter({ hasText: re }).first().dragTo(paper, {
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
console.log(problems.length ? `${problems.length} problem(s)` : 'house checked without problems');
if (problems.length) process.exit(1);
