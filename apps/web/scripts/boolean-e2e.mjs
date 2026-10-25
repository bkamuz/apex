/**
 * (see header) — boolean e2e reuses helpers, built through the UI like a user would:
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

await page.keyboard.press('f');
await page.waitForTimeout(300);
await frameSite(0);
await page.getByTestId('tools-tab-apex.building').click();
await useTool('Wall');
await clickW(1, 2); await clickW(9, 2);
await page.keyboard.press('Escape');
await useTool('Column');
await clickW(5, 2);
await page.keyboard.press('Escape');
await checkError('setup');
const cam = (yaw) => page.evaluate((yaw) => window.__apexTest.setCamera({ target: [5, 1.2, 2], distance: 7, yaw, pitch: 0.35 }), yaw);
await page.getByRole('button', { name: '3D', exact: true }).click(); await page.waitForTimeout(300);
await cam(0.6); await page.waitForTimeout(300);
await shot('before');
const pickAt = async (x, y, z) => { const p = await rawClient(x, z, y); await page.mouse.click(p[0], p[1]); await page.waitForTimeout(200); };
await page.keyboard.press('Escape');
await (await tabFor('Boolean')).click();
await page.waitForTimeout(150);
await pickAt(2, 1.5, 2);   // wall
await pickAt(5, 2.8, 2);   // column above the wall
await checkError('boolean');
await page.waitForTimeout(300);
await cam(0.6); await page.waitForTimeout(300);
await shot('wall-minus-column');
await page.locator('select').filter({ hasText: 'subtract' }).selectOption('intersect'); await page.waitForTimeout(400);
await shot('intersect');
await page.locator('select').filter({ hasText: 'intersect' }).selectOption('union'); await page.waitForTimeout(400);
await shot('union');
await page.locator('select').filter({ hasText: 'union' }).selectOption('subtract'); await page.waitForTimeout(400);
await cam(-2.4); await page.waitForTimeout(300);
await shot('wall-minus-column-back');
const raw = JSON.parse(await page.evaluate(() => localStorage.getItem('apex.project')));
const els = Object.values(raw.document?.elements ?? raw.elements ?? {});
console.log('components', els.map((e) => e.component_id));
await page.keyboard.press('Control+z'); await page.waitForTimeout(300);
await shot('after-undo');
console.log('problems', problems);
await browser.close();
