import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addTerm,
  bindDim,
  deleteRef,
  evalRef,
  flexContext,
  flexDim,
  flexRefDrag,
  flexValues,
  listRefs,
  measure,
  newDimAxis,
  newPlaneRef,
  offsetFormula,
  planeNormal,
  putDim,
  putRef,
  renameRef,
  toGenus,
} from '../src/genusEditor/refs.ts';
import { paramRows, type DraftSpecies } from '../src/genusEditor/params.ts';
import type { GenusDraft } from '../src/genusEditor/model.ts';

const draft = (over: Partial<GenusDraft> = {}): GenusDraft => ({
  id: 'user.window', name: 'W', extends: 'apex.window', params: [], refs: [], body: [], dims: [], remove: [], ...over,
});
const parentSpecs = [
  { id: 'width', label: 'Width', kind: 'length', default: 1.2, binding: 'type', min: 0.3 },
  { id: 'height', label: 'Height', kind: 'length', default: 1.4, binding: 'type' },
  { id: 'sill', label: 'Sill', kind: 'length', default: 0.9 },
] as never[];
const parent = { body: [], refs: [{ id: 'sill', ref: 'plane', origin: [0, 'sill', 0], normal: 'y' }] } as never;
const sp: DraftSpecies = { id: 's1', name: 'A', values: { width: 1.5, height: 1.4 } };

test('screen points map to genus axes per view', () => {
  assert.deepEqual(toGenus('front', 1, 2), [1, 2, 0]);
  assert.deepEqual(toGenus('plan', 1, 2), [1, 0, -2]);
  assert.deepEqual(toGenus('side', 1, 2), [0, 2, -1]);
  assert.equal(planeNormal('front', 'v'), 'x');
  assert.equal(planeNormal('plan', 'h'), 'z');
  assert.equal(planeNormal('side', 'v'), 'z');
  assert.deepEqual(newPlaneRef('p', [0.3, 0.5, 0.1], 'x'), { id: 'p', ref: 'plane', origin: [0.3, 0, 0], normal: 'x' });
});

test('formula terms stay short', () => {
  assert.equal(addTerm(0, 'width', 1), 'width');
  assert.equal(addTerm('-width / 2', 'w2', -1), '-width / 2 - w2');
  assert.equal(addTerm('a > 1', 'w', 1), '(a > 1) + w');
  assert.equal(offsetFormula(0.1, 0.05), 0.15);
  assert.equal(offsetFormula('width / 2', -0.1), 'width / 2 - 0.1');
});

test('refs merge over the parent; delete drops dims and refuses refs in use', () => {
  let d = putRef(draft(), { id: 'left', ref: 'plane', origin: [-0.5, 0, 0], normal: 'x' });
  d = putDim(d, { id: 'd1', from: 'sill', to: 'left' });
  assert.deepEqual(listRefs(d, parent).map((r) => [r.ref.id, r.inherited]), [['sill', true], ['left', false]]);
  const gone = deleteRef(d, parent, 'sill')!;
  assert.deepEqual(gone.remove, ['sill']);
  assert.equal(gone.dims.length, 0);
  const used = draft({ refs: d.refs, body: [{ id: 's', item: 'solid', shape: 'sweep', along: 'left', profile: [] }] as never });
  assert.equal(deleteRef(used, parent, 'left'), null);
  const renamed = renameRef(used, 'left', 'l');
  assert.equal((renamed.body[0] as { along: string }).along, 'l');
});

test('a label makes the param drive the dim; dragging the dim writes the species value', () => {
  let d = putRef(draft(), { id: 'left', ref: 'plane', origin: [-0.75, 0, 0], normal: 'x' });
  d = putRef(d, { id: 'right', ref: 'plane', origin: [0.75, 0, 0], normal: 'x' });
  d = putDim(d, { id: 'w', from: 'left', to: 'right', axis: 'x' });
  const rows = paramRows(d, parentSpecs);
  const ctx0 = flexContext(d, parent, rows, sp);
  const bound = bindDim(d, parent, 'w', 'width', flexValues(ctx0));
  assert.ok(bound.driving);
  assert.equal(bound.draft.refs.find((r) => r.id === 'right')!.ref === 'plane' && (bound.draft.refs.find((r) => r.id === 'right') as { origin: unknown[] }).origin[0], '-0.75 + width');
  const ctx = flexContext(bound.draft, parent, rows, sp);
  // Drag the right end from 0.75 to 1.0: width 1.5 → 1.75.
  const r = flexDim(ctx, 'w', 'to', 1.0);
  assert.deepEqual(r, { kind: 'param', id: 'width', value: 1.75 });
  // Width has a min of 300 mm.
  assert.deepEqual(flexDim(ctx, 'w', 'to', -2), { kind: 'param', id: 'width', value: 0.3 });
  // Dragging the constant left end still changes the width (the dim's param).
  const l = flexDim(ctx, 'w', 'from', -1.0);
  assert.equal(l.kind, 'param');
  assert.equal(l.kind === 'param' && Math.round(l.value * 1000), 1750);
});

test('symmetric refs: dragging one plane moves it under the pointer; locked dims hold', () => {
  let d = putRef(draft(), { id: 'left', ref: 'plane', origin: ['-width / 2', 0, 0], normal: 'x' });
  d = putRef(d, { id: 'right', ref: 'plane', origin: ['width / 2', 0, 0], normal: 'x' });
  d = putRef(d, { id: 'head', ref: 'plane', origin: [0, 'sill + height', 0], normal: 'y' });
  d = putDim(d, { id: 'w', from: 'left', to: 'right', param: 'width' });
  d = putDim(d, { id: 'h', from: 'sill', to: 'head', param: 'height', locked: true });
  const ctx = flexContext(d, parent, paramRows(d, parentSpecs), sp);
  const v = flexValues(ctx);
  assert.equal(measure(evalRef(ctx.refs.get('sill')!, v), evalRef(ctx.refs.get('head')!, v), 1), 1.4);
  assert.deepEqual(flexRefDrag(ctx, 'right', 'front', [0.75, 0, 0], [1, 0, 0]), [{ kind: 'param', id: 'width', value: 2 }]);
  // The head reads sill + height; height is held by the locked dim, so the sill flexes.
  const head = flexRefDrag(ctx, 'head', 'front', [0, 2.3, 0], [0, 2.5, 0]);
  assert.equal(head.length, 1);
  assert.equal(head[0].kind, 'param');
  assert.equal(head[0].kind === 'param' && head[0].id, 'sill');
  assert.deepEqual(flexDim(ctx, 'h', 'to', 3), { kind: 'blocked', reason: 'locked' });
  // A constant point moves as a constant.
  const p = putRef(d, { id: 'pt', ref: 'point', at: [0.1, 0.2, 0] });
  const moved = flexRefDrag(flexContext(p, parent, paramRows(p, parentSpecs), sp), 'pt', 'front', [0.1, 0.2, 0], [0.3, 0.25, 0]);
  assert.deepEqual(moved.map((m) => m.kind === 'move' && m.ref), [
    { id: 'pt', ref: 'point', at: [0.3, 0.2, 0] },
    { id: 'pt', ref: 'point', at: [0.3, 0.25, 0] },
  ]);
});

test('new dims pick their axis from planes or the screen direction', () => {
  const a = { id: 'a', kind: 'point' as const, points: [[0, 0, 0]] as [number, number, number][] };
  const b = { id: 'b', kind: 'point' as const, points: [[0.1, 0.5, 0]] as [number, number, number][] };
  assert.equal(newDimAxis('front', a, b), 'y');
  assert.equal(newDimAxis('plan', a, { ...b, points: [[0.1, 0, 0.5]] }), 'z');
  assert.equal(newDimAxis('front', { ...a, kind: 'plane', normal: 'x' }, b), 'x');
});

test('equal dims: a second dim bound to the same param chains off the first', () => {
  let d = putRef(draft(), { id: 'p1', ref: 'plane', origin: [-0.6, 0, 0], normal: 'x' });
  d = putRef(d, { id: 'p2', ref: 'plane', origin: [0.6, 0, 0], normal: 'x' });
  d = putRef(d, { id: 'p3', ref: 'plane', origin: [0.9, 0, 0], normal: 'x' });
  d = putDim(d, { id: 'a', from: 'p1', to: 'p2', axis: 'x' });
  d = putDim(d, { id: 'b', from: 'p2', to: 'p3', axis: 'x' });
  const rows = paramRows(d, parentSpecs);
  const vals = flexValues(flexContext(d, parent, rows, { ...sp, values: { width: 1.2 } }));
  d = bindDim(d, parent, 'a', 'width', vals).draft;
  const second = bindDim(d, parent, 'b', 'width', vals);
  assert.ok(second.driving);
  assert.equal((second.draft.refs.find((r) => r.id === 'p3') as { origin: unknown[] }).origin[0], '-0.6 + width + width');
  // Binding again changes nothing.
  const again = bindDim(second.draft, parent, 'b', 'width', vals);
  assert.ok(again.driving);
  assert.deepEqual(again.draft.refs, second.draft.refs);
});
