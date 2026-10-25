import { chromium } from 'playwright';

const BASE = process.env.APEX_SMOKE_URL ?? 'http://localhost:5173/';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('.level-list li');
await page.waitForTimeout(400);

const levels = page.locator('.level-list li');
const count = await levels.count();
if (count < 2) {
  await page.getByRole('button', { name: '+ Level', exact: true }).click();
  await page.waitForTimeout(300);
}

const items = page.locator('.level-list li');
const n = await items.count();
if (n < 2) throw new Error('need at least 2 levels');

await items.nth(1).click();
await page.waitForTimeout(200);
const activeAfter = await items.nth(1).evaluate((el) => el.classList.contains('active-level'));
const hint = await page.locator('[data-testid="topbar-hint"]').innerText();

await browser.close();
if (!activeAfter) {
  console.error('FAIL level not marked active');
  process.exit(1);
}
if (!hint.includes('Active level')) {
  console.error('FAIL missing active level hint', hint);
  process.exit(1);
}
console.log('level-activation test passed');
