#!/usr/bin/env node
/**
 * The two-storey house from apps/web/scripts/house-e2e.mjs, built by an MCP
 * client talking to `apex-mcp` over stdio — no browser, no clicks. Every step
 * is a tool call an agent could make. At the end the model must validate with
 * zero errors and every solid must be watertight.
 *
 *   npm run house                     # build + run
 *   APEX_HOUSE_OUT=/tmp/house node scripts/house-mcp.mjs
 *
 * Writes project.json, house.ifc, plan/sheet SVG and DXF to APEX_HOUSE_OUT.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.APEX_HOUSE_OUT ?? '/tmp/apex-house-mcp';
mkdirSync(OUT, { recursive: true });

const client = new Client({ name: 'apex-house', version: '1.0.0' });
await client.connect(
  new StdioClientTransport({ command: process.execPath, args: [resolve(here, '../dist/cli.js'), '--backend', 'headless'], stderr: 'inherit' }),
);

let calls = 0;
async function tool(name, args = {}) {
  calls += 1;
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? '';
  if (r.isError) throw new Error(`${name}(${JSON.stringify(args)}): ${text}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
const P = (x, z, y = 0) => [x, y, z];

const { tools } = await client.listTools();
console.log(`[tools] ${tools.length} tools`);

// ------------------------------------------------------------ grid + levels
const AX = [0, 5, 10];
const AZ = [0, 4, 8];
await tool('batch', {
  commands: [
    ...AX.map((x, i) => ({ op: 'create_grid_axis', points: [P(x, -2), P(x, 10)], params: { label: String(i + 1) } })),
    ...AZ.map((z, i) => ({ op: 'create_grid_axis', points: [P(-2, z), P(12, z)], params: { label: 'ABC'[i] } })),
  ],
});
const levels0 = await tool('list_levels');
const L0 = levels0[0].id;
const { id: L1 } = await tool('create_level', { name: 'Level 1', elevation: 3 });

// ------------------------------------------------------------ one storey
async function storey(level, elev, { entrance }) {
  await tool('set_active_level', { id: level });
  // Exterior loop as four chained walls, like the wall tool's click chain.
  const loop = [P(0, 0), P(10, 0), P(10, 8), P(0, 8), P(0, 0)];
  const ext = [];
  for (let i = 0; i < 4; i++) ext.push(await tool('place_wall', { level, points: [loop[i], loop[i + 1]] }));
  const mid = await tool('place_wall', { level, points: [P(5, 0), P(5, 8)] });
  const part = await tool('place_wall', { level, points: [P(5, 4), P(10, 4)] });
  const walls = await tool('list_elements', { level, component: 'apex.wall' });
  // Pick the host wall whose centreline contains the opening point.
  const geo = new Map();
  for (const w of walls) geo.set(w.id, await tool('get_element', { id: w.id }));
  const hostAt = (x, z) => {
    for (const w of walls) {
      const pts = geo.get(w.id).anchors ?? [];
      for (let i = 0; i + 1 < pts.length; i++) {
        const [ax, , az] = pts[i];
        const [bx, , bz] = pts[i + 1];
        const cross = (bx - ax) * (z - az) - (bz - az) * (x - ax);
        const within = Math.min(ax, bx) - 1e-3 <= x && x <= Math.max(ax, bx) + 1e-3 && Math.min(az, bz) - 1e-3 <= z && z <= Math.max(az, bz) + 1e-3;
        if (Math.abs(cross) < 1e-3 && within) return w.id;
      }
    }
    throw new Error(`no wall at (${x}, ${z}) on level ${level}`);
  };
  const doors = [[5, 2], [5, 6], ...(entrance ? [[2, 0]] : [])];
  const windows = [[7.5, 0], [10, 2], [10, 6], [7.5, 8], [2.5, 8], [0, 4], ...(entrance ? [] : [[2, 0]])];
  await tool('batch', {
    commands: [
      ...doors.map(([x, z]) => ({ op: 'create_element', component: 'apex.door', parent: hostAt(x, z), level, points: [P(x, z, elev)] })),
      ...windows.map(([x, z]) => ({ op: 'create_element', component: 'apex.window', parent: hostAt(x, z), level, points: [P(x, z, elev)] })),
    ],
  });
  if (entrance) {
    // 45° wall east of the house with a door and a window: openings follow non-axis walls.
    const { id: diag } = await tool('place_wall', { level, points: [P(10.8, 0.8), P(12.8, 2.8)] });
    await tool('place_door', { level, parent: diag, points: [P(11.3, 1.3, elev)] });
    await tool('place_window', { level, parent: diag, points: [P(12.2, 2.2, elev)] });
  }
  const slab = await tool('place_slab', { level, points: [P(0, 0), P(10, 0), P(10, 8), P(0, 8)] });
  return { ext, mid, part, slab };
}

const s0 = await storey(L0, 0, { entrance: true });
// Ramp: a slab whose far edge is lifted 0.6 m (sub-element shape edit).
const ramp = await tool('place_slab', { level: L0, points: [P(11, 4), P(14, 4), P(14, 7), P(11, 7)] });
await tool('set_slab_shape', { id: ramp.id, shape: { z: [0, 0.6, 0.6, 0] } }).catch((e) => console.log('  ramp shape:', e.message));
const s1 = await storey(L1, 3, { entrance: false });

// Stair from L0 up; it cuts the L1 slab.
await tool('place_stair', { level: L0, points: [P(1, 1.5), P(1, 6)] });

// Pitched roof on L1, ridge along axis B, 0.5 m overhang, eaves cut square to the slope.
const roof = await tool('place_roof_pitched', { level: L1, points: [P(0, 4, 3), P(10, 4, 3)], params: { overhang: 0.5, eave_cut: 'perpendicular' } });
// Gables: the L1 end walls (x = 0 and x = 10) attach their tops to the roof.
for (const w of [s1.ext[1], s1.ext[3]]) await tool('update_element', { id: w.id, params: { attach_top: true } });

// Rooms.
const NAMES = {
  [L0]: [['LIVING', 2.5, 4], ['BEDROOM', 7.5, 2], ['KITCHEN', 7.5, 6]],
  [L1]: [['HALL / STAIR', 2.5, 4], ['BEDROOM 2', 7.5, 2], ['BEDROOM 3', 7.5, 6]],
};
for (const level of [L0, L1]) {
  await tool('set_active_level', { id: level });
  await tool('detect_rooms');
}
const spaces = await tool('list_spaces');
const inside = (pt, poly) => {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, , zi] = poly[i];
    const [xj, , zj] = poly[j];
    if (zi > pt[1] !== zj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
};
for (const level of [L0, L1]) {
  for (const [name, x, z] of NAMES[level]) {
    const sp = spaces.find((s) => s.level === level && inside([x, z], s.outline ?? []));
    if (sp) await tool('update_space', { id: sp.id, name });
    else console.log(`  !! no room at (${x}, ${z}) for ${name}`);
  }
}

// ------------------------------------------------------------ views, dims, sheet
const views = {};
for (const [level, key] of [[L0, 'L0'], [L1, 'L1']]) {
  const { id } = await tool('create_plan_view', { level });
  views[key] = id;
  const W = (x, z) => ({ kind: 'world', point: P(x, z) });
  const dim = (a, b, offset = -0.8) => ({ op: 'create_view_annotation', view: id, annotation: { kind: 'linear_dimension', a: W(...a), b: W(...b), offset } });
  await tool('batch', {
    commands: [
      dim([0, 0], [5, 0], -1), dim([5, 0], [10, 0], -1), dim([0, 0], [10, 0], -1.8),
      dim([0, 0], [0, 4], 1), dim([0, 4], [0, 8], 1), dim([0, 0], [0, 8], 1.8),
      { op: 'create_view_annotation', view: id, annotation: { kind: 'text_note', position: W(0, -3), text: key === 'L0' ? 'GROUND FLOOR' : 'FIRST FLOOR' } },
    ],
  });
}
const { id: v3d } = await tool('create_3d_view');
const { id: sheet } = await tool('create_sheet', { name: 'House', number: 'A-101' });
await tool('batch', {
  commands: [
    { op: 'place_view_on_sheet', sheet, view: views.L0, center_x_mm: 200, center_y_mm: 300 },
    { op: 'place_view_on_sheet', sheet, view: views.L1, center_x_mm: 600, center_y_mm: 300 },
    { op: 'place_view_on_sheet', sheet, view: v3d, center_x_mm: 400, center_y_mm: 150 },
  ],
});

// ------------------------------------------------------------ validate + export
const summary = await tool('summary');
console.log('[summary]', JSON.stringify(summary));
const report = await tool('validate');
const elements = await tool('list_elements');
let leaky = 0;
for (const el of elements) {
  const g = await tool('element_geometry', { id: el.id }).catch(() => null);
  if (g && g.watertight === false && g.triangles > 0) {
    leaky += 1;
    console.log(`  !! not watertight: ${el.component} ${el.id}`);
  }
}
for (const [key, id] of Object.entries(views)) {
  for (const format of ['svg', 'dxf']) {
    const r = await tool('export_view', { id, format });
    writeFileSync(`${OUT}/plan-${key}.${format}`, r.content ?? JSON.stringify(r));
  }
}
for (const format of ['svg', 'dxf']) {
  const r = await tool('export_sheet', { id: sheet, format });
  writeFileSync(`${OUT}/sheet-A101.${format}`, r.content ?? JSON.stringify(r));
}
await tool('export_ifc', { path: `${OUT}/house.ifc` });
await tool('save_project', { path: `${OUT}/project.json` });

// Undo/redo round trip on the live model: one call = one step.
const before = (await tool('summary')).elements;
await tool('undo');
await tool('redo');
const after = (await tool('summary')).elements;

await client.close();

const problems = [];
if (!report.ok) problems.push(`validate: ${report.errors} error(s): ${JSON.stringify(report.issues)}`);
if (leaky) problems.push(`${leaky} solid(s) not watertight`);
if (before !== after) problems.push(`undo/redo changed the element count ${before} → ${after}`);
if ((summary.spaces ?? 0) < 6) problems.push(`expected 6 rooms, got ${summary.spaces}`);
console.log(`[house] ${calls} tool calls, ${elements.length} elements, ${report.warnings} warning(s); output in ${OUT}`);
if (problems.length) {
  console.log('[house] FAIL\n  - ' + problems.join('\n  - '));
  process.exit(1);
}
console.log('[house] OK: validates with no errors, every solid watertight');
