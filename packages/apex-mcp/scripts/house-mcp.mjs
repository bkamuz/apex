#!/usr/bin/env node
/**
 * The modern house from apps/web/src/ui/houseSample.ts, built by an MCP
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

const GROUND = 0;
const UPPER = 3.05;
const ROOF_Y = 6;
const EXT = 0.3;
const INT = 0.12;

const G_EXT = [[[0, 0], [4, 0]], [[4, 0], [14, 0]], [[14, 0], [14, 7]], [[14, 7], [10, 7]], [[10, 7], [10, 11]], [[10, 11], [7, 11]], [[7, 11], [4, 11]], [[4, 11], [0, 11]], [[0, 11], [0, 8]], [[0, 8], [0, 3]], [[0, 3], [0, 0]]];
const G_INT = [[[4, 0], [4, 3]], [[4, 3], [4, 7]], [[4, 7], [4, 8]], [[4, 8], [4, 11]], [[0, 3], [4, 3]], [[0, 8], [4, 8]], [[4, 7], [7, 7]], [[7, 7], [10, 7]], [[7, 7], [7, 11]]];
const U_EXT = [[[0, -2], [4, -2]], [[4, -2], [7, -2]], [[7, -2], [10, -2]], [[10, -2], [10, 8]], [[10, 8], [10, 11]], [[10, 11], [7, 11]], [[7, 11], [4, 11]], [[4, 11], [0, 11]], [[0, 11], [0, 3]], [[0, 3], [0, -2]]];
const U_INT = [[[4, -2], [4, 3]], [[4, 3], [4, 8]], [[4, 8], [4, 11]], [[7, -2], [7, 3]], [[7, 3], [7, 8]], [[7, 8], [7, 11]], [[0, 3], [4, 3]], [[4, 3], [7, 3]], [[4, 8], [7, 8]], [[7, 8], [10, 8]]];

const AX = [0, 4, 7, 10, 14];
const AZ = [-2, 0, 3, 7, 8, 11];
await tool('batch', {
  commands: [
    ...AX.map((x, i) => ({ op: 'create_grid_axis', points: [P(x, -6), P(x, 14)], params: { label: String(i + 1) } })),
    ...AZ.map((z, i) => ({ op: 'create_grid_axis', points: [P(-4, z), P(18, z)], params: { label: 'ABCDEF'[i] } })),
  ],
});
const levels0 = await tool('list_levels');
const L0 = levels0[0].id;
const { id: L1 } = await tool('create_level', { name: 'sample.level.upper', elevation: UPPER });
const { id: LRoof } = await tool('create_level', { name: 'sample.level.roof', elevation: ROOF_Y });

function glazing(width, height, sill, columns = 1) {
  return { width, height, sill, columns, sash_width: columns > 1 ? 0.04 : 0, mullion_width: 0.05, frame_width: 0.05 };
}
function doorParams(width, height = 2.1, columns = 1) {
  return { width, height, sill: 0, columns, mullion_width: 0.02, frame_width: 0.06 };
}

async function placeWalls(level, elev, segs, thickness) {
  for (const [a, b] of segs) {
    await tool('place_wall', { level, points: [P(a[0], a[1], elev), P(b[0], b[1], elev)], params: { thickness } });
  }
}

async function hostAt(level, x, z, component) {
  const walls = await tool('list_elements', { level, component });
  for (const w of walls) {
    const pts = (await tool('get_element', { id: w.id })).anchors ?? [];
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, , az] = pts[i];
      const [bx, , bz] = pts[i + 1];
      const cross = (bx - ax) * (z - az) - (bz - az) * (x - ax);
      const within = Math.min(ax, bx) - 1e-3 <= x && x <= Math.max(ax, bx) + 1e-3 && Math.min(az, bz) - 1e-3 <= z && z <= Math.max(az, bz) + 1e-3;
      if (Math.abs(cross) < 1e-3 && within) return w.id;
    }
  }
  throw new Error(`no ${component} at (${x}, ${z}) on level ${level}`);
}

async function placeOpenings(level, elev, items) {
  for (const item of items) {
    const [x, z] = item.at;
    const parent = await hostAt(level, x, z, 'apex.wall');
    const name = item.kind === 'apex.door' ? 'place_door' : 'place_window';
    await tool(name, { level, parent, points: [P(x, z, elev)], params: item.params });
  }
}

const GROUND_OPENINGS = [
  { kind: 'apex.door', at: [2, 0], params: doorParams(1.2, 2.4) },
  { kind: 'apex.window', at: [3.3, 0], params: glazing(0.7, 2.4, 0) },
  { kind: 'apex.window', at: [6.3, 0], params: glazing(2.6, 2.6, 0, 2) },
  { kind: 'apex.window', at: [9.2, 0], params: glazing(2.4, 2.6, 0, 2) },
  { kind: 'apex.door', at: [11.6, 0], params: doorParams(1.6, 2.4, 2) },
  { kind: 'apex.window', at: [13.2, 0], params: glazing(1.2, 2.6, 0) },
  { kind: 'apex.window', at: [14, 2.2], params: glazing(2.6, 2.6, 0, 2) },
  { kind: 'apex.window', at: [14, 5.2], params: glazing(2.4, 2.6, 0, 2) },
  { kind: 'apex.window', at: [12, 7], params: glazing(2.2, 2.2, 0.15, 2) },
  { kind: 'apex.window', at: [8.5, 11], params: glazing(1.8, 1.5, 0.9) },
  { kind: 'apex.window', at: [5.5, 11], params: glazing(1.2, 1.0, 1.45) },
  { kind: 'apex.window', at: [2, 11], params: glazing(1.6, 1.2, 1.3) },
  { kind: 'apex.window', at: [0, 9.5], params: glazing(1.2, 1.1, 1.3) },
  { kind: 'apex.window', at: [0, 5.5], params: glazing(0.6, 1.8, 1.0) },
  { kind: 'apex.window', at: [0, 1.5], params: glazing(1.4, 1.5, 0.9) },
  { kind: 'apex.door', at: [4, 1.6], params: doorParams(0.95) },
  { kind: 'apex.door', at: [2, 3], params: doorParams(0.9) },
  { kind: 'apex.door', at: [2, 8], params: doorParams(0.85) },
  { kind: 'apex.door', at: [5.5, 7], params: doorParams(0.8) },
  { kind: 'apex.door', at: [8.5, 7], params: doorParams(0.9) },
];
const UPPER_OPENINGS = [
  { kind: 'apex.window', at: [2, -2], params: glazing(2.6, 2.4, 0, 2) },
  { kind: 'apex.window', at: [5.5, -2], params: glazing(2.0, 2.4, 0, 2) },
  { kind: 'apex.window', at: [8.5, -2], params: glazing(2.0, 2.4, 0, 2) },
  { kind: 'apex.window', at: [10, 1], params: glazing(2.4, 2.4, 0, 2) },
  { kind: 'apex.window', at: [10, 5], params: glazing(2.2, 2.4, 0, 2) },
  { kind: 'apex.window', at: [10, 9.5], params: glazing(1.4, 1.3, 1.05) },
  { kind: 'apex.window', at: [0, 0.5], params: glazing(1.8, 2.2, 0.15) },
  { kind: 'apex.window', at: [0, 6], params: glazing(0.6, 1.8, 0.85) },
  { kind: 'apex.window', at: [2, 11], params: glazing(1.6, 1.2, 1.2) },
  { kind: 'apex.window', at: [5.5, 11], params: glazing(1.2, 1.0, 1.4) },
  { kind: 'apex.window', at: [8.5, 11], params: glazing(1.4, 1.2, 1.2) },
  { kind: 'apex.door', at: [2, 3], params: doorParams(0.9) },
  { kind: 'apex.door', at: [5.5, 3], params: doorParams(0.9) },
  { kind: 'apex.door', at: [4, 5.5], params: doorParams(0.9) },
  { kind: 'apex.door', at: [7, 5.5], params: doorParams(0.9) },
  { kind: 'apex.door', at: [5.5, 8], params: doorParams(0.8) },
  { kind: 'apex.door', at: [8.5, 8], params: doorParams(0.8) },
];

await tool('set_active_level', { id: L0 });
await placeWalls(L0, GROUND, G_EXT, EXT);
await placeWalls(L0, GROUND, G_INT, INT);
await placeOpenings(L0, GROUND, GROUND_OPENINGS);
await tool('place_slab', { level: L0, points: [P(0, 0), P(14, 0), P(14, 7), P(10, 7), P(10, 11), P(0, 11)], params: { thickness: 0.22 } });

const pad = await tool('place_terrain', {
  level: L0,
  points: [P(-10, -12), P(24, -12), P(24, 20), P(-10, 20)],
  params: { bottom_offset: 0.06, elevation: 0, contour_interval: 0.1, major_contour_interval: 0.4, smooth: true },
});
await tool('set_slab_shape', {
  id: pad.id,
  shape: {
    z: [0, 0, 0, 0],
    points: [
      [2, 4, 0], [8, 4, 0], [12, 6, 0], [4, 9, 0],
      [-2, 14, 0.55], [8, 15.5, 1.2], [16, 14, 0.75], [8, 18.2, 0.4],
      [18, 6, 0.04], [2, -6, 0],
    ],
  },
});
const fenceLoop = [[-6, -8], [20, -8], [20, 16], [-6, 16], [-6, -8]];
for (let i = 0; i < 4; i++) {
  await tool('place_fence', { level: L0, points: [P(...fenceLoop[i]), P(...fenceLoop[i + 1])], params: { height: 1.6, thickness: 0.06 } });
}
await tool('place_gate', { level: L0, parent: await hostAt(L0, 2, -8, 'apex.fence'), points: [P(2, -8)], params: { width: 1.2, height: 1.5 } });
await tool('place_gate', { level: L0, parent: await hostAt(L0, 20, 3, 'apex.fence'), points: [P(20, 3)], params: { width: 3.2, height: 1.5 } });
const lawn = { thickness: 0.05, surface_kind: 'lawn', placement_mode: 'draped' };
const path = { thickness: 0.03, surface_kind: 'path', placement_mode: 'draped' };
const gravel = { thickness: 0.04, surface_kind: 'gravel', placement_mode: 'draped' };
const paved = { thickness: 0.08, surface_kind: 'paved', placement_mode: 'flat' };
const drive = { thickness: 0.1, surface_kind: 'driveway', placement_mode: 'flat' };
const surfaces = [
  { points: [[-5.8, -7.8], [-0.25, -7.8], [-0.25, 15.8], [-5.8, 15.8]], params: lawn },
  { points: [[-0.25, 11.25], [19.8, 11.25], [19.8, 15.8], [-0.25, 15.8]], params: lawn },
  { points: [[10.25, 7.25], [14.25, 7.25], [14.25, 11.25], [10.25, 11.25]], params: lawn },
  { points: [[14.25, 6.7], [19.8, 6.7], [19.8, 11.25], [14.25, 11.25]], params: lawn },
  { points: [[14.4, -7.8], [19.8, -7.8], [19.8, -0.5], [14.4, -0.5]], params: lawn },
  { points: [[3.05, -7.8], [14.05, -7.8], [14.05, -4.95], [3.05, -4.95]], params: lawn },
  { points: [[-0.25, -7.8], [1.15, -7.8], [1.15, -0.25], [-0.25, -0.25]], params: lawn },
  { points: [[3.05, -4.95], [4.05, -4.95], [4.05, -0.25], [3.05, -0.25]], params: lawn },
  { points: [[7.4, 11.45], [8.5, 11.45], [8.5, 13.2], [16.6, 14.7], [16.6, 15.55], [15.7, 15.55], [7.4, 14.05]], params: path },
  { points: [[1.1, 12.3], [6.2, 12.3], [6.2, 14.6], [1.1, 14.6]], params: gravel },
  { points: [[4.2, -4.8], [14.2, -4.8], [14.2, -0.25], [4.2, -0.25]], params: paved },
  { points: [[1.3, -7.6], [2.9, -7.6], [2.9, -0.2], [1.3, -0.2]], params: paved },
  { points: [[14.2, -0.3], [19.5, -0.3], [19.5, 6.5], [14.2, 6.5]], params: drive },
];
for (const ring of surfaces) {
  await tool('place_site_surface', { level: L0, points: ring.points.map(([x, z]) => P(x, z)), params: ring.params });
}
for (const x of [2, 5.5, 8.5]) {
  await tool('place_column', { level: L0, points: [P(x, -2)], params: { profile: 'apex.round', width: 0.22, height: UPPER } });
}

await tool('set_active_level', { id: L1 });
await placeWalls(L1, UPPER, U_EXT, EXT);
await placeWalls(L1, UPPER, U_INT, INT);
await placeOpenings(L1, UPPER, UPPER_OPENINGS);
await tool('place_slab', { level: L1, points: [P(0, -2), P(10, -2), P(10, 11), P(0, 11)], params: { thickness: 0.22 } });

await tool('place_stair', { level: L0, points: [P(1.15, 4.25), P(1.15, 7.75)], params: { width: 1.05, height: UPPER } });

await tool('place_roof', { level: L1, points: [P(10, -0.15, UPPER), P(14.35, -0.15, UPPER), P(14.35, 7.25, UPPER), P(10, 7.25, UPPER)], params: { thickness: 0.22 } });
const terrace = await tool('place_site_surface', {
  level: L1,
  points: [P(10.35, 0.35, UPPER), P(13.9, 0.35, UPPER), P(13.9, 6.7, UPPER), P(10.35, 6.7, UPPER)],
  params: { thickness: 0.05, surface_kind: 'lawn', placement_mode: 'flat' },
});
await tool('set_slab_shape', { id: terrace.id, shape: { z: [0.28, 0.28, 0.28, 0.28], points: [] } });

await tool('set_active_level', { id: LRoof });
await tool('place_roof', {
  level: LRoof,
  points: [P(-0.3, -2.3, ROOF_Y), P(10.3, -2.3, ROOF_Y), P(10.3, 11.3, ROOF_Y), P(-0.3, 11.3, ROOF_Y)],
  params: { thickness: 0.28 },
});
const green = await tool('place_site_surface', {
  level: LRoof,
  points: [P(0.45, -1.55, ROOF_Y), P(9.55, -1.55, ROOF_Y), P(9.55, 10.55, ROOF_Y), P(0.45, 10.55, ROOF_Y)],
  params: { thickness: 0.06, surface_kind: 'lawn', placement_mode: 'flat' },
});
await tool('set_slab_shape', { id: green.id, shape: { z: [0.34, 0.34, 0.34, 0.34], points: [] } });

const NAMES = {
  [L0]: [['sample.room.hall', 2, 1.5], ['sample.room.stair', 2, 6], ['sample.room.utility', 2, 9.5], ['sample.room.wc', 5.5, 9], ['sample.room.study', 8.5, 9], ['sample.room.living', 9, 3.5]],
  [L1]: [['sample.room.bed2', 2, 0.5], ['sample.room.bed3', 5.5, 0.5], ['sample.room.master', 8.5, 2], ['sample.room.stair', 2, 7], ['sample.room.upperHall', 5.5, 5.5], ['sample.room.bath', 5.5, 9.5], ['sample.room.ensuite', 8.5, 9.5]],
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
const missed = [];
for (const level of [L0, L1]) {
  for (const [name, x, z] of NAMES[level]) {
    const sp = spaces.find((s) => s.level === level && inside([x, z], s.outline ?? []));
    if (sp) await tool('update_space', { id: sp.id, name });
    else missed.push(`${name} @ (${x}, ${z})`);
  }
}

const views = {};
for (const [level, key] of [[L0, 'L0'], [L1, 'L1']]) {
  const { id } = await tool('create_plan_view', { level });
  views[key] = id;
  const W = (x, z) => ({ kind: 'world', point: P(x, z) });
  const dim = (a, b, offset = -0.8) => ({ op: 'create_view_annotation', view: id, annotation: { kind: 'linear_dimension', a: W(...a), b: W(...b), offset } });
  await tool('batch', {
    commands: [
      dim([0, 0], [4, 0], -1), dim([4, 0], [14, 0], -1), dim([0, 0], [14, 0], -1.8),
      dim([0, 0], [0, 11], 1.2),
      { op: 'create_view_annotation', view: id, annotation: { kind: 'text_note', position: W(0, -4), text: key === 'L0' ? 'GROUND FLOOR' : 'UPPER FLOOR' } },
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

const before = (await tool('summary')).elements;
await tool('undo');
await tool('redo');
const after = (await tool('summary')).elements;

await client.close();

const problems = [];
if (!report.ok) problems.push(`validate: ${report.errors} error(s): ${JSON.stringify(report.issues)}`);
if (leaky) problems.push(`${leaky} solid(s) not watertight`);
if (before !== after) problems.push(`undo/redo changed the element count ${before} → ${after}`);
if ((summary.spaces ?? 0) < 13) problems.push(`expected 13 rooms, got ${summary.spaces}`);
if (missed.length) problems.push(`rooms not found: ${missed.join(', ')}`);
console.log(`[house] ${calls} tool calls, ${elements.length} elements, ${report.warnings} warning(s); output in ${OUT}`);
if (problems.length) {
  console.log('[house] FAIL\n  - ' + problems.join('\n  - '));
  process.exit(1);
}
console.log('[house] OK: validates with no errors, every solid watertight');
