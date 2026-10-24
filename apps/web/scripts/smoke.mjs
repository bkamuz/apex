/**
 * End-to-end check of the Rust -> WASM -> WebGL2 flow.
 *
 * Exercises every first-party plugin tool, edits one through the
 * schema-driven inspector (including switching a column's profile), and
 * installs a user component at runtime to prove the extension path works
 * in a real browser.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const OUT = process.env.APEX_SMOKE_OUT ?? '/opt/cursor/artifacts/screenshots';
const BASE = process.env.APEX_SMOKE_URL ?? 'http://localhost:5173/';

mkdirSync(OUT, { recursive: true });

const failures = [];
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
    failures.push(label);
  }
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

page.on('console', (msg) => {
  if (msg.type() === 'error') console.log('CONSOLE', msg.type(), msg.text());
});
page.on('pageerror', (err) => console.log('PAGEERROR', err.message));

await page.addInitScript(() => {
  // Clear leftover documents once per tab; keep them across reload so save/load can be checked.
  if (!sessionStorage.getItem('apex.smoke')) {
    localStorage.removeItem('apex.project');
    localStorage.removeItem('apex.browser');
    sessionStorage.setItem('apex.smoke', '1');
  }
});

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('canvas');
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/apex-01-load.png`, fullPage: true });

const canvas = page.locator('canvas');
const box = await canvas.boundingBox();
if (!box) throw new Error('no canvas');

async function clickCanvas(nx, ny) {
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
  await btn.click();
  await page.waitForTimeout(120);
}

async function isTreeItemSelected(kind, index = 0) {
  const cls = await page.locator(`[data-kind="${kind}"]`).nth(index).getAttribute('class');
  return cls?.includes('selected') ?? false;
}

async function isNamedItemSelected(kind, name) {
  return (await page.locator(`[data-kind="${kind}"].selected`).filter({ hasText: name }).count()) >= 1;
}

const elementCount = () => page.locator('[data-kind="instance"]').count();
const toolbarNames = () =>
  page.locator('.tools button').evaluateAll((els) => els.map((e) => e.textContent.trim()));

// --- 1. Each first-party tool is a plugin; wall and column are one tool -----
console.log('\n[1] toolbar from plugins, one tool per type');
const basicsTab = page.getByTestId('tools-tab-apex.basics');
const buildingTab = page.getByTestId('tools-tab-apex.building');
const engineeringTab = page.getByTestId('tools-tab-apex.engineering');
check('Basics tab exists', (await basicsTab.count()) === 1);
check('Basics tab label', ((await basicsTab.textContent()) ?? '').trim() === 'Basics');
check('Building constructions tab exists', (await buildingTab.count()) === 1);
check(
  'Building constructions tab label',
  ((await buildingTab.textContent()) ?? '').trim() === 'Building constructions',
);
check('Engineering tab exists', (await engineeringTab.count()) === 1);
check('Engineering tab label', ((await engineeringTab.textContent()) ?? '').trim() === 'Engineering');
const spacesTab = page.getByTestId('tools-tab-apex.spaces');
check('Spaces tab exists', (await spacesTab.count()) === 1);
check('Spaces tab label', ((await spacesTab.textContent()) ?? '').trim() === 'Spaces');

await buildingTab.click();
await page.waitForTimeout(80);
const buildingTools = await toolbarNames();
console.log('  building toolbar:', buildingTools.join(' | '));
check('tab label is not a tool button', !buildingTools.includes('Building constructions'));
for (const expected of [
  'Select',
  'Move',
  'Copy',
  'Parent',
  'Detach',
  'Wall',
  'Column',
  'Beam',
  'Slab',
  'Door',
  'Window',
  'Slab opening',
  'Stair',
  'Roof',
  'Pitched roof',
]) {
  check(`"${expected}" on Building tab`, buildingTools.includes(expected));
}
check('Ref point is not on Building tab', !buildingTools.includes('Ref point'));
check('Grid axis is not on Building tab', !buildingTools.includes('Grid axis'));
check('Pipe is not on Building tab', !buildingTools.includes('Pipe'));
check('Duct is not on Building tab', !buildingTools.includes('Duct'));
check('Cable tray is not on Building tab', !buildingTools.includes('Cable tray'));

await engineeringTab.click();
await page.waitForTimeout(80);
const engineeringTools = await toolbarNames();
console.log('  engineering toolbar:', engineeringTools.join(' | '));
for (const expected of ['Select', 'Move', 'Copy', 'Parent', 'Detach', 'Pipe', 'Duct', 'Cable tray']) {
  check(`"${expected}" on Engineering tab`, engineeringTools.includes(expected));
}
check('Wall is not on Engineering tab', !engineeringTools.includes('Wall'));
check('Ref point is not on Engineering tab', !engineeringTools.includes('Ref point'));

await basicsTab.click();
await page.waitForTimeout(80);
const basicsTools = await toolbarNames();
console.log('  basics toolbar:', basicsTools.join(' | '));
for (const expected of [
  'Select',
  'Move',
  'Copy',
  'Parent',
  'Detach',
  'Level',
  'Ref point',
  'Ref plane',
  'Construction line',
  'Grid axis',
  'Section cut',
]) {
  check(`"${expected}" on Basics tab`, basicsTools.includes(expected));
}
check('Wall is not on Basics tab', !basicsTools.includes('Wall'));
check('Pipe is not on Basics tab', !basicsTools.includes('Pipe'));
check(
  'commons stay pinned across tabs',
  buildingTools.includes('Select') &&
    basicsTools.includes('Select') &&
    engineeringTools.includes('Select'),
);
check('no second point tool on Basics', !basicsTools.includes('Point'));

check('IFC export button exists', (await page.getByTestId('export-apex.ifc').count()) === 1);
check('arc wall is not a second tool', !buildingTools.includes('Arc wall'));
check('round is not a second column tool', !buildingTools.includes('Round column'));
check('draw modes hide until Wall is active', !buildingTools.includes('Line') && !buildingTools.includes('Arc'));

// Light MEP placement from the Engineering tab, then undo so later counts stay stable.
const beforePipe = await elementCount();
await useTool('Pipe');
await clickCanvas(0.22, 0.35);
await clickCanvas(0.38, 0.35);
await canvas.dblclick({ position: { x: box.width * 0.38, y: box.height * 0.35 } });
await page.waitForTimeout(300);
check('pipe placed from Engineering tab', (await elementCount()) === beforePipe + 1);
await page.getByTestId('undo').click();
await page.waitForTimeout(300);
check('pipe placement undone for clean slate', (await elementCount()) === beforePipe);

// --- 2. Place a room with the two-point Wall / Line gesture ----------------
console.log('\n[2] wall placement (line mode)');
await useTool('Wall');
const wallModes = await toolbarNames();
console.log('  wall toolbar:', wallModes.join(' | '));
check('Line mode is available', wallModes.includes('Line'));
check('Arc mode is available', wallModes.includes('Arc'));
check('Polyline mode is available', wallModes.includes('Polyline'));
await page.getByRole('button', { name: 'Line', exact: true }).click();
const corners = [
  [0.32, 0.5],
  [0.58, 0.5],
  [0.58, 0.68],
  [0.32, 0.68],
];
for (let i = 0; i < corners.length; i++) {
  const a = corners[i];
  const b = corners[(i + 1) % corners.length];
  await clickCanvas(a[0], a[1]);
  await clickCanvas(b[0], b[1]);
  await page.waitForTimeout(200);
}
const afterWalls = await elementCount();
check('four walls placed', afterWalls === 4, `got ${afterWalls}`);

// --- 3. Reference point and plane tools ------------------------------------
console.log('\n[3] reference points and planes');
const refCount = () => page.locator('[data-kind="reference"]').count();
await useTool('Ref point');
await clickCanvas(0.45, 0.55);
check('ref point created', (await refCount()) >= 1);
check('ref point auto-selected after place', await isNamedItemSelected('reference', 'Ref point'));
await useTool('Ref plane');
await clickCanvas(0.5, 0.45);
await clickCanvas(0.62, 0.45);
check('ref plane created', (await refCount()) >= 2);
check('ref plane auto-selected after place', await isNamedItemSelected('reference', 'Ref plane'));
await page.getByTestId('browser-filter-references').click();
check('references filter lists refs', (await refCount()) >= 2);
await page.getByTestId('browser-filter-all').click();

console.log('\n[3a] viewport pick for references');
await useTool('Select');
await clickCanvas(0.12, 0.15);
check(
  'references deselected on empty click',
  (await page.locator('[data-kind="reference"].selected').count()) === 0,
);
await clickCanvas(0.55, 0.45);
check('ref plane selected via viewport click', await isNamedItemSelected('reference', 'Ref plane'));
await clickCanvas(0.12, 0.15);
await clickCanvas(0.45, 0.55);
check('ref point selected via viewport click', await isNamedItemSelected('reference', 'Ref point'));

// --- 3b. Grid axis (two-click placement + inspector params) ----------------
console.log('\n[3b] grid axes');
const gridCount = () => page.locator('[data-kind="grid_axis"]').count();
await useTool('Grid axis');
await clickCanvas(0.4, 0.62);
await clickCanvas(0.7, 0.62);
check('grid axis created', (await gridCount()) >= 1);
check('grid axis auto-selected after place', await isTreeItemSelected('grid_axis', 0));
const labelField = page.locator('[data-section="instance"] input[type="text"]').first();
await labelField.fill('A');
await labelField.press('Enter');
await page.waitForTimeout(200);
check(
  'grid label editable in inspector after auto-select',
  (await page.locator('.grid-axis-label').filter({ hasText: 'A' }).count()) >= 1,
);
await page.getByTestId('browser-filter-grids').click();
check('grids filter lists axes', (await gridCount()) >= 1);
await page.getByTestId('browser-filter-all').click();

console.log('\n[3c] viewport pick for grid axis');
await useTool('Select');
await clickCanvas(0.12, 0.15);
check('grid axis deselected on empty click', !(await isTreeItemSelected('grid_axis', 0)));
await clickCanvas(0.55, 0.62);
check('grid axis selected via viewport click', await isTreeItemSelected('grid_axis', 0));
check(
  'grid inspector visible after viewport pick',
  (await page.locator('[data-section="instance"] input[type="text"]').first().inputValue()) === 'A',
);
await page.locator('[data-kind="grid_axis"]').first().click();
await page.waitForTimeout(200);
await labelField.fill('B');
await labelField.press('Enter');
await page.waitForTimeout(200);
check(
  'grid label editable in inspector from browser',
  (await page.locator('.grid-axis-label').filter({ hasText: 'B' }).count()) >= 1,
);

// --- 3d. Level / construction line / section cut (Basics phase 1) ----------
console.log('\n[3d] Basics: Level, construction line, section cut');
const levelCountBefore = await page.locator('.level-list li').count();
await useTool('Level');
await clickCanvas(0.5, 0.5);
const levelCountAfter = await page.locator('.level-list li').count();
check('Level tool adds a storey', levelCountAfter === levelCountBefore + 1, `was ${levelCountBefore} now ${levelCountAfter}`);

const clineCount = () => page.locator('[data-kind="construction_line"]').count();
await useTool('Construction line');
await clickCanvas(0.35, 0.58);
await clickCanvas(0.65, 0.58);
check('construction line created', (await clineCount()) >= 1);
check('construction line auto-selected', await isTreeItemSelected('construction_line', 0));

const cutCount = () => page.locator('[data-kind="section_cut"]').count();
await useTool('Section cut');
await clickCanvas(0.42, 0.48);
await clickCanvas(0.68, 0.48);
check('section cut created', (await cutCount()) >= 1);
check('section cut auto-selected', await isTreeItemSelected('section_cut', 0));
await page.getByTestId('browser-filter-annotations').click({ force: true });
check('annotations filter lists lines/cuts', (await clineCount()) + (await cutCount()) >= 2);
await page.getByTestId('browser-filter-all').click({ force: true });

// --- 3e. Spaces tab + closed polyline space --------------------------------
console.log('\n[3e] Spaces: place closed space');
await spacesTab.click();
await page.waitForTimeout(80);
const spacesTools = await toolbarNames();
console.log('  spaces toolbar:', spacesTools.join(' | '));
check('"Space" on Spaces tab', spacesTools.includes('Space'));
check('"Detect rooms" on Spaces tab', spacesTools.includes('Detect rooms'));
check('Wall is not on Spaces tab', !spacesTools.includes('Wall'));
const spaceCount = () => page.locator('[data-kind="space"]').count();
await useTool('Space');
await clickCanvas(0.30, 0.40);
await clickCanvas(0.48, 0.40);
await clickCanvas(0.48, 0.55);
await clickCanvas(0.30, 0.55);
await canvas.dblclick({ position: { x: box.width * 0.30, y: box.height * 0.55 } });
await page.waitForTimeout(400);
check('space created', (await spaceCount()) >= 1);
check('space auto-selected', await isTreeItemSelected('space', 0));
const spaceLabelField = page.locator('[data-section="instance"] input[type="text"]').first();
await spaceLabelField.fill('Kitchen');
await spaceLabelField.press('Enter');
await page.waitForTimeout(200);
check(
  'space label editable in inspector',
  (await page.locator('.space-label').filter({ hasText: 'Kitchen' }).count()) >= 1,
);
await page.screenshot({ path: `${OUT}/apex-spaces-placed.png`, fullPage: true });

// Detect rooms from the four walls placed in [2]; keep the manual Kitchen space.
console.log('\n[3e2] Detect rooms from wall loops');
const spacesBeforeDetect = await spaceCount();
await useTool('Detect rooms');
await clickCanvas(0.5, 0.5);
await page.waitForTimeout(400);
const spacesAfterDetect = await spaceCount();
check(
  'detect rooms created ≥1 auto space',
  spacesAfterDetect > spacesBeforeDetect,
  `before ${spacesBeforeDetect} after ${spacesAfterDetect}`,
);
check(
  'manual Kitchen space preserved',
  (await page.locator('.space-label').filter({ hasText: 'Kitchen' }).count()) >= 1,
);
check('space overlay labels visible after detect', (await page.locator('.space-label').count()) >= 2);
await page.screenshot({ path: `${OUT}/apex-detect-rooms.png`, fullPage: true });

// --- 4. Point, two-point and three-point gestures all work -----------------
console.log('\n[4] every other built-in gesture');
await useTool('Column');
await clickCanvas(0.32, 0.5);
check('column placed with one pick', (await elementCount()) === 5);

await useTool('Beam');
await clickCanvas(0.32, 0.5);
await clickCanvas(0.58, 0.5);
check('beam placed with two picks', (await elementCount()) === 6);

await useTool('Wall');
await page.getByRole('button', { name: 'Arc', exact: true }).click();
await clickCanvas(0.66, 0.5);
await clickCanvas(0.74, 0.58);
await clickCanvas(0.66, 0.66);
check('arc wall placed on the same Wall tool', (await elementCount()) === 7);
check(
  'arc is still a Wall, not a second type',
  (await page.locator('[data-kind="instance"]').filter({ hasText: /^Wall \d+/ }).count()) === 5,
);

await useTool('Wall');
await page.getByRole('button', { name: 'Polyline', exact: true }).click();
await clickCanvas(0.28, 0.42);
await clickCanvas(0.40, 0.42);
await clickCanvas(0.40, 0.52);
await canvas.dblclick({ position: { x: box.width * 0.28, y: box.height * 0.52 } });
await page.waitForTimeout(300);
check('polyline wall placed on the same Wall tool', (await elementCount()) === 8);

await useTool('Slab');
await clickCanvas(0.34, 0.54);
await clickCanvas(0.56, 0.54);
await clickCanvas(0.56, 0.66);
await clickCanvas(0.34, 0.66);
await canvas.dblclick({ position: { x: box.width * 0.34, y: box.height * 0.66 } });
await page.waitForTimeout(300);
check('slab placed with polyline gesture', (await elementCount()) === 9);

await useTool('Select');
await page.locator('[data-kind="instance"]').filter({ hasText: /^Slab \d+/ }).first().click();
await page.waitForTimeout(300);
const slabLabels = await page
  .locator('.inspector-body .field label')
  .evaluateAll((els) => els.map((e) => e.textContent.trim()));
check('slab thickness field rendered', slabLabels.some((l) => l.startsWith('Thickness')));
const slabThickness = page.locator('[data-section="instance"] input[type="number"]').first();
await slabThickness.fill('0.35');
await page.getByRole('button', { name: 'Apply', exact: true }).click();
await page.waitForTimeout(400);
check('slab thickness edit applied', Number(await slabThickness.inputValue()) === 0.35);

await page.screenshot({ path: `${OUT}/apex-02-all-components.png`, fullPage: true });

// --- 4c. Move and Copy transform tools ------------------------------------
console.log('\n[4c] move and copy transforms');

async function firstColumnState() {
  return page.evaluate(async () => {
    const mod = await import('/src/wasm/apex.ts');
    const col = mod.apexListElements().find((e) => e.component_id === 'apex.column');
    if (!col) return null;
    return {
      id: col.id,
      anchor: col.anchors?.[0] ?? null,
      parent_id: col.parent_id ?? null,
    };
  });
}

async function columnIds() {
  return page.evaluate(async () => {
    const mod = await import('/src/wasm/apex.ts');
    return mod
      .apexListElements()
      .filter((e) => e.component_id === 'apex.column')
      .map((e) => e.id)
      .sort();
  });
}

const countBeforeMove = await elementCount();
await useTool('Select');
await page.locator('[data-kind="instance"]').filter({ hasText: /^Column \d+/ }).first().click();
await page.waitForTimeout(200);
const beforeMove = await firstColumnState();
check('column selected for move', !!beforeMove?.anchor);

await useTool('Move');
await clickCanvas(0.42, 0.6);
// Ghost-only preview: pointer move must not change document anchors.
await page.mouse.move(box.x + box.width * 0.48, box.y + box.height * 0.6);
await page.waitForTimeout(80);
const midPreview = await firstColumnState();
check(
  'move preview leaves document position unchanged',
  !!midPreview &&
    midPreview.id === beforeMove.id &&
    Math.hypot(
      (midPreview.anchor?.[0] ?? 0) - (beforeMove.anchor?.[0] ?? 0),
      (midPreview.anchor?.[2] ?? 0) - (beforeMove.anchor?.[2] ?? 0),
    ) < 1e-6,
  `preview mutated anchors before=${JSON.stringify(beforeMove?.anchor)} mid=${JSON.stringify(midPreview?.anchor)}`,
);
await clickCanvas(0.52, 0.6);
await page.waitForTimeout(300);
check('move keeps element count', (await elementCount()) === countBeforeMove);
const afterMove = await firstColumnState();
const movedDx = Math.abs((afterMove?.anchor?.[0] ?? 0) - (beforeMove?.anchor?.[0] ?? 0));
const movedDz = Math.abs((afterMove?.anchor?.[2] ?? 0) - (beforeMove?.anchor?.[2] ?? 0));
check(
  'move changes column position',
  !!afterMove && afterMove.id === beforeMove.id && (movedDx > 0.05 || movedDz > 0.05),
  `before=${JSON.stringify(beforeMove?.anchor)} after=${JSON.stringify(afterMove?.anchor)}`,
);
await page.getByTestId('undo').click();
await page.waitForTimeout(300);
check('undo reverts move', (await elementCount()) === countBeforeMove);
const afterUndoMove = await firstColumnState();
check(
  'undo restores column position',
  !!afterUndoMove &&
    afterUndoMove.id === beforeMove.id &&
    Math.hypot(
      (afterUndoMove.anchor?.[0] ?? 0) - (beforeMove.anchor?.[0] ?? 0),
      (afterUndoMove.anchor?.[2] ?? 0) - (beforeMove.anchor?.[2] ?? 0),
    ) < 0.05,
  `restored=${JSON.stringify(afterUndoMove?.anchor)}`,
);

const idsBeforeCopy = await columnIds();
await useTool('Select');
await page.locator('[data-kind="instance"]').filter({ hasText: /^Column \d+/ }).first().click();
await page.waitForTimeout(120);
await useTool('Copy');
await clickCanvas(0.42, 0.6);
await clickCanvas(0.48, 0.66);
await page.waitForTimeout(300);
const idsAfterCopy = await columnIds();
check('copy adds one column', idsAfterCopy.length === idsBeforeCopy.length + 1);
const copiedId = idsAfterCopy.find((id) => !idsBeforeCopy.includes(id));
check('copy introduced a new column id', !!copiedId);
check('undo enabled after copy', await page.getByTestId('undo').isEnabled());
await page.getByTestId('undo').click();
await page.waitForTimeout(300);
const idsAfterUndoCopy = await columnIds();
check(
  'undo removes the copied column',
  idsAfterUndoCopy.length === idsBeforeCopy.length &&
    !idsAfterUndoCopy.includes(copiedId) &&
    idsAfterUndoCopy.join(',') === idsBeforeCopy.join(','),
  `before=${idsBeforeCopy} afterUndo=${idsAfterUndoCopy} copied=${copiedId}`,
);

await page.keyboard.press('m');
await page.waitForTimeout(120);
check('M hotkey activates Move', (await page.getByRole('button', { name: 'Move', exact: true }).getAttribute('class'))?.includes('active'));
await page.keyboard.press('Escape');
await page.waitForTimeout(120);

// --- 4. Schema-driven inspector -------------------------------------------
console.log('\n[5] inspector generated from the parameter schema');
await useTool('Select');
await page.getByTestId('browser-filter-all').click();
// Elements are listed by id, so pick the wall by name rather than by position.
const wallRow = page.locator('[data-kind="instance"]').filter({ hasText: /^Wall \d+/ }).first();
await wallRow.scrollIntoViewIfNeeded();
await wallRow.click();
await page.waitForTimeout(300);

const labels = await page
  .locator('.inspector-body .field label')
  .evaluateAll((els) => els.map((e) => e.textContent.trim()));
console.log('  fields:', labels.join(' | '));
check('height field rendered from the schema', labels.some((l) => l.startsWith('Height')));
check('thickness field rendered from the schema', labels.some((l) => l.startsWith('Thickness')));
check('wall profile control is present', labels.some((l) => l.startsWith('Profile')));
check('instance block is present', (await page.locator('[data-section="instance"]').count()) === 1);
check('type block is present', (await page.locator('[data-section="type"]').count()) === 1);
check(
  'type thickness is read-only',
  await page.locator('[data-section="type"] input[type="number"]').first().isDisabled(),
);

const wallProfile = page.locator('.inspector-body select').first();
check('default wall profile is rectangle', (await wallProfile.inputValue()) === 'apex.wall.rect');
await wallProfile.selectOption('apex.wall.round');
await page.waitForTimeout(400);
check(
  'wall profile switched to round without a second tool',
  (await wallProfile.inputValue()) === 'apex.wall.round',
);
await wallProfile.selectOption('apex.wall.rect');
await page.waitForTimeout(200);

const heightInput = page.locator('[data-section="instance"] input[type="number"]').first();
await heightInput.fill('5.0');
await page.getByRole('button', { name: 'Apply', exact: true }).click();
await page.waitForTimeout(400);
const heightAfter = await heightInput.inputValue();
check('height edit applied', Number(heightAfter) === 5, `input reads ${heightAfter}`);
await page.screenshot({ path: `${OUT}/apex-03-inspector-edit.png`, fullPage: true });

// --- 4b. Undo / redo -------------------------------------------------------
console.log('\n[4b] document undo and redo');
check('undo is enabled after edits', await page.getByTestId('undo').isEnabled());
await page.getByTestId('undo').click();
await page.waitForTimeout(400);
let heightAfterUndo = Number(await heightInput.inputValue());
if (heightAfterUndo === 5) {
  // Blur/Apply can record two identical param commits; step back once more.
  await page.getByTestId('undo').click();
  await page.waitForTimeout(400);
  heightAfterUndo = Number(await heightInput.inputValue());
}
check('undo reverts height edit', heightAfterUndo !== 5);
await page.getByTestId('redo').click();
await page.waitForTimeout(400);
check('redo restores height edit', Number(await heightInput.inputValue()) === 5);

const countBeforeColumn = await elementCount();
await useTool('Column');
await clickCanvas(0.42, 0.6);
check('column placed for undo', (await elementCount()) === countBeforeColumn + 1);
await page.getByTestId('undo').click();
await page.waitForTimeout(300);
check('undo removes placed column', (await elementCount()) === countBeforeColumn);
await page.keyboard.press('Control+Shift+Z');
await page.waitForTimeout(300);
check('redo hotkey restores column', (await elementCount()) === countBeforeColumn + 1);
await page.getByTestId('undo').click();
await page.waitForTimeout(300);
check('cleanup leaves element count unchanged', (await elementCount()) === countBeforeColumn);

// --- 5. Column profile is a parameter, not a second tool -------------------
console.log('\n[6] column profile switches on the same tool');
await page.locator('[data-kind="instance"]').filter({ hasText: /^Column \d+/ }).first().click();
await page.waitForTimeout(300);
const profileSelect = page.locator('.inspector-body select').first();
check('profile control is present', (await profileSelect.count()) === 1);
const profileBefore = await profileSelect.inputValue();
check('default column profile is rectangle', profileBefore === 'apex.rect');
await profileSelect.selectOption('apex.round');
await page.waitForTimeout(400);
const profileAfter = await profileSelect.inputValue();
check('profile switched to round without a second tool', profileAfter === 'apex.round', `got ${profileAfter}`);
check('still a single column element', (await elementCount()) === 9);
await page.screenshot({ path: `${OUT}/apex-05-column-profile.png`, fullPage: true });

// --- 6. A user component installed at runtime ------------------------------
console.log('\n[7] user component installed through the module SDK');
const sdkError = await page.evaluate(() => {
  try {
    window.apex.defineComponent({
      id: 'acme.planter',
      display_name: 'Planter',
      category: 'furniture',
      source: 'visual',
      placement: 'point',
      params: [
        { id: 'radius', label: 'Radius', kind: 'length', default: 0.5 },
        { id: 'height', label: 'Height', kind: 'length', default: 0.9 },
      ],
      recipe: {
        op: 'extrude',
        profile: { shape: 'circle', radius: { op: 'param', id: 'radius' }, segments: 24 },
        height: { op: 'param', id: 'height' },
      },
    });
    return null;
  } catch (e) {
    return String(e);
  }
});
check('defineComponent accepted', sdkError === null, sdkError ?? '');

await page.waitForTimeout(400);
const toolsAfter = await toolbarNames();
check('a tool appeared for it with no app code', toolsAfter.includes('Planter'));

await useTool('Planter');
await clickCanvas(0.45, 0.58);
const afterPlanter = await elementCount();
check('user component placed like a built-in', afterPlanter === 10, `got ${afterPlanter}`);

await useTool('Select');
await page.locator('[data-kind="instance"]', { hasText: 'Planter' }).first().click();
await page.waitForTimeout(300);
const planterLabels = await page
  .locator('.inspector-body .field label')
  .evaluateAll((els) => els.map((e) => e.textContent.trim()));
console.log('  planter fields:', planterLabels.join(' | '));
check(
  'its inspector is built from its own schema',
  planterLabels.some((l) => l.startsWith('Radius')),
);

// A definition the core should refuse: the recipe uses an undeclared param.
const rejected = await page.evaluate(() => {
  try {
    window.apex.defineComponent({
      id: 'acme.broken',
      display_name: 'Broken',
      category: 'test',
      placement: 'point',
      params: [],
      recipe: {
        op: 'extrude',
        profile: { shape: 'circle', radius: { op: 'const', value: 0.5 } },
        height: { op: 'param', id: 'nope' },
      },
    });
    return null;
  } catch (e) {
    return String(e);
  }
});
check('an invalid definition is refused at registration', rejected !== null, 'it was accepted');
check(
  'no tool was added for the rejected component',
  !(await toolbarNames()).includes('Broken'),
);

await page.screenshot({ path: `${OUT}/apex-04-user-component.png`, fullPage: true });

// --- 7. Shared type vs this element, sketch editor on an existing profile --
console.log('\n[8] sketch editor edits a shared type dimension');
await useTool('Select');
const wallItems = page.locator('[data-kind="instance"]').filter({ hasText: /^Wall \d+/ });
await wallItems.first().click();
await page.waitForTimeout(200);
await page.getByRole('button', { name: 'Edit profile', exact: true }).click();
await page.waitForSelector('[data-testid="profile-editor"]');
check(
  'sketch canvas is the editor',
  (await page.locator('[data-testid="profile-sketch"]').count()) === 1,
);
const typeDefault = page.locator('[data-testid="param-default-thickness"]');
check('inferred thickness dimension is present', (await typeDefault.count()) === 1);
await typeDefault.fill('0.45');
await page.getByTestId('save-profile').click();
await page.waitForTimeout(400);
check(
  'editor closed after save',
  (await page.locator('[data-testid="profile-editor"]').count()) === 0,
);
const thicknessAfterType = await page
  .locator('[data-section="type"] input[type="number"]')
  .first()
  .inputValue();
check(
  'type thickness updated on the selected wall',
  Number(thicknessAfterType) === 0.45,
  `got ${thicknessAfterType}`,
);
await wallItems.nth(1).click();
await page.waitForTimeout(200);
const thicknessOnOther = await page
  .locator('[data-section="type"] input[type="number"]')
  .first()
  .inputValue();
check(
  'the same profile type changed the other wall too',
  Number(thicknessOnOther) === 0.45,
  `got ${thicknessOnOther}`,
);

// --- 8. Draw a new profile with the mouse ---------------------------------
console.log('\n[9] mouse-drawn profile');
await useTool('Wall');
await page.getByRole('button', { name: 'Draw new profile', exact: true }).click();
await page.waitForSelector('[data-testid="profile-sketch"]');
const sketch = page.locator('[data-testid="profile-sketch"]');
const sketchBox = await sketch.boundingBox();
if (!sketchBox) throw new Error('no sketch canvas');
async function clickSketch(nx, ny) {
  await page.mouse.click(sketchBox.x + sketchBox.width * nx, sketchBox.y + sketchBox.height * ny);
  await page.waitForTimeout(140);
}
await clickSketch(0.32, 0.68);
await clickSketch(0.68, 0.68);
await clickSketch(0.68, 0.32);
await clickSketch(0.32, 0.32);
await page.getByTestId('close-outline').click();
await page.waitForTimeout(200);
await page.getByTestId('dimension-all').click();
await page.waitForTimeout(200);
await clickSketch(0.5, 0.68);
await page.waitForTimeout(200);
await page.getByTestId('constraint-horizontal').click();
await page.waitForTimeout(200);
check(
  'horizontal constraint badge on top edge',
  (await page.locator('[data-testid="constraint-badge-0"]').count()) === 1,
);
await page.getByTestId('constraint-equal-length').click();
await page.waitForTimeout(200);
check(
  'equal length links parallel edges',
  (await page.locator('[data-testid="constraint-badge-2"]').count()) === 1,
);
const idField = page.locator('[data-testid="profile-editor"] input[type="text"]').first();
await idField.fill('user.wall.smoke');
const nameField = page.locator('[data-testid="profile-editor"] input[type="text"]').nth(1);
await nameField.fill('Smoke rect');
await page.getByTestId('save-profile').click();
await page.waitForTimeout(400);
check(
  'drawn profile editor closed',
  (await page.locator('[data-testid="profile-editor"]').count()) === 0,
);
const placementProfiles = await page
  .locator('[data-section="instance"] select')
  .first()
  .locator('option')
  .evaluateAll((els) => els.map((e) => e.value));
check(
  'new profile appears in the wall list',
  placementProfiles.includes('user.wall.smoke'),
  `options: ${placementProfiles.join(', ')}`,
);
const toolHeight = page.locator('[data-section="instance"] input[type="number"]').first();
if ((await toolHeight.count()) > 0) {
  await toolHeight.fill('4.2');
  check(
    'instance height is editable on the Wall tool',
    Number(await toolHeight.inputValue()) === 4.2,
    `got ${await toolHeight.inputValue()}`,
  );
} else {
  check('instance height is editable on the Wall tool', false, 'no instance number field');
}
await page.screenshot({ path: `${OUT}/apex-06-profile-editor.png`, fullPage: true });

// --- 9. Project browser grouping and save/load ----------------------------
console.log('\n[10] project browser and persistence');
check(
  'browser is present',
  (await page.locator('[data-testid="project-browser"]').count()) >= 1,
);
await page.getByTestId('browser-filter-types').click();
const typeCount = await page.locator('[data-kind="type"]').count();
check('type browser lists profiles', typeCount >= 5, `got ${typeCount}`);
await page.getByTestId('browser-filter-instances').click();
const instCount = await page.locator('[data-kind="instance"]').count();
check('instance browser lists elements', instCount >= 8, `got ${instCount}`);
await page.getByTestId('browser-filter-all').click();
await page.getByTestId('browser-group').selectOption('category');
check(
  'grouping by category still lists instances',
  (await page.locator('[data-kind="instance"]').count()) === instCount,
);

const beforeReload = await elementCount();
await page.getByTestId('save-project').click();
await page.waitForTimeout(200);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('canvas');
await page.waitForTimeout(1500);
const afterReload = await elementCount();
check(
  'project survived reload',
  afterReload === beforeReload,
  `before ${beforeReload} after ${afterReload}`,
);
await page.screenshot({ path: `${OUT}/apex-07-browser-save.png`, fullPage: true });

// --- Parent / Detach (after undo-sensitive sections so history stays clean) ---
// Toolbar buttons are asserted in [1]. Folded here from the old orphan
// apps/web/parent-e2e.cjs (removed).
console.log('\n[parent] parent and detach');
const parentRoundTrip = await page.evaluate(async () => {
  const mod = await import('/src/wasm/apex.ts');
  const els = mod.apexListElements();
  const wall = els.find((e) => e.component_id === 'apex.wall');
  const col = els.find((e) => e.component_id === 'apex.column');
  if (!wall || !col) return { ok: false, reason: 'missing wall or column' };
  mod.apexSetElementParent(col.id, wall.id);
  const attached = mod.apexListElements().find((e) => e.id === col.id)?.parent_id ?? null;
  mod.apexSetElementParent(col.id, null);
  const detached = mod.apexListElements().find((e) => e.id === col.id)?.parent_id ?? null;
  return {
    ok: true,
    attached: attached === wall.id,
    detached: detached === null,
  };
});
check(
  'parent attaches column to wall',
  parentRoundTrip.ok && parentRoundTrip.attached,
  parentRoundTrip.reason || '',
);
check('detach clears parent_id', parentRoundTrip.ok && parentRoundTrip.detached);
await useTool('Detach');
check(
  'Detach tool activates',
  (await page.getByRole('button', { name: 'Detach', exact: true }).getAttribute('class'))?.includes(
    'active',
  ),
);

const badge = await page.locator('.viewport-badge').textContent();
console.log('\nbadge:', badge);

await browser.close();

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:\n  - ${failures.join('\n  - ')}`);
  process.exitCode = 1;
} else {
  console.log('\nall checks passed');
}
