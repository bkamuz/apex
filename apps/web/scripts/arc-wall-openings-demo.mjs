/**
 * Demo screenshots: windows hosted on an arc wall seat with local tangent/normal.
 */
import { chromium } from 'playwright';
import { copyFileSync, mkdirSync } from 'fs';

const OUT = process.env.APEX_SMOKE_OUT ?? '/opt/cursor/artifacts/screenshots';
const MEDIA = '/cursor/stores/self/media/ap-57';
const BASE = process.env.APEX_SMOKE_URL ?? 'http://localhost:5173/';

mkdirSync(OUT, { recursive: true });
mkdirSync(MEDIA, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

await page.addInitScript(() => {
  localStorage.removeItem('apex.project');
  localStorage.removeItem('apex.browser');
  localStorage.setItem('apex.gettingStarted.dismissed', '1');
});

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('canvas');
await page.waitForFunction(() => window.__apexTest?.command);
await page.waitForTimeout(400);

const cmd = (c) => page.evaluate((command) => window.__apexTest.command(command), c);

// Thick semicircle wall (radius 4).
await cmd({
  op: 'create_element',
  component: 'apex.wall',
  placement_kind: 'three_point_arc',
  points: [
    [4, 0, 0],
    [0, 0, 4],
    [-4, 0, 0],
  ],
  params: { thickness: 0.4, height: 3.0 },
});
const wallId = await page.evaluate(() => {
  const walls = window.__apexTest.api.listElements().filter((e) => e.component_id === 'apex.wall');
  return walls[walls.length - 1]?.id ?? null;
});
if (!wallId) throw new Error('arc wall not created');
console.log('wall', wallId);

// Deliberately chord-ish picks (off the arc) — core must reproject + orient.
const picks = [
  [3.2, 0, 3.2], // ~45°
  [0.0, 0, 4.5], // near top, outside
  [-3.0, 0, 3.0], // ~135°
];

for (const [i, point] of picks.entries()) {
  await cmd({
    op: 'create_element',
    component: 'apex.window',
    points: [point],
    parent: wallId,
    params: { width: 1.0, height: 1.4, sill: 0.9 },
  });
  console.log(`window ${i + 1} at`, point);
}

// Switch off Plan (true top-down) so orbit camera can show 3D seating.
await page.getByRole('button', { name: '3D', exact: true }).click();
await page.waitForTimeout(300);

const origins = await page.evaluate(() =>
  window.__apexTest.api
    .listElements()
    .filter((e) => e.component_id === 'apex.window')
    .map((e) => ({ name: e.name, origin: e.anchors[0], r: Math.hypot(e.anchors[0][0], e.anchors[0][2]) })),
);
console.log('seated windows', origins);
for (const w of origins) {
  if (Math.abs(w.r - 4) > 0.05) throw new Error(`${w.name} not on arc radius: r=${w.r}`);
}

const shot = async (name) => {
  const path = `${OUT}/${name}.png`;
  await page.screenshot({ path, fullPage: true });
  copyFileSync(path, `${MEDIA}/${name}.png`);
  console.log('wrote', `${MEDIA}/${name}.png`);
};

await page.evaluate(() => {
  window.__apexTest.setCamera({
    target: [0, 1.2, 2.2],
    yaw: 0.55,
    pitch: 0.4,
    distance: 11,
  });
});
await page.waitForTimeout(500);
await shot('windows-on-arc-walls-fixed');

await page.evaluate(() => {
  window.__apexTest.setCamera({
    target: [2.5, 1.5, 2.5],
    yaw: -0.9,
    pitch: 0.25,
    distance: 6,
  });
});
await page.waitForTimeout(400);
await shot('windows-on-arc-walls-closeup');

await page.getByRole('button', { name: 'Plan', exact: true }).click().catch(() => {});
await page.waitForTimeout(300);
await shot('windows-on-arc-walls-plan');

await browser.close();
console.log('done');
