// End to end over stdio: an MCP client lists the generated tools and builds a
// small model with them, exactly as Cursor or Claude Desktop would.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const cli = resolve(dirname(fileURLToPath(import.meta.url)), '../dist/cli.js');
const client = new Client({ name: 'apex-mcp-test', version: '0.0.0' });

async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? '';
  if (r.isError) throw new Error(`${name}: ${text}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

before(async () => {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, '--backend', 'headless'], stderr: 'ignore' }));
});
after(async () => {
  await client.close();
});

test('tools are generated from descriptors', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const n of ['place_wall', 'place_door', 'place_window', 'place_slab', 'batch', 'undo', 'redo', 'validate', 'export_view', 'export_ifc', 'describe_api', 'screenshot']) {
    assert.ok(names.includes(n), `missing tool ${n}`);
  }
  assert.equal(new Set(names).size, names.length, 'tool names are unique');
  for (const t of tools) {
    assert.ok(t.description && t.description.length > 10, `${t.name} has a description`);
    assert.equal(t.inputSchema.type, 'object', `${t.name} has an object schema`);
  }
  const wall = tools.find((t) => t.name === 'place_wall');
  assert.ok(wall.inputSchema.properties.points, 'place_wall takes points');
});

test('build, validate, undo and export a small model', async () => {
  await call('new_project');
  const P = (x, z) => [x, 0, z];
  const loop = [P(0, 0), P(6, 0), P(6, 4), P(0, 4), P(0, 0)];
  const walls = [];
  for (let i = 0; i < 4; i++) walls.push(await call('place_wall', { points: [loop[i], loop[i + 1]] }));
  await call('place_door', { parent: walls[0].id, points: [P(3, 0)] });
  await call('place_window', { parent: walls[2].id, points: [P(3, 4)] });
  await call('place_slab', { points: [P(0, 0), P(6, 0), P(6, 4), P(0, 4)] });

  const summary = await call('summary');
  assert.equal(summary.elements_by_component['apex.wall'], 4);
  assert.equal(summary.elements_by_component['apex.door'], 1);

  const v = await call('validate');
  assert.equal(v.ok, true, JSON.stringify(v.issues));
  for (const w of walls) assert.equal((await call('element_geometry', { id: w.id })).watertight, true);

  // A batch is one undo step.
  const before = (await call('summary')).element_count;
  await call('batch', { commands: [{ op: 'create_element', component: 'apex.column', points: [P(1, 1)] }, { op: 'create_element', component: 'apex.column', points: [P(5, 1)] }] });
  assert.equal((await call('summary')).element_count, before + 2);
  await call('undo');
  assert.equal((await call('summary')).element_count, before);

  await call('detect_rooms');
  assert.equal((await call('list_spaces')).length, 1);

  const ifc = await call('export_ifc');
  assert.match(typeof ifc === 'string' ? ifc : ifc.content, /IFCWALL/);
});

test('batch refs, place_* aliases and export paths', async () => {
  await call('new_project');
  const P = (x, z) => [x, 0, z];
  const out = await call('batch', {
    commands: [
      { op: 'place_wall', points: [P(0, 0), P(6, 0)] },
      { op: 'place_door', parent: '$0.id', points: [P(3, 0)] },
    ],
  });
  const door = await call('get_element', { id: out.results[1].id });
  assert.equal(door.parent, out.results[0].id);
  await assert.rejects(call('place_window', { points: [P(1, 0)] }), /hosted/);

  const level = (await call('summary')).levels[0].id;
  const view = await call('create_plan_view', { level });
  const file = join(tmpdir(), `apex-mcp-${process.pid}.svg`);
  const res = await call('export_view', { id: view.id, format: 'svg', path: file });
  assert.equal(res.path, file);
  assert.match(readFileSync(file, 'utf8'), /^<svg/);
  rmSync(file);
});

test('a bad call is a tool error, not a crash', async () => {
  const r = await client.callTool({ name: 'place_wall', arguments: { points: [] } });
  assert.equal(r.isError, true);
  const r2 = await client.callTool({ name: 'summary', arguments: {} });
  assert.notEqual(r2.isError, true, 'server keeps working');
});

test('resources and prompts', async () => {
  const { resources } = await client.listResources();
  const uris = resources.map((r) => r.uri);
  assert.ok(uris.includes('apex://conventions'));
  assert.ok(uris.includes('apex://project/summary'));
  const conv = await client.readResource({ uri: 'apex://conventions' });
  assert.match(conv.contents[0].text, /metre|meter|\bm\b/i);
  const wall = await client.readResource({ uri: 'apex://element-types/apex.wall' });
  assert.match(wall.contents[0].text, /purpose/);
  const { prompts } = await client.listPrompts();
  assert.ok(prompts.some((p) => p.name === 'build-model'));
  const p = await client.getPrompt({ name: 'build-model', arguments: { brief: 'a garden shed' } });
  assert.match(p.messages[0].content.text, /garden shed/);
});

test('headless screenshots: 3d render, plan view and wall thickness', async () => {
  await call('new_project');
  const P = (x, z) => [x, 0, z];
  const w = await call('place_wall', { points: [P(0, 0), P(5, 0), P(5, 4)], params: { thickness: 0.3 } });
  const g = await call('element_geometry', { id: w.id });
  assert.ok(Math.abs(g.bbox.size[2] - 4.15) < 0.02, JSON.stringify(g.bbox));
  const type = await call('create_wall_type', { name: 'Ext 400', thickness: 0.4 });
  assert.match(type.profile, /^user\.wall\./);
  const bad = await client.callTool({ name: 'delete_element', arguments: { id: 'w2' } });
  assert.ok(bad.isError && /not found/.test(bad.content[0].text), bad.content[0].text);
  const shot = await client.callTool({ name: 'screenshot', arguments: { mode: '3d', width: 320 } });
  assert.ok(!shot.isError, shot.content?.[0]?.text);
  assert.equal(shot.content[0].type, 'image');
  const png = Buffer.from(shot.content[0].data, 'base64');
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  const lvl = (await call('list_levels'))[0];
  const view = await call('create_plan_view', { level: lvl.id });
  const plan = await client.callTool({ name: 'screenshot', arguments: { view: view.id, width: 320 } });
  assert.ok(!plan.isError, plan.content?.[0]?.text);
  assert.equal(Buffer.from(plan.content[0].data, 'base64').subarray(1, 4).toString(), 'PNG');
});

test('genus tools: define, place, edit, provenance', async () => {
  await call('new_project');
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const n of ['define_genus', 'set_genus_item', 'remove_genus_item', 'get_genus', 'param_provenance']) {
    assert.ok(names.includes(n), `${n} tool exists`);
  }
  await call('define_genus', {
    id: 'user.block',
    name: 'Block',
    params: [{ id: 'size', default: 1 }],
    body: [
      { id: 'b', item: 'solid', shape: 'box', min: [0, 0, 0], max: ['size', 'size', 'size'] },
      { id: 'n', item: 'cut', shape: 'box', min: [0.5, 0.5, -1], max: [2, 2, 2], targets: { self: true } },
    ],
  });
  await call('define_genus', { id: 'user.big', name: 'Big', extends: 'user.block', params: [{ id: 'size', default: 2 }] });
  const el = await call('create_element', { component: 'user.big', points: [[0, 0, 0]] });
  const g = await call('element_geometry', { id: el.id });
  assert.ok(Math.abs(g.volume - (8 - 1.5 * 1.5 * 2)) < 1e-3, `self cut volume ${g.volume}`);
  await call('remove_genus_item', { genus: 'user.big', id: 'n' });
  const g2 = await call('element_geometry', { id: el.id });
  assert.ok(Math.abs(g2.volume - 8) < 1e-3, `inherited cut removed ${g2.volume}`);
  const prov = await call('param_provenance', { id: el.id });
  assert.equal(prov.find((p) => p.id === 'size').source, 'genus');
  const info = await call('get_genus', { id: 'user.big' });
  assert.deepEqual(info.authored.remove, ['n']);
});
