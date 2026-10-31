/**
 * AP-35 verification: house Move join stretch via move_elements command.
 */
import { mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const OUT = '/opt/cursor/artifacts/screenshots/ap-35';
const MEDIA = '/cursor/stores/self/media/ap-35';
mkdirSync(OUT, { recursive: true });
mkdirSync(MEDIA, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.setDefaultTimeout(45000);
await page.addInitScript(() => {
  try { localStorage.setItem('apex.gettingStarted.dismissed', '1'); } catch {}
});
await page.goto('http://127.0.0.1:5173/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__apexTest?.loadSampleProject, null, { timeout: 45000 });

async function setupCamera() {
  await page.evaluate(() => {
    const cam = window.__apexTest.getCamera();
    if (cam) {
      window.__apexTest.setCamera({
        ...cam,
        pitch: -0.55,
        yaw: 0.7,
        distance: 28,
        target: [5, 1.5, 4],
      });
    }
  });
  await page.waitForTimeout(250);
}

async function save(name) {
  const art = `${OUT}/${name}`;
  await page.screenshot({ path: art });
  copyFileSync(art, `${MEDIA}/${name}`);
  return `${MEDIA}/${name}`;
}

async function wallAnchorsNear(pick) {
  const id = await page.evaluate((p) => window.__apexTest.selectNear('wall', p), pick);
  // Read anchors from the properties path via command query if available;
  // otherwise probe edit handles after selecting (joinable → endpoints only).
  const handles = await page.evaluate(() => window.__apexTest.getEditHandles());
  return { id, handles };
}

await page.evaluate(() => window.__apexTest.loadSampleProject());
await page.waitForTimeout(800);
await setupCamera();
const before = await save('01-before-house.png');

// Move south facade wall (near z=0)
const southId = await page.evaluate(() =>
  window.__apexTest.selectNear('wall', [5, 1.2, 0]),
);
await page.evaluate(
  (id) => window.__apexTest.command({ op: 'move_elements', ids: [id], delta: [0, 0, -1.5] }),
  southId,
);
await page.waitForTimeout(600);
await setupCamera();
const afterSouth = await save('02-after-move-south.png');

// Check mid tip followed and hosts not spiked: select mid partition
const midAfterSouth = await wallAnchorsNear([5, 1.2, -0.5]);

// Reload and move mid partition along length (previous kink case)
await page.evaluate(() => window.__apexTest.loadSampleProject());
await page.waitForTimeout(600);
await setupCamera();
const midId = await page.evaluate(() =>
  window.__apexTest.selectNear('wall', [5, 1.2, 4]),
);
await page.evaluate(
  (id) => window.__apexTest.command({ op: 'move_elements', ids: [id], delta: [0, 0, -2] }),
  midId,
);
await page.waitForTimeout(600);
await setupCamera();
const afterMid = await save('03-after-move-mid-along.png');

// After along-length mid move, south should still be straight — endpoint handles only
const southHandles = await wallAnchorsNear([5, 1.2, 0]);
const midHandles = await wallAnchorsNear([5, 1.2, 4]);

// Move mid perpendicular
await page.evaluate(() => window.__apexTest.loadSampleProject());
await page.waitForTimeout(600);
await setupCamera();
const midId2 = await page.evaluate(() =>
  window.__apexTest.selectNear('wall', [5, 1.2, 4]),
);
await page.evaluate(
  (id) => window.__apexTest.command({ op: 'move_elements', ids: [id], delta: [1.2, 0, 0] }),
  midId2,
);
await page.waitForTimeout(600);
await setupCamera();
const afterMidX = await save('04-after-move-mid-perp.png');

const report = {
  before,
  afterSouth,
  afterMid,
  afterMidX,
  southId,
  midId,
  midAfterSouth,
  southHandles,
  midHandles,
};
writeFileSync(`${MEDIA}/verify.json`, JSON.stringify(report, null, 2));
writeFileSync(`${OUT}/verify.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await browser.close();
