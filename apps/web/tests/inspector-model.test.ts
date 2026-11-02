// Run: node --experimental-strip-types --test tests/inspector-model.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GROUP_ORDER,
  MIXED,
  canReset,
  checkNumber,
  commonParams,
  groupForSpec,
  groupSpecs,
  provenanceIndex,
  stepFor,
  unitFor,
} from '../src/ui/inspector/model.ts';

const spec = (id: string, kind: any = 'length', extra: any = {}) =>
  ({ id, label: id, kind, default: kind === 'bool' ? false : kind === 'text' ? '' : 1, ...extra }) as any;

test('params land in a fixed section order', () => {
  assert.equal(groupForSpec(spec('height')), 'dimensions');
  assert.equal(groupForSpec(spec('sill')), 'constraints');
  assert.equal(groupForSpec(spec('allow_join_start', 'bool')), 'constraints');
  assert.equal(groupForSpec(spec('attach_top_to', 'text')), 'constraints');
  assert.equal(groupForSpec(spec('profile', 'profile')), 'materials');
  assert.equal(groupForSpec(spec('material', 'choice')), 'materials');
  assert.equal(groupForSpec(spec('ifc_class', 'text')), 'analytics');
  assert.equal(groupForSpec(spec('mark', 'text')), 'identity');
  assert.equal(groupForSpec(spec('width'), true), 'genus');
  assert.equal(groupForSpec(spec('sill'), true), 'constraints');
  const groups = groupSpecs([spec('width'), spec('profile', 'profile'), spec('sill'), spec('depth')]);
  assert.deepEqual(groups.map((g) => g.id), ['constraints', 'dimensions', 'materials']);
  assert.deepEqual(groups[1].specs.map((s) => s.id), ['width', 'depth']);
  for (const g of groups) assert.ok(GROUP_ORDER.includes(g.id));
});

test('numeric input is validated, never NaN', () => {
  assert.deepEqual(checkNumber('0,25', {}), { ok: true, value: 0.25 });
  assert.deepEqual(checkNumber(' ', {}), { ok: false, reason: 'empty' });
  assert.deepEqual(checkNumber('abc', {}), { ok: false, reason: 'nan' });
  assert.deepEqual(checkNumber('0.01', { min: 0.02 }), { ok: false, reason: 'min', limit: 0.02 });
  assert.deepEqual(checkNumber('9', { max: 5 }), { ok: false, reason: 'max', limit: 5 });
  assert.deepEqual(checkNumber('5', { min: 0, max: 5 }), { ok: true, value: 5 });
});

test('units and steps follow the kind', () => {
  assert.equal(unitFor(spec('h')), 'm');
  assert.equal(unitFor(spec('h', 'length', { unit: 'mm' })), 'mm');
  assert.equal(unitFor(spec('n', 'number')), null);
  assert.equal(stepFor(spec('h')), 0.01);
  assert.equal(stepFor(spec('rows', 'number', { default: 2, min: 1 })), 1);
});

test('provenance rows index by id; only overrides reset', () => {
  const idx = provenanceIndex([
    { id: 'sill', value: 1.1, source: 'instance' },
    { id: 'width', value: 1.2, source: 'species', from: 'w1' },
    { id: 'core', value: 0.1, source: 'formula', formula: 'thickness * 0.5' },
    { id: 'species', value: 'w1', source: 'instance' },
  ]);
  assert.equal(idx.core.formula, 'thickness * 0.5');
  assert.ok(canReset(idx.sill));
  assert.ok(!canReset(idx.width));
  assert.ok(!canReset(idx.core));
  assert.ok(!canReset(idx.species));
  assert.ok(!canReset(undefined));
});

test('multi-selection keeps common params and marks mixed values', () => {
  const wall = [spec('height'), spec('allow_join_start', 'bool'), spec('profile', 'profile')];
  const rows = commonParams([
    { specs: wall, values: { height: 3, allow_join_start: true, profile: 'a' } },
    { specs: wall, values: { height: 3, allow_join_start: false, profile: 'a' } },
    { specs: [...wall, spec('extra')], values: { height: 3.0000000001, profile: 'a' } },
  ]);
  assert.deepEqual(rows.map((r) => r.spec.id), ['height', 'allow_join_start', 'profile']);
  assert.equal(rows[0].value, 3);
  assert.equal(rows[1].value, MIXED);
  assert.equal(rows[2].value, 'a');
  assert.deepEqual(commonParams([{ specs: wall, values: {} }, { specs: [spec('x')], values: {} }]), []);
});
