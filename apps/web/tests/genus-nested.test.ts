import test from 'node:test';
import assert from 'node:assert/strict';
import type { ComponentDto, GenusBodyItemDto } from '../src/types.ts';
import { bindableParams, mirrorBlock, mirrorFormula, mirrorItem, nestableGenera, newNested, setBinding, type NestedItem } from '../src/genusEditor/nested.ts';
import { asCut, CUT_DEPTH, type ShapeItem } from '../src/genusEditor/sketch.ts';

const genus = (id: string, body: GenusBodyItemDto[] = []) =>
  ({ id, display_name: id, category: 'opening', source: 'visual', params: [], genus: { body } }) as unknown as ComponentDto;

test('nestable genera exclude itself and anything that already nests it', () => {
  const all = [
    genus('user.a', [{ id: 'n', item: 'nested', genus: 'user.b' }]),
    genus('user.b', [{ id: 'n', item: 'nested', genus: 'user.c' }]),
    genus('user.c'),
    genus('user.d'),
    { ...genus('apex.wall'), genus: undefined } as ComponentDto,
  ];
  assert.deepEqual(nestableGenera(all, 'user.c').map((c) => c.id), ['user.d']);
  assert.deepEqual(nestableGenera(all, 'user.a').map((c) => c.id), ['user.b', 'user.c', 'user.d']);
});

test('new nested items sit on a point ref or at a rounded point', () => {
  assert.deepEqual(newNested('nested_1', 'user.leaf', { ref: 'pt_1' }), { id: 'nested_1', item: 'nested', genus: 'user.leaf', at: 'pt_1' });
  assert.deepEqual(newNested('nested_2', 'user.leaf', { point: [0.123456, 0, -1] }).offset, [0.1235, 0, -1]);
});

test('bindings set, clear and drop the empty params map', () => {
  const n: NestedItem = { id: 'n', item: 'nested', genus: 'user.leaf' };
  const a = setBinding(n, 'width', 'width / 2');
  assert.deepEqual(a.params, { width: 'width / 2' });
  assert.equal('params' in setBinding(a, 'width', ''), false);
  const kinds = bindableParams({ params: [{ id: 'w', kind: 'length' }, { id: 'm', kind: 'material' }, { id: 'on', kind: 'bool' }] } as unknown as ComponentDto);
  assert.deepEqual(kinds.map((p) => p.id), ['w', 'on']);
});

test('mirror formulas reflect about the plane ref', () => {
  assert.equal(mirrorFormula(0, 'p'), '2 * ref.p');
  assert.equal(mirrorFormula(0.3, 'p'), '2 * ref.p - 0.3');
  assert.equal(mirrorFormula(-0.3, 'p'), '2 * ref.p + 0.3');
  assert.equal(mirrorFormula('width', 'p'), '2 * ref.p - width');
  assert.equal(mirrorFormula('-width / 4', 'p'), '2 * ref.p - (-width / 4)');
});

test('mirrored box swaps min and max on the plane axis only', () => {
  const b: GenusBodyItemDto = { id: 'k', item: 'solid', shape: 'box', min: [0.1, 0, 0], max: [0.3, 1, 0.05] };
  const m = mirrorItem(b, 'k_m_1', 'p', 'x') as Extract<GenusBodyItemDto, { shape: 'box' }>;
  assert.deepEqual(m.min, ['2 * ref.p - 0.3', 0, 0]);
  assert.deepEqual(m.max, ['2 * ref.p - 0.1', 1, 0.05]);
  assert.equal(m.id, 'k_m_1');
});

test('mirrored prism sketch flips the in-plane coordinate and arc bulge', () => {
  const b = {
    id: 's', item: 'solid', shape: 'prism', normal: 'z', depth: [0, 0.1],
    sketch: [{ kind: 'arc', a: [0, 0], b: [0.4, 0], bulge: 0.5 }, { kind: 'line', a: [0.4, 0], b: [0, 0] }],
  } as unknown as GenusBodyItemDto;
  const m = mirrorItem(b, 's_m', 'p', 'x') as unknown as { sketch: { a: unknown[]; bulge?: unknown }[]; depth: unknown[] };
  assert.deepEqual(m.sketch[0].a, ['2 * ref.p', 0]);
  assert.equal(m.sketch[0].bulge, -0.5);
  assert.deepEqual(m.depth, [0, 0.1]);
  // Across its own normal only the depth reflects.
  const d = mirrorItem(b, 's_m', 'q', 'z') as unknown as { depth: unknown[] };
  assert.deepEqual(d.depth, ['2 * ref.q - 0.1', '2 * ref.q']);
});

test('mirrored nested genus toggles mirror and turns its yaw', () => {
  const n: NestedItem = { id: 'n', item: 'nested', genus: 'user.leaf', offset: ['-width / 4', 0, 0], rotation: 30 };
  const x = mirrorItem(n, 'n_m', 'p', 'x') as NestedItem;
  assert.equal(x.mirror, true);
  assert.equal(x.rotation, -30);
  assert.deepEqual(x.offset, ['2 * ref.p - (-width / 4)', 0, 0]);
  const z = mirrorItem({ ...n, mirror: true }, 'n_m', 'p', 'z') as NestedItem;
  assert.equal(z.rotation, 150);
  assert.equal('mirror' in z, false);
  const at = mirrorItem({ id: 'a', item: 'nested', genus: 'user.leaf', at: 'pt' }, 'a_m', 'p', 'x') as NestedItem;
  assert.equal(at.at, undefined);
  assert.deepEqual(at.offset, ['2 * ref.p - ref.pt.x', 'ref.pt.y', 'ref.pt.z']);
});

test('mirror refuses what it cannot reflect', () => {
  assert.equal(mirrorBlock({ id: 'n', item: 'nested', genus: 'g' }, 'y'), 'vertical');
  const rev = { id: 'r', item: 'solid', shape: 'revolve' } as unknown as GenusBodyItemDto;
  assert.equal(mirrorBlock(rev, 'x'), 'shape');
  assert.equal(mirrorItem(rev, 'r_m', 'p', 'x'), null);
  const on = { id: 'o', item: 'solid', shape: 'prism', on: 'plane_1', depth: [0, 1], sketch: [] } as unknown as GenusBodyItemDto;
  assert.equal(mirrorBlock(on, 'x'), 'on');
});

test('the cut tool turns a new shape into a through-host cut', () => {
  const box = { id: 'b', item: 'solid', shape: 'box', min: [0, 2, 0], max: [0.5, 3, 0.1], material: 'wood' } as unknown as ShapeItem;
  const c = asCut(box, 'front') as Extract<ShapeItem, { shape: 'box' }>;
  assert.equal(c.item, 'cut');
  assert.deepEqual((c as unknown as { targets: unknown }).targets, { host: true });
  assert.deepEqual([c.min[2], c.max[2]], CUT_DEPTH);
  assert.equal('material' in c, false);
  const pr = asCut({ id: 'p', item: 'solid', shape: 'prism', normal: 'z', depth: [0, 0.1], sketch: [] } as unknown as ShapeItem, 'front');
  assert.deepEqual((pr as unknown as { depth: unknown }).depth, CUT_DEPTH);
});
