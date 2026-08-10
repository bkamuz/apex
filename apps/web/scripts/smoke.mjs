/**
 * End-to-end check of the Rust -> WASM -> WebGL2 flow.
 *
 * Exercises every built-in component through its generated tool, edits one
 * through the schema-driven inspector, and installs a user component at
 * runtime to prove the extension path works in a real browser.
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

const elementCount = () => page.locator('.element-list li').count();
const toolbarNames = () =>
  page.locator('.tools button').evaluateAll((els) => els.map((e) => e.textContent.trim()));

// --- 1. The toolbar is generated from the component registry ---------------
console.log('\n[1] toolbar generated from installed components');
const tools = await toolbarNames();
console.log('  toolbar:', tools.join(' | '));
for (const expected of ['Wall', 'Arc wall', 'Column', 'Round column', 'Beam']) {
  check(`"${expected}" button exists`, tools.includes(expected));
}

// --- 2. Place a room with the two-point Wall gesture -----------------------
console.log('\n[2] wall placement (two-point gesture)');
await useTool('Wall');
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

await useTool('Round column');
await clickCanvas(0.58, 0.68);
check('round column placed with one pick', (await elementCount()) === 6);

await useTool('Beam');
await clickCanvas(0.32, 0.5);
await clickCanvas(0.58, 0.5);
check('beam placed with two picks', (await elementCount()) === 7);

await useTool('Arc wall');
await clickCanvas(0.66, 0.5);
await clickCanvas(0.74, 0.58);
await clickCanvas(0.66, 0.66);
check('arc wall placed with three picks', (await elementCount()) === 8);

await page.screenshot({ path: `${OUT}/apex-02-all-components.png`, fullPage: true });

// --- 4. Schema-driven inspector -------------------------------------------
console.log('\n[4] inspector generated from the parameter schema');
await useTool('Select');
// Elements are listed by id, so pick the wall by name rather than by position.
await page.locator('.element-list li').filter({ hasText: /^Wall \d+/ }).first().click();
await page.waitForTimeout(300);

const labels = await page
  .locator('.inspector-body .field label')
  .evaluateAll((els) => els.map((e) => e.textContent.trim()));
console.log('  fields:', labels.join(' | '));
check('height field rendered from the schema', labels.some((l) => l.startsWith('Height')));
check('thickness field rendered from the schema', labels.some((l) => l.startsWith('Thickness')));

const heightInput = page.locator('.inspector-body input[type="number"]').first();
await heightInput.fill('5.0');
await page.getByRole('button', { name: 'Apply', exact: true }).click();
await page.waitForTimeout(400);
const heightAfter = await heightInput.inputValue();
check('height edit applied', Number(heightAfter) === 5, `input reads ${heightAfter}`);
await page.screenshot({ path: `${OUT}/apex-03-inspector-edit.png`, fullPage: true });

// --- 5. A user component installed at runtime ------------------------------
console.log('\n[5] user component installed through the module SDK');
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
await page.locator('.element-list li', { hasText: 'Planter' }).first().click();
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

const badge = await page.locator('.viewport-badge').textContent();
console.log('\nbadge:', badge);

await browser.close();

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:\n  - ${failures.join('\n  - ')}`);
  process.exitCode = 1;
} else {
  console.log('\nall checks passed');
}
