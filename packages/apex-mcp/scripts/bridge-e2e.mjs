/**
 * Live bridge end to end: an MCP client drives the open web app through
 * `apex-mcp --backend live --bridge`. Needs the app served (vite dev/preview),
 * packages/apex-mcp built and apps/web dependencies installed (Playwright).
 *
 *   APEX_SMOKE_URL=http://localhost:4173/ node scripts/bridge-e2e.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = dirname(fileURLToPath(import.meta.url));
// Playwright lives with the web app's dev dependencies.
const { chromium } = await import(resolve(here, '../../../apps/web/node_modules/playwright/index.mjs'));
const BASE = process.env.APEX_SMOKE_URL ?? 'http://localhost:5173/';
const OUT = process.env.APEX_SHOTS ?? '/tmp/apex-mcp-shots';
const PORT = Number(process.env.APEX_BRIDGE_PORT ?? 7399);
const TOKEN = randomBytes(12).toString('hex');
mkdirSync(OUT, { recursive: true });

const client = new Client({ name: 'apex-bridge-e2e', version: '1.0.0' });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [resolve(here, '../dist/cli.js'), '--backend', 'live', '--bridge', String(PORT), '--token', TOKEN],
    stderr: 'inherit',
  }),
);
async function tool(name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name}: ${r.content?.[0]?.text}`);
  return r;
}
const json = async (name, args) => JSON.parse((await tool(name, args)).content[0].text);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 860 } });
let failed = false;
try {
  // Wrong token first: the app must not get in.
  await page.goto(`${BASE}?mcp=ws://127.0.0.1:${PORT}&mcpToken=wrong`);
  await page.waitForTimeout(800);
  if ((await json('bridge_status')).connected) throw new Error('connected with a wrong token');

  await page.goto(`${BASE}?mcp=ws://127.0.0.1:${PORT}&mcpToken=${TOKEN}`);
  for (let i = 0; i < 50 && !(await json('bridge_status')).connected; i++) await page.waitForTimeout(100);
  if (!(await json('bridge_status')).connected) throw new Error('app did not connect');

  await tool('new_project');
  const P = (x, z) => [x, 0, z];
  const loop = [P(0, 0), P(8, 0), P(8, 6), P(0, 6), P(0, 0)];
  const walls = [];
  for (let i = 0; i < 4; i++) walls.push(await json('place_wall', { points: [loop[i], loop[i + 1]] }));
  await json('place_wall', { points: [P(4, 0), P(4, 6)] });
  await json('place_door', { parent: walls[0].id, points: [P(2, 0)] });
  await json('place_window', { parent: walls[2].id, points: [P(6, 6)] });
  await json('place_slab', { points: [P(0, 0), P(8, 0), P(8, 6), P(0, 6)] });
  await json('place_roof_pitched', { points: [[0, 3, 3], [8, 3, 3]], params: { overhang: 0.4 } });
  const v = await json('validate');
  if (!v.ok) throw new Error(`validate: ${JSON.stringify(v.issues)}`);
  const elements = await page.evaluate(() => document.body.innerText.includes('Wall'));
  console.log(`[bridge] model built in the browser; validate ok; UI shows walls: ${elements}`);

  const shot = await tool('screenshot', { width: 1200, height: 800 });
  const img = shot.content.find((c) => c.type === 'image');
  if (!img) throw new Error('screenshot returned no image');
  writeFileSync(resolve(OUT, 'mcp-screenshot-tool.png'), Buffer.from(img.data, 'base64'));
  await page.getByTestId('agent-bridge-toggle').click();
  await page.screenshot({ path: resolve(OUT, 'mcp-live-app.png') });
  console.log(`[bridge] OK; screenshots in ${OUT}`);
} catch (e) {
  failed = true;
  console.error('[bridge] FAIL', e.message);
  await page.screenshot({ path: resolve(OUT, 'mcp-failure.png') }).catch(() => {});
} finally {
  await browser.close();
  await client.close();
}
process.exit(failed ? 1 : 0);
