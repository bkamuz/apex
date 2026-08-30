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
  await page.getByRole('button', { name, exact: true }).click();
  await page.waitForTimeout(120);
}

const elementCount = () => page.locator('[data-kind="instance"]').count();
const toolbarNames = () =>
  page.locator('.tools button').evaluateAll((els) => els.map((e) => e.textContent.trim()));

// --- 1. Each first-party tool is a plugin; wall and column are one tool -----
console.log('\n[1] toolbar from plugins, one tool per type');
const tools = await toolbarNames();
console.log('  toolbar:', tools.join(' | '));
for (const expected of ['Select', 'Wall', 'Column', 'Beam']) {
  check(`"${expected}" button exists`, tools.includes(expected));
}
check('arc wall is not a second tool', !tools.includes('Arc wall'));
check('round is not a second column tool', !tools.includes('Round column'));
check('draw modes hide until Wall is active', !tools.includes('Line') && !tools.includes('Arc'));

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

// --- 3. Point, two-point and three-point gestures all work -----------------
console.log('\n[3] every other built-in gesture');
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

await page.screenshot({ path: `${OUT}/apex-02-all-components.png`, fullPage: true });

// --- 4. Schema-driven inspector -------------------------------------------
console.log('\n[4] inspector generated from the parameter schema');
await useTool('Select');
// Elements are listed by id, so pick the wall by name rather than by position.
await page.locator('[data-kind="instance"]').filter({ hasText: /^Wall \d+/ }).first().click();
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

// --- 5. Column profile is a parameter, not a second tool -------------------
console.log('\n[5] column profile switches on the same tool');
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
check('still a single column element', (await elementCount()) === 8);
await page.screenshot({ path: `${OUT}/apex-05-column-profile.png`, fullPage: true });

// --- 6. A user component installed at runtime ------------------------------
console.log('\n[6] user component installed through the module SDK');
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
check('user component placed like a built-in', afterPlanter === 9, `got ${afterPlanter}`);

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
console.log('\n[7] sketch editor edits a shared type dimension');
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
console.log('\n[8] mouse-drawn profile');
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
console.log('\n[9] project browser and persistence');
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

const badge = await page.locator('.viewport-badge').textContent();
console.log('\nbadge:', badge);

await browser.close();

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:\n  - ${failures.join('\n  - ')}`);
  process.exitCode = 1;
} else {
  console.log('\nall checks passed');
}
