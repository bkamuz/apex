import { chromium, devices } from 'playwright';
const env = process.env;
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const mobile = env.MOBILE === '1';
const ctx = await b.newContext(mobile ? { ...devices['iPhone 13'], viewport: { width: 390, height: 844 } } : { viewport: { width: 1500, height: 960 } });
await ctx.addInitScript(([theme, lang]) => {
  localStorage.setItem('apex.theme', theme);
  if (lang) localStorage.setItem('apex.locale', lang);
}, [env.THEME ?? 'light', env.LANG_UI ?? 'ru']);
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
await page.goto('http://localhost:5173/' + (env.Q ?? ''), { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__apexTest, null, { timeout: 60000 });
await page.waitForTimeout(800);
if (mobile) {
  await page.locator('.mobile-menu-fab').first().click();
  await page.waitForTimeout(300);
  for (const tab of await page.locator('.mobile-menu-tabs button').all()) {
    if (await page.getByTestId('browser-tab-genera').isVisible().catch(() => false)) break;
    await tab.click();
    await page.waitForTimeout(200);
  }
}
await page.getByTestId('browser-tab-genera').click();
await page.locator(`[data-kind="component_def"][data-id="${env.GENUS ?? 'apex.window'}"]`).dblclick();
await page.waitForSelector('[data-testid="genus-editor"]');
await page.waitForTimeout(1500);
const log = (...a) => console.log(...a);
/** Screen point of genus view coords (u, v) in a view. */
page.__at = async (view, u, v) =>
  page.evaluate(([view, u, v]) => {
    const svg = document.querySelector(`[data-testid="genus-view-${view}"] svg`);
    const m = svg.getScreenCTM();
    const p = new DOMPoint(u, -v).matrixTransform(m);
    return { x: p.x, y: p.y };
  }, [view, u, v]);
if (env.STEPS) {
  const steps = await import(env.STEPS);
  await steps.default(page, log);
}
await page.waitForTimeout(Number(env.WAIT ?? 1200));
await page.screenshot({ path: env.OUT ?? '/tmp/p4/shot.png' });
log('status:', await page.getByTestId(mobile ? 'genus-editor' : 'genus-status').innerText().then((s) => s.replace(/\s+/g, ' ').slice(-200)));
log('errors', errs);
await b.close();
