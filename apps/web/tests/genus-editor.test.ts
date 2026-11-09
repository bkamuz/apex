import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTree,
  deriveDraft,
  draftKey,
  nextDerivedId,
  paramInputFromSpec,
  previewRequest,
  testHostFor,
  topItemOfPath,
  type GenusDraft,
} from '../src/genusEditor/model.ts';
import { boxMesh, buildView, hostMesh } from '../src/genusEditor/projection.ts';

const draft = (over: Partial<GenusDraft> = {}): GenusDraft => ({
  id: 'user.window', name: 'W', extends: 'apex.window', params: [], refs: [], body: [], dims: [], remove: [], ...over,
});

test('derived ids never clash', () => {
  assert.equal(nextDerivedId('apex.window', []), 'user.window');
  assert.equal(nextDerivedId('apex.window', ['user.window']), 'user.window.2');
  assert.equal(nextDerivedId('user.door', ['user.door', 'user.door.2']), 'user.door.3');
});

test('derive starts empty and extends the base', () => {
  const base = { id: 'apex.door', category: 'door', params: [] } as never;
  const d = deriveDraft(base, ['user.door'], 'Copy');
  assert.equal(d.id, 'user.door.2');
  assert.equal(d.extends, 'apex.door');
  assert.deepEqual(d.body, []);
});

test('param input drops keys the core rejects', () => {
  const p = paramInputFromSpec({ id: 'width', kind: 'length', default: 1.2, unit: 'm', binding: 'type', label: 'width' } as never);
  assert.deepEqual(p, { id: 'width', default: 1.2, species: true });
});

test('preview request and dirty key', () => {
  const d = draft();
  const r = previewRequest(d, { species: 'apex.window.s', hostDepth: 0.25 });
  assert.equal(r.host_depth, 0.25);
  assert.equal(draftKey(d), draftKey(draft()));
  assert.notEqual(draftKey(d), draftKey(draft({ name: 'X' })));
});

test('tree marks inherited, removed and overrides', () => {
  const parent = {
    refs: [{ id: 'sill', ref: 'plane', normal: 'y' }],
    body: [
      { id: 'frame', item: 'solid', shape: 'box' },
      { id: 'opening', item: 'cut', shape: 'box', targets: { host: true } },
    ],
  } as never;
  const t = buildTree(draft({ body: [{ id: 'frame', item: 'solid', shape: 'box' } as never], remove: ['opening'] }), parent);
  assert.equal(t.body[0].overrides, true);
  assert.deepEqual(t.inherited.map((i) => [i.id, i.kind, i.removed, i.targets]), [['opening', 'cut', true, ['host']]]);
  assert.equal(t.refs[0].inherited, true);
  assert.equal(t.inheritedFrom, 'apex.window');
  assert.equal(topItemOfPath('frame#1/part'), 'frame');
});

test('test host only for host-placed genera', () => {
  assert.equal(testHostFor({ kind: 'point' } as never), null);
  assert.deepEqual(testHostFor({ kind: 'host', categories: ['wall'] } as never), { category: 'wall', depth: 0.25, height: 3 });
});

const meshOf = (min: [number, number, number], max: [number, number, number]) => {
  const b = boxMesh(min, max);
  return { positions: b.positions, normals: b.normals, indices: b.indices, edges: b.edges };
};

test('views project a window in a wall', () => {
  const preview = {
    ok: true, id: 'w', params: [], refs: [], dims: [], lines: [], plan_lines: [], warnings: [],
    solids: [{ path: 'frame', mesh: meshOf([-0.6, 0.9, -0.05], [0.6, 2.1, 0.05]) }],
    cuts: [{ path: 'opening', targets: { host: true }, mesh: meshOf([-0.6, 0.9, -1], [0.6, 2.1, 1]) }],
  } as never;
  const host = { category: 'wall', depth: 0.25, height: 3 };
  const front = buildView('front', preview, host);
  assert.equal(front.solids.at(-1)?.kind, 'cut');
  assert.ok(front.extents);
  assert.ok(Math.abs(front.extents.max[0] - front.extents.min[0] - 1.2) < 1e-9);
  assert.ok(Math.abs(front.extents.min[1] - 0.9) < 1e-9);
  assert.equal(front.host?.loops.length, 2);
  const plan = buildView('plan', preview, host);
  assert.ok(Math.abs(plan.extents!.max[1] - plan.extents!.min[1] - 0.1) < 1e-9);
  const side = buildView('side', preview, host);
  assert.ok(Math.abs(side.extents!.max[0] - side.extents!.min[0] - 0.1) < 1e-9);
  // Wall around the opening: left, right, below, above.
  assert.equal(hostMesh(preview, host).indices.length, 4 * 36);
});
