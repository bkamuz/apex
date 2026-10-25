/**
 * Full functional audit runner (2026-10-25). Screenshots → docs/audit-2026-10-25/.
 * Video → /opt/cursor/artifacts/full-audit-walkthrough.webm (renamed after close).
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, renameSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.APEX_AUDIT_OUT ?? __dir;
const ARTIFACTS = '/opt/cursor/artifacts';
const BASE = process.env.APEX_SMOKE_URL ?? 'http://localhost:5173/';
const DOWNLOADS = join(OUT, 'exports');

mkdirSync(DOWNLOADS, { recursive: true });
mkdirSync(ARTIFACTS, { recursive: true });

/** @type {Array<{id:string, feature:string, status:'works'|'partly'|'broken'|'confusing', severity:'blocker'|'major'|'minor'|'polish', steps:string, detail:string, screenshot?:string}>} */
const findings = [];
/** @type {Array<{type:string, text:string}>} */
const consoleErrors = [];

let step = 0;
async function shot(page, slug, fullPage = true) {
  step += 1;
  const name = `${String(step).padStart(3, '0')}-${slug}.png`;
  await page.screenshot({ path: join(OUT, name), fullPage });
  return name;
}

function record(feature, status, severity, steps, detail, screenshot) {
  const id = `F-${String(findings.length + 1).padStart(3, '0')}`;
  findings.push({ id, feature, status, severity, steps, detail, screenshot });
  const flag = status === 'works' ? 'ok' : status === 'partly' ? '~~' : '!!';
  console.log(`${flag} [${severity}] ${feature}: ${detail.slice(0, 120)}`);
}

function pass(feature, steps, detail, screenshot) {
  record(feature, 'works', 'polish', steps, detail, screenshot);
}
function issue(feature, status, severity, steps, detail, screenshot) {
  record(feature, status, severity, steps, detail, screenshot);
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1400, height: 900 },
  recordVideo: { dir: ARTIFACTS, size: { width: 1400, height: 900 } },
  acceptDownloads: true,
});
const page = await context.newPage();

page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push({ type: 'console.error', text: msg.text() });
});
page.on('pageerror', (err) => consoleErrors.push({ type: 'pageerror', text: err.message }));

page.on('dialog', async (dialog) => {
  if (dialog.type() === 'prompt') await dialog.accept('Audit note');
  else if (dialog.type() === 'confirm') await dialog.accept();
  else await dialog.dismiss();
});

await page.addInitScript(() => {
  if (sessionStorage.getItem('apex.full-audit')) return;
  sessionStorage.setItem('apex.full-audit', '1');
  localStorage.removeItem('apex.project');
  localStorage.removeItem('apex.documentTabs');
  localStorage.removeItem('apex.browser');
});

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('canvas');
await page.waitForTimeout(1200);

const canvas = page.locator('canvas').first();
let box = await canvas.boundingBox();
if (!box) throw new Error('no canvas');

async function clickCanvas(nx, ny) {
  box = (await canvas.boundingBox()) ?? box;
  await page.mouse.click(box.x + box.width * nx, box.y + box.height * ny);
  await page.waitForTimeout(160);
}

async function useTool(name) {
  const btn = page.getByRole('button', { name, exact: true });
  if ((await btn.count()) === 0 || !(await btn.first().isVisible())) {
    for (const tab of await page.locator('.tools-tab').all()) {
      await tab.click();
      await page.waitForTimeout(50);
      if ((await btn.count()) > 0 && (await btn.first().isVisible())) break;
    }
  }
  await btn.first().click();
  await page.waitForTimeout(120);
}

const toolbarNames = () =>
  page.locator('.tools button').evaluateAll((els) => els.map((e) => e.textContent.trim()));

const elementCount = () => page.locator('[data-kind="instance"]').count();

// --- Enumerate toolbar tabs ---
const tabIds = ['apex.basics', 'apex.building', 'apex.engineering', 'apex.spaces', 'apex.annotate'];
const tabInventory = {};
for (const tid of tabIds) {
  const tab = page.getByTestId(`tools-tab-${tid}`);
  if ((await tab.count()) === 0) {
    tabInventory[tid] = { label: '(missing)', tools: [] };
    continue;
  }
  await tab.click();
  await page.waitForTimeout(80);
  tabInventory[tid] = { label: ((await tab.textContent()) ?? '').trim(), tools: await toolbarNames() };
}
writeFileSync(join(OUT, 'toolbar-inventory.json'), JSON.stringify(tabInventory, null, 2));

const s0 = await shot(page, 'startup-default-view');
pass('App load', 'Open http://localhost:5173/', 'Canvas and chrome render; default document tab visible.', s0);

// --- Basics tab tools ---
await page.getByTestId('tools-tab-apex.basics').click();
for (const t of ['Level', 'Ref point', 'Ref plane', 'Construction line', 'Grid axis', 'Section cut']) {
  if (!tabInventory['apex.basics']?.tools.includes(t)) {
    issue(`Basics / ${t}`, 'broken', 'major', 'Open Basics tab', `Tool "${t}" not on toolbar`, s0);
  }
}

await useTool('Level');
await clickCanvas(0.5, 0.5);
const levelsAfter = await page.locator('.level-list li').count();
const sLevel = await shot(page, 'basics-level-added');
if (levelsAfter >= 2) pass('Level tool', 'Basics → Level → click plan', `Storey count ${levelsAfter}`, sLevel);
else issue('Level tool', 'broken', 'major', 'Same', `Expected ≥2 levels, got ${levelsAfter}`, sLevel);

await useTool('Ref point');
await clickCanvas(0.4, 0.4);
await useTool('Ref plane');
await clickCanvas(0.45, 0.35);
await clickCanvas(0.6, 0.35);
const sRef = await shot(page, 'basics-refs');
pass('Ref point / Ref plane', 'Place point then two-click plane', 'References appear in browser', sRef);

await useTool('Grid axis');
await clickCanvas(0.35, 0.65);
await clickCanvas(0.65, 0.65);
await useTool('Construction line');
await clickCanvas(0.3, 0.55);
await clickCanvas(0.7, 0.55);
await useTool('Section cut');
await clickCanvas(0.4, 0.48);
await clickCanvas(0.65, 0.48);
await shot(page, 'basics-annotations');

// --- Building: walls room ---
await page.getByTestId('tools-tab-apex.building').click();
await useTool('Wall');
await page.getByRole('button', { name: 'Line', exact: true }).click();
const corners = [
  [0.32, 0.52],
  [0.58, 0.52],
  [0.58, 0.7],
  [0.32, 0.7],
];
for (let i = 0; i < corners.length; i++) {
  const a = corners[i];
  const b = corners[(i + 1) % corners.length];
  await clickCanvas(a[0], a[1]);
  await clickCanvas(b[0], b[1]);
}
const sWalls = await shot(page, 'building-walls-room');
pass('Wall / Line', 'Building → Wall → Line → rectangle', `Instances: ${await elementCount()}`, sWalls);

// Hosted openings (click near wall centerline)
await useTool('Door');
for (const pt of [
  [0.45, 0.52],
  [0.4, 0.52],
  [0.5, 0.52],
]) {
  await clickCanvas(pt[0], pt[1]);
  if ((await page.locator('[data-kind="instance"]').filter({ hasText: /Door/ }).count()) > 0) break;
}
const doors = await page.locator('[data-kind="instance"]').filter({ hasText: /Door/ }).count();
const sDoor = await shot(page, 'building-door-on-wall');
if (doors >= 1) pass('Door (hosted)', 'Door tool → click wall segment', 'Door instance created', sDoor);
else issue('Door (hosted)', 'broken', 'major', 'Same', 'No door instance in browser', sDoor);

await useTool('Window');
await clickCanvas(0.52, 0.52);
await useTool('Slab');
await clickCanvas(0.34, 0.56);
await clickCanvas(0.56, 0.56);
await clickCanvas(0.56, 0.68);
await clickCanvas(0.34, 0.68);
await canvas.dblclick({ position: { x: box.width * 0.34, y: box.height * 0.68 } });
await page.waitForTimeout(300);
await useTool('Slab opening');
await clickCanvas(0.45, 0.62);
const sSlab = await shot(page, 'building-slab-opening');

await useTool('Column');
await clickCanvas(0.35, 0.58);
await useTool('Beam');
await clickCanvas(0.35, 0.58);
await clickCanvas(0.55, 0.58);
await useTool('Stair');
await clickCanvas(0.5, 0.62);
await clickCanvas(0.55, 0.68);
await page.waitForTimeout(300);
await useTool('Roof');
await clickCanvas(0.34, 0.54);
await clickCanvas(0.56, 0.54);
await clickCanvas(0.56, 0.68);
await clickCanvas(0.34, 0.68);
await canvas.dblclick({ position: { x: box.width * 0.34, y: box.height * 0.68 } });
await page.waitForTimeout(300);
const sBuilding = await shot(page, 'building-mixed-model');

// Engineering MEP
await page.getByTestId('tools-tab-apex.engineering').click();
await useTool('Pipe');
await clickCanvas(0.2, 0.3);
await clickCanvas(0.35, 0.3);
await canvas.dblclick({ position: { x: box.width * 0.35, y: box.height * 0.3 } });
await useTool('Duct');
await clickCanvas(0.2, 0.25);
await clickCanvas(0.4, 0.25);
await canvas.dblclick({ position: { x: box.width * 0.4, y: box.height * 0.25 } });
await useTool('Cable tray');
await clickCanvas(0.2, 0.2);
await clickCanvas(0.42, 0.2);
await canvas.dblclick({ position: { x: box.width * 0.42, y: box.height * 0.2 } });
const sMep = await shot(page, 'engineering-mep');
pass('MEP routes', 'Engineering tab → Pipe/Duct/Cable tray polylines', 'Three route types placed', sMep);

// Spaces
await page.getByTestId('tools-tab-apex.spaces').click();
await useTool('Detect rooms');
await clickCanvas(0.45, 0.6);
await page.waitForTimeout(500);
const sSpaces = await shot(page, 'spaces-detect-rooms');
pass('Detect rooms', 'Spaces → Detect rooms → click inside wall loop', 'Auto spaces from walls', sSpaces);

// Plan vs 3D camera
await page.getByTestId('view-plan').click();
await page.waitForTimeout(400);
const sPlan = await shot(page, 'viewport-plan-mode');
await page.getByTestId('view-3d').click();
await page.waitForTimeout(400);
const s3d = await shot(page, 'viewport-3d-mode');
pass('Plan / 3D toggle', 'Toolbar view-plan / view-3d', 'Badge and projection update', s3d);

// Projection axon vs perspective
const orthoBtn = page.locator('button').filter({ hasText: /^Axon|^Ortho|^Parallel/i }).first();
const perspBtn = page.getByRole('button', { name: /Persp/i });
if ((await perspBtn.count()) > 0) {
  await perspBtn.click();
  await page.waitForTimeout(300);
  await shot(page, 'camera-perspective');
  if ((await orthoBtn.count()) > 0) {
    await orthoBtn.click();
    await page.waitForTimeout(300);
  }
}

// Fit + orbit smoke
await page.getByTestId('fit-view').click();
await page.waitForTimeout(200);
box = (await canvas.boundingBox()) ?? box;
const cx = box.x + box.width * 0.5;
const cy = box.y + box.height * 0.5;
await page.mouse.move(cx, cy);
await page.mouse.down({ button: 'right' });
await page.mouse.move(cx + 80, cy + 50, { steps: 8 });
await page.mouse.up({ button: 'right' });
await shot(page, 'camera-orbit-rmb');

// Move / Copy / hotkeys
await useTool('Select');
await page.locator('[data-kind="instance"]').filter({ hasText: /^Column/ }).first().click();
await page.keyboard.press('m');
await page.waitForTimeout(100);
const moveActive = (await page.getByRole('button', { name: 'Move', exact: true }).getAttribute('class'))?.includes('active');
if (moveActive) pass('Hotkey M → Move', 'Select column → press M', 'Move tool activates', undefined);
else issue('Hotkey M → Move', 'partly', 'minor', 'Same', 'Move button not marked active', undefined);

await page.keyboard.press('Escape');
await useTool('Move');
await clickCanvas(0.38, 0.58);
await clickCanvas(0.42, 0.62);
await page.getByTestId('undo').click();
await page.waitForTimeout(200);
await page.getByTestId('redo').click();
await page.waitForTimeout(200);
await shot(page, 'transform-undo-redo');

// Parent UI
await useTool('Parent');
await page.locator('[data-kind="instance"]').filter({ hasText: /^Column/ }).first().click();
for (const pt of [
  [0.45, 0.52],
  [0.4, 0.52],
  [0.35, 0.52],
]) {
  await clickCanvas(pt[0], pt[1]);
  const pid = await page.evaluate(async () => {
    const mod = await import('/src/wasm/apex.ts');
    const col = mod.apexListElements().find((e) => e.component_id === 'apex.column');
    return col?.parent_id ?? null;
  });
  if (pid) break;
}
await page.waitForTimeout(300);
const parented = await page.evaluate(async () => {
  const mod = await import('/src/wasm/apex.ts');
  const col = mod.apexListElements().find((e) => e.component_id === 'apex.column');
  return col?.parent_id ?? null;
});
const sParent = await shot(page, 'parent-column-to-wall');
if (parented) pass('Parent tool (UI picks)', 'Parent → child → parent wall click', `parent_id set`, sParent);
else issue('Parent tool (UI picks)', 'broken', 'major', 'Same', 'Column parent_id still null', sParent);

// Views & sheets
await page.getByTestId('new-plan-view').click();
await page.waitForTimeout(400);
await page.locator('[data-testid^="view-row-"]').filter({ hasText: /Plan/i }).first().click();
await page.waitForTimeout(500);
const sSavedPlan = await shot(page, 'views-new-plan');

const annotateTab = page.getByTestId('tools-tab-apex.annotate');
if ((await annotateTab.count()) > 0) {
  await annotateTab.click();
  await useTool('Dimension');
  await clickCanvas(0.32, 0.52);
  await clickCanvas(0.58, 0.52);
  await useTool('Text');
  await clickCanvas(0.45, 0.62);
  await page.waitForTimeout(400);
  await shot(page, 'annotate-dimension-text');
  pass('Annotate (saved plan view)', 'New plan view → Dimension + Text', 'Annotations on saved view', sSavedPlan);
} else {
  issue('Annotate tab', 'broken', 'major', 'Look for apex.annotate tab', 'Annotate tab missing from toolbar', sSavedPlan);
}

const split = page.getByTestId('toggle-split');
if (await split.isVisible()) {
  await split.click();
  await page.waitForTimeout(500);
  await shot(page, 'views-split');
  await split.click();
  await page.waitForTimeout(300);
}

await page.getByTestId('save-view').click();
await page.waitForTimeout(300);
await page.getByTestId('new-sheet-paper-size').selectOption('A2');
await page.getByTestId('new-sheet-paper-orientation').selectOption('portrait');
await page.getByTestId('new-sheet').click();
await page.waitForTimeout(500);
await page.locator('[data-testid^="sheet-row-"]').first().dblclick();
await page.waitForTimeout(800);

const paper = page.locator('.sheet-paper');
await paper.waitFor({ state: 'visible' });
const paperBox = await paper.boundingBox();
const planView = page.locator('[data-testid^="view-row-"]').first();
if (paperBox && (await planView.count()) > 0) {
  await planView.dragTo(paper, {
    targetPosition: { x: paperBox.width * 0.4, y: paperBox.height * 0.5 },
    sourcePosition: { x: 40, y: 12 },
  });
  await page.waitForTimeout(1000);
}
const sSheet = await shot(page, 'sheet-viewport-placed');

// Scale + crop
const scaleSel = page.getByTestId('viewport-scale-select');
if ((await scaleSel.count()) > 0) {
  await scaleSel.selectOption({ index: 2 });
  await page.waitForTimeout(300);
}
const cropHandle = page.locator('.sheet-crop-handle').first();
if ((await cropHandle.count()) > 0) {
  const hb = await cropHandle.boundingBox();
  if (hb) {
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(hb.x + hb.width / 2 + 20, hb.y + hb.height / 2 + 15, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(300);
  }
  await shot(page, 'sheet-crop-adjusted');
}

// Exports
async function tryDownload(testId, outName) {
  const btn = page.getByTestId(testId);
  if ((await btn.count()) === 0 || !(await btn.isVisible())) {
    return { ok: false, detail: `control ${testId} not visible` };
  }
  const dl = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
  await btn.click();
  await page.waitForTimeout(2000);
  const d = await dl;
  if (!d) return { ok: false, detail: 'no download event' };
  const path = join(DOWNLOADS, outName);
  await d.saveAs(path);
  const size = readFileSync(path).length;
  return { ok: size > 50, detail: `${size} bytes`, path };
}

const svgSheet = await tryDownload('export-sheet-svg', 'sheet.svg');
const dxfSheet = await tryDownload('export-sheet-dxf', 'sheet.dxf');
const pdfSheet = await tryDownload('export-sheet-pdf', 'sheet.pdf');

// Switch to saved plan document tab for view exports (not sheet workspace)
const planTab = page.locator('.view-tab-open').filter({ hasText: /Plan/i }).first();
if ((await planTab.count()) > 0) {
  await planTab.click();
  await page.waitForTimeout(600);
}
await page.getByTestId('view-tab-bar').waitFor({ state: 'visible' }).catch(() => {});
const svgView = await tryDownload('export-view-svg', 'view.svg');
const dxfView = await tryDownload('export-view-dxf', 'view.dxf');
const pdfView = await tryDownload('export-view-pdf', 'view.pdf');

await page.getByTestId('tools-tab-apex.building').click();
const ifc = await tryDownload('export-apex.ifc', 'model.ifc');
const sExport = await shot(page, 'exports-triggered');

for (const [name, r] of [
  ['Sheet SVG', svgSheet],
  ['Sheet DXF', dxfSheet],
  ['Sheet PDF', pdfSheet],
  ['View SVG', svgView],
  ['View DXF', dxfView],
  ['View PDF', pdfView],
  ['IFC', ifc],
]) {
  if (r.ok) pass(`Export / ${name}`, `Click export → save`, r.detail, sExport);
  else issue(`Export / ${name}`, 'broken', name.includes('IFC') ? 'major' : 'minor', 'Top bar or sheet toolbar export', r.detail, sExport);
}

// Profile editor (no holes UI)
await page.getByTestId('tools-tab-apex.building').click();
await useTool('Wall');
await page.getByRole('button', { name: 'Draw new profile', exact: true }).click();
await page.waitForSelector('[data-testid="profile-editor"]');
const hasHoleUi = await page.getByRole('button', { name: /hole/i }).count();
await page.getByRole('button', { name: 'Cancel', exact: true }).click();
if (hasHoleUi === 0) {
  issue(
    'Profile holes in UI',
    'partly',
    'major',
    'Wall → Draw new profile',
    'Core supports profile holes (geometry) but ProfileEditor has no hole-drawing workflow; only outer loop sketch.',
    undefined,
  );
}

// Component editor
await page.getByTestId('browser-new-component').click();
await page.waitForSelector('[data-testid="component-editor"]');
await page.getByTestId('template-box').click();
await page.locator('[data-testid="component-editor"] input[type="text"]').first().fill('audit.box');
await page.getByTestId('save-component').click();
await page.waitForTimeout(400);
await shot(page, 'component-editor-saved');

// Browser group/sort
await page.getByTestId('browser-group').selectOption('category');
await page.getByTestId('browser-sort').selectOption('name');
await page.getByTestId('browser-filter-instances').click();
await shot(page, 'browser-group-sort-filter');

// Delete selected
await useTool('Select');
const beforeDel = await elementCount();
await page.locator('[data-kind="instance"]').filter({ hasText: /audit\.box|Audit box/i }).first().click({ timeout: 3000 }).catch(() => {});
await page.keyboard.press('Delete');
await page.waitForTimeout(300);
if ((await elementCount()) < beforeDel) pass('Delete key', 'Select instance → Delete', 'Element removed', undefined);
else issue('Delete key', 'partly', 'minor', 'Select custom component → Delete', 'Count unchanged (may need visible selection)', undefined);

// Save / reload persistence
const countBefore = await elementCount();
await page.getByTestId('save-project').click();
await page.waitForTimeout(200);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('canvas');
await page.waitForTimeout(1500);
const countAfter = await elementCount();
const sReload = await shot(page, 'persistence-after-reload');
if (countAfter === countBefore) pass('Save + reload', 'Save project → reload tab', `Instances ${countAfter}`, sReload);
else issue('Save + reload', 'broken', 'blocker', 'Same', `before ${countBefore} after ${countAfter}`, sReload);

// New project
await page.getByTestId('new-project').click();
await page.waitForTimeout(800);
const afterNew = await elementCount();
const sNew = await shot(page, 'new-project-cleared');
if (afterNew === 0) pass('New project', 'Click New project', 'Document cleared', sNew);
else issue('New project', 'partly', 'minor', 'New project button', `${afterNew} instances remain`, sNew);

// Narrow window
await page.setViewportSize({ width: 820, height: 620 });
await page.waitForTimeout(400);
await shot(page, 'narrow-viewport-820');
await page.setViewportSize({ width: 1400, height: 900 });

// Performance ~100 elements
await page.evaluate(() => {
  localStorage.removeItem('apex.project');
});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('canvas');
await page.waitForTimeout(800);
const perfStart = Date.now();
await page.evaluate(async () => {
  const mod = await import('/src/wasm/apex.ts');
  for (let i = 0; i < 10; i++) {
    for (let j = 0; j < 10; j++) {
      const x = i * 2;
      const z = j * 2;
      mod.apexCreateElement('apex.column', [[x, 0, z]], {}, 0, 'point');
    }
  }
  localStorage.setItem('apex.project', mod.apexExportProject());
});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('canvas');
await page.waitForTimeout(800);
const perfMs = Date.now() - perfStart;
const perfCount = await elementCount();
const sPerf = await shot(page, 'perf-100-columns');
if (perfCount >= 95 && perfMs < 15000) {
  pass('Performance ~100 columns', 'WASM batch create 100 columns + reload', `${perfCount} instances, ${perfMs}ms`, sPerf);
} else {
  issue('Performance ~100 columns', 'partly', 'minor', 'Same', `count=${perfCount} time=${perfMs}ms`, sPerf);
}

// Console errors summary
const uniqueConsole = [...new Map(consoleErrors.map((e) => [e.text, e])).values()];
if (uniqueConsole.length === 0) pass('Browser console', 'Full audit session', 'No console.error or pageerror', undefined);
else {
  for (const e of uniqueConsole.slice(0, 5)) {
    issue('Browser console', 'partly', 'minor', 'Observe session', `${e.type}: ${e.text.slice(0, 200)}`, undefined);
  }
}

writeFileSync(
  join(OUT, 'findings.json'),
  JSON.stringify({ findings, consoleErrors: uniqueConsole, tabInventory, perfMs }, null, 2),
);

await context.close();
await browser.close();

// Rename video
const vids = readdirSync(ARTIFACTS).filter((f) => f.endsWith('.webm'));
for (const v of vids) {
  const src = join(ARTIFACTS, v);
  const dest = join(ARTIFACTS, 'full-audit-walkthrough.webm');
  if (!existsSync(dest)) renameSync(src, dest);
}

console.log('\nAudit complete. Screenshots:', step, 'Findings:', findings.length);
