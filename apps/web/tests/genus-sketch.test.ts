import test from 'node:test';
import assert from 'node:assert/strict';
import {
  arcPoints,
  bodyRefIds,
  bulgeThrough,
  newBox,
  newSketchShape,
  refValues,
  renameRefInFormula,
  setVoid,
  isVoid,
  sketchLoops,
  snapPoint,
  solidKind,
  viewToPlane,
  planeToView,
  type ShapeItem,
} from '../src/genusEditor/sketch.ts';
import { refUsers, renameRef, type EvalRef } from '../src/genusEditor/refs.ts';
import type { GenusDraft } from '../src/genusEditor/model.ts';
import type { GenusSketchItemDto } from '../src/types.ts';

const refs: EvalRef[] = [
  { id: 'left', kind: 'plane', normal: 'x', points: [[-0.4, 0, 0]] },
  { id: 'right', kind: 'plane', normal: 'x', points: [[0.4, 0, 0]] },
  { id: 'sill', kind: 'plane', normal: 'y', points: [[0, 0.9, 0]] },
  { id: 'pin', kind: 'point', points: [[0.1, 0.2, 0]] },
];

test('a rectangle locked to planes is closed and flexes with them', () => {
  const items: GenusSketchItemDto[] = [{ kind: 'rect', a: ['ref.left', 0], b: ['ref.right', 'ref.sill'] }];
  const r = sketchLoops(items, refValues({}, refs));
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.loops[0][2], [0.4, 0.9]);
  const wide = refs.map((x) => (x.id === 'right' ? { ...x, points: [[0.7, 0, 0]] as EvalRef['points'] } : x));
  const w = sketchLoops(items, refValues({}, wide));
  assert.ok(w.ok && w.loops[0][2][0] === 0.7);
});

test('profile problems come back as codes', () => {
  assert.equal((sketchLoops([], {}) as { issue: { code: string } }).issue.code, 'empty');
  const open: GenusSketchItemDto[] = [
    { kind: 'line', a: [0, 0], b: [1, 0] },
    { kind: 'line', a: [1, 0], b: [1, 1] },
  ];
  const o = sketchLoops(open, {});
  assert.equal(o.ok, false);
  if (!o.ok) assert.equal(o.issue.code, 'open');
  const zero = sketchLoops([{ kind: 'circle', c: [0, 0], r: 0 }], {});
  assert.ok(!zero.ok && zero.issue.code === 'zero');
  const outside = sketchLoops(
    [
      { kind: 'rect', a: [0, 0], b: [1, 1] },
      { kind: 'circle', c: [3, 3], r: 0.2 },
    ],
    {},
  );
  assert.ok(!outside.ok && outside.issue.code === 'outside');
  const bad = sketchLoops([{ kind: 'rect', a: ['nope', 0], b: [1, 1] }], {});
  assert.ok(!bad.ok && bad.issue.code === 'formula');
});

test('lines and an arc close a loop; a hole stays inside', () => {
  const items: GenusSketchItemDto[] = [
    { kind: 'line', a: [0, 0], b: [1, 0] },
    { kind: 'line', a: [1, 0], b: [1, 1] },
    { kind: 'arc', a: [1, 1], b: [0, 1], bulge: 0.4142 },
    { kind: 'line', a: [0, 1], b: [0, 0] },
    { kind: 'circle', c: [0.5, 0.5], r: 0.1 },
  ];
  const r = sketchLoops(items, {});
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.loops.length, 2);
});

test('the bulge through a middle point matches the arc points', () => {
  const a: [number, number] = [1, 0];
  const b: [number, number] = [-1, 0];
  const up = bulgeThrough(a, [0, 1], b);
  assert.equal(up, 1);
  const pts = arcPoints(a, b, up);
  assert.ok(pts.some((p) => Math.abs(p[1] - 1) < 1e-3 && Math.abs(p[0]) < 1e-3));
  assert.equal(bulgeThrough(a, [0, -1], b), -1);
  assert.equal(bulgeThrough([0, 0], [1, 0], [2, 0]), 0);
});

test('clicks snap to point refs, then to planes seen edge-on', () => {
  const pin = snapPoint('z', [0.101, 0.199], { vertices: [], refs }, 0.02);
  assert.deepEqual(pin.q, ['ref.pin.x', 'ref.pin.y']);
  const edge = snapPoint('z', [0.395, 0.5], { vertices: [], refs }, 0.02);
  assert.deepEqual(edge.q, ['ref.right', 0.5]);
  assert.deepEqual(edge.locks, ['right']);
  const free = snapPoint('z', [0.2013, 0.5], { vertices: [], refs }, 0.02);
  assert.deepEqual(free.q, [0.2, 0.5]);
  const shared = snapPoint('z', [0.395, 0.5], { vertices: [{ q: ['ref.right', 'h'], at: [0.4, 0.51] }], refs }, 0.02);
  assert.deepEqual(shared.q, ['ref.right', 'h']);
  // In plan the sketch plane is (x, z): the sill plane (y) is not seen edge-on.
  assert.deepEqual(snapPoint('y', [0.0, 0.9], { vertices: [], refs }, 0.02).q, [0, 0.9]);
});

test('view and plane coordinates round-trip', () => {
  for (const v of ['front', 'plan', 'side'] as const) assert.deepEqual(planeToView(v, viewToPlane(v, [0.3, -0.2])), [0.3, -0.2]);
});

test('boxes, voids and kinds', () => {
  const box = newBox('box_1', 'front', ['ref.left', 0], ['ref.right', 1]);
  assert.equal(solidKind(box), 'box');
  assert.ok(box.shape === 'box');
  if (box.shape === 'box') {
    assert.deepEqual(box.min, ['ref.left', 0, -0.05]);
    assert.deepEqual(box.max, ['ref.right', 1, 0.05]);
  }
  const plan = newBox('box_2', 'plan', [0, 0], [1, 1]);
  if (plan.shape === 'box') assert.deepEqual([plan.min[1], plan.max[1]], [-0.05, 0.05]);
  const v = setVoid(box, true);
  assert.equal(v.item, 'cut');
  assert.ok(isVoid(v));
  assert.equal(setVoid(v, false).item, 'solid');
  const rev = newSketchShape('revolve_1', 'revolve', 'front', [{ kind: 'rect', a: [0.1, 0], b: [0.2, 1] }], 'axis');
  assert.equal(solidKind(rev), 'revolve');
});

test('ref renames reach formulas and the axis; users include locked shapes', () => {
  assert.equal(renameRefInFormula('ref.right - ref.right_2 + ref.right.x', 'right', 'r'), 'ref.r - ref.right_2 + ref.r.x');
  const box = newBox('box_1', 'front', ['ref.left', 0], ['ref.right', 1]);
  const rev = newSketchShape('revolve_1', 'revolve', 'front', [{ kind: 'rect', a: [0.1, 0], b: [0.2, 1] }], 'axis');
  assert.deepEqual(bodyRefIds(box).sort(), ['left', 'right']);
  const draft: GenusDraft = {
    id: 'user.w', name: 'W', extends: 'apex.window', params: [], refs: [], body: [box, rev], dims: [], remove: [],
  };
  assert.deepEqual(refUsers(draft, null, 'right'), ['box_1']);
  assert.deepEqual(refUsers(draft, null, 'axis'), ['revolve_1']);
  const renamed = renameRef(draft, 'axis', 'spin');
  assert.equal((renamed.body[1] as ShapeItem & { axis?: string }).axis, 'spin');
  const r2 = renameRef(draft, 'right', 'r');
  const b = r2.body[0];
  assert.ok(b.item === 'solid' && b.shape === 'box' && b.max[0] === 'ref.r');
});
