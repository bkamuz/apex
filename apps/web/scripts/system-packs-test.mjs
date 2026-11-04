/**
 * Light UI regression: Settings system-pack toggles rebuild the toolbar.
 * Disable Engineering → Pipe/Duct/Cable tray gone; Architecture/Building tools stay.
 *
 * Usage (dev server running):
 *   APEX_SMOKE_URL=http://127.0.0.1:5173/ node scripts/system-packs-test.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const URL = process.env.APEX_SMOKE_URL ?? 'http://127.0.0.1:5173/';
const OUT = process.env.APEX_PACKS_OUT ?? '/opt/cursor/artifacts/screenshots';
const STORE_MEDIA =
  process.env.APEX_PACKS_MEDIA ??
  '/cursor/stores/bc-01a16d7d-837c-77fb-8314-11d75ba13086/media/ap-39';

mkdirSync(OUT, { recursive: true });
mkdirSync(STORE_MEDIA, { recursive: true });

let failed = 0;
function check(name, ok) {
  if (ok) console.log(`  ok  ${name}`);
  else {
    console.error(`  FAIL ${name}`);
    failed += 1;
  }
}

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader-webgl'],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="settings-menu"]');

// Clear any leftover pack prefs from prior runs.
await page.evaluate(() => localStorage.removeItem('apex.packs.enabled'));
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="settings-menu"]');

const toolbarNames = () =>
  page.locator('.tools button, .context-bar button').evaluateAll((els) =>
    els.map((e) => e.textContent.trim()),
  );

async function openSettings(tab = 'extensions') {
  if ((await page.getByTestId('settings-dialog').count()) === 0) {
    await page.getByTestId('settings-menu-summary').click();
    await page.waitForSelector('[data-testid="settings-dialog"]');
  }
  if (tab === 'general') {
    await page.getByTestId('settings-tab-general').click();
    await page.waitForSelector('[data-testid="settings-pane-general"]');
  } else {
    await page.getByTestId('settings-tab-extensions').click();
    await page.waitForSelector('[data-testid="settings-packs"]');
  }
}

async function closeSettings() {
  const dialog = page.getByTestId('settings-dialog');
  if ((await dialog.count()) === 0) return;
  await page.getByTestId('settings-dialog-close').click();
  await page.waitForSelector('[data-testid="settings-dialog"]', { state: 'detached' });
}

console.log('\n[system packs] defaults → Engineering tools present');
await page.getByTestId('tools-tab-apex.engineering').click();
await page.waitForTimeout(80);
let tools = await toolbarNames();
for (const name of ['Pipe', 'Duct', 'Cable tray']) {
  check(`default: "${name}" on Engineering`, tools.includes(name));
}
await page.getByTestId('tools-tab-apex.architecture').click();
await page.waitForTimeout(80);
tools = await toolbarNames();
check('default: Wall on Architecture', tools.includes('Wall'));

await openSettings('general');
await page.screenshot({
  path: join(OUT, 'ap-43-settings-sidebar-general.png'),
  fullPage: false,
});
await page.screenshot({
  path: join(STORE_MEDIA, 'settings-sidebar-general.png'),
  fullPage: false,
});

await openSettings('extensions');
await page.screenshot({
  path: join(OUT, 'ap-39-settings-packs-all-on.png'),
  fullPage: false,
});
await page.screenshot({
  path: join(OUT, 'ap-43-settings-sidebar-extensions.png'),
  fullPage: false,
});
await page.screenshot({
  path: join(STORE_MEDIA, 'settings-packs-all-on.png'),
  fullPage: false,
});
await page.screenshot({
  path: join(STORE_MEDIA, 'settings-sidebar-extensions.png'),
  fullPage: false,
});
// Crop-friendly shot with pack descriptions visible.
await page.locator('[data-testid="settings-pack-row-apex.pack.building"]').scrollIntoViewIfNeeded();
await page.screenshot({
  path: join(OUT, 'ap-43-settings-pack-descriptions.png'),
  fullPage: false,
});
await page.screenshot({
  path: join(STORE_MEDIA, 'settings-pack-descriptions.png'),
  fullPage: false,
});

console.log('\n[system packs] disable Engineering');
await page.getByTestId('settings-pack-apex.pack.engineering').uncheck();
await page.waitForTimeout(200);

check(
  'Engineering tab hidden when pack off',
  (await page.getByTestId('tools-tab-apex.engineering').count()) === 0,
);

await page.screenshot({
  path: join(OUT, 'ap-39-settings-packs-engineering-off.png'),
  fullPage: false,
});
await page.screenshot({
  path: join(STORE_MEDIA, 'settings-packs-engineering-off.png'),
  fullPage: false,
});

await closeSettings();
await page.getByTestId('tools-tab-apex.architecture').click();
await page.waitForTimeout(80);
tools = await toolbarNames();
check('Wall still present after Engineering off', tools.includes('Wall'));
check('Column still present', tools.includes('Column'));
for (const name of ['Pipe', 'Duct', 'Cable tray']) {
  check(`"${name}" absent after Engineering off`, !tools.includes(name));
}

await page.screenshot({
  path: join(OUT, 'ap-39-toolbar-engineering-off.png'),
  fullPage: false,
});
await page.screenshot({
  path: join(STORE_MEDIA, 'toolbar-engineering-off.png'),
  fullPage: false,
});

console.log('\n[system packs] re-enable Engineering');
await openSettings('extensions');
await page.getByTestId('settings-pack-apex.pack.engineering').check();
await page.waitForTimeout(200);
await closeSettings();
check(
  'Engineering tab returns',
  (await page.getByTestId('tools-tab-apex.engineering').count()) === 1,
);
await page.getByTestId('tools-tab-apex.engineering').click();
await page.waitForTimeout(80);
tools = await toolbarNames();
check('Pipe returns', tools.includes('Pipe'));

await page.screenshot({
  path: join(OUT, 'ap-39-toolbar-engineering-on.png'),
  fullPage: false,
});
await page.screenshot({
  path: join(STORE_MEDIA, 'toolbar-engineering-on.png'),
  fullPage: false,
});

await browser.close();
if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nSystem packs UI regression passed.');
console.log(`Screenshots: ${OUT} and ${STORE_MEDIA}`);
