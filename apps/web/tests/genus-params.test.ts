import test from 'node:test';
import assert from 'node:assert/strict';
import { evalAst, namesInJson, parseFormula } from '../src/genusEditor/formula.ts';
import {
  addParam,
  addSpecies,
  copySpecies,
  deleteParam,
  groupOf,
  nextSpeciesId,
  paramRows,
  renameParam,
  resolvedValues,
  setParam,
  sourceOf,
  speciesCommands,
  speciesValues,
  usedByGeometry,
  validateParams,
  type DraftSpecies,
} from '../src/genusEditor/params.ts';
import type { GenusDraft } from '../src/genusEditor/model.ts';

const draft = (over: Partial<GenusDraft> = {}): GenusDraft => ({
  id: 'user.window', name: 'W', extends: 'apex.window', params: [], refs: [], body: [], dims: [], remove: [], ...over,
});
const parentSpecs = [
  { id: 'species', label: 'Species', kind: 'choice', options: ['a'], default: 'a' },
  { id: 'width', label: 'Width', kind: 'length', default: 1.2, binding: 'type' },
  { id: 'frame_width', label: 'Frame width', kind: 'length', default: 0.06, binding: 'type' },
  { id: 'sill', label: 'Sill', kind: 'length', default: 0.9 },
  { id: 'style', label: 'Style', kind: 'choice', options: ['a', 'b'], default: 'a' },
] as never[];

test('formulas parse like the core and evaluate', () => {
  const ok = parseFormula('if(width > 1, (width - 2 * frame_w) / 2, min(width, 0.5))');
  assert.ok(ok.ok);
  if (ok.ok) {
    assert.deepEqual(ok.refs, ['width', 'frame_w']);
    assert.equal(evalAst(ok.ast, { width: 1.5, frame_w: 0.05 }), 0.7);
    assert.equal(evalAst(ok.ast, { width: 0.8, frame_w: 0.05 }), 0.5);
  }
  const bad = parseFormula('width +');
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.error.code, 'end');
  const paren = parseFormula('(width');
  assert.ok(!paren.ok && paren.error.code === 'paren');
  const args = parseFormula('min(width)');
  assert.ok(!args.ok && args.error.code === 'args');
  assert.ok(parseFormula('vent and not width = 0').ok);
  assert.deepEqual([...namesInJson([{ id: 'bar', item: 'solid', shape: 'box', max: ['width / 2', 1, 'sill'], visible: 'vent' }])].sort(), ['sill', 'vent', 'width']);
});

test('rows merge inherited params with own overrides', () => {
  const d = draft({ params: [{ id: 'width', default: 1.5, species: true }, { id: 'half', default: 0, formula: 'width / 2' }] });
  const rows = paramRows(d, parentSpecs);
  assert.deepEqual(rows.map((r) => [r.id, r.inherited, r.overridden, r.locked]), [
    ['width', true, true, false],
    ['frame_width', true, false, false],
    ['sill', true, false, false],
    ['style', true, false, true],
    ['half', false, false, false],
  ]);
  assert.equal(sourceOf(rows[0].input), 'species');
  assert.equal(sourceOf(rows[2].input), 'instance');
  assert.equal(sourceOf(rows[4].input), 'genus');
  assert.equal(groupOf(rows[1].input), 'dimensions');
  assert.equal(groupOf(rows[4].input), 'other');
});

test('editing an inherited param overrides it; delete resets', () => {
  const d = draft();
  const rows = paramRows(d, parentSpecs);
  const d2 = setParam(d, rows, 'sill', { species: true });
  assert.deepEqual(d2.params, [{ id: 'sill', label: 'Sill', default: 0.9, species: true }]);
  assert.equal(paramRows(d2, parentSpecs).find((r) => r.id === 'sill')?.overridden, true);
  assert.deepEqual(deleteParam(d2, 'sill').params, []);
  // Locked kinds stay untouched.
  assert.equal(setParam(d, rows, 'style', { label: 'x' }), d);
  // A formula drops the species binding; a text kind drops the formula.
  const d3 = setParam(d, rows, 'width', { formula: 'frame_width * 20' });
  assert.equal(d3.params[0].species, undefined);
  const r3 = paramRows(d3, parentSpecs);
  const d4 = setParam(d3, r3, 'width', { kind: 'text' });
  assert.equal(d4.params[0].formula, undefined);
  assert.equal(d4.params[0].default, '1.2');
});

test('add and rename own params; species values follow', () => {
  const d = draft();
  const { draft: d2, id } = addParam(d, paramRows(d, parentSpecs), 'bool', 'Vent');
  assert.equal(id, 'param_1');
  assert.deepEqual(d2.params[0], { id: 'param_1', label: 'Vent', kind: 'bool', default: false, group: 'other' });
  const species: DraftSpecies[] = [{ id: 's', name: 'S', values: { param_1: true } }];
  const r = renameParam(d2, species, paramRows(d2, parentSpecs), 'param_1', 'vent');
  assert.equal(r.draft.params[0].id, 'vent');
  assert.deepEqual(r.species[0].values, { vent: true });
  // Inherited ids cannot be renamed.
  assert.equal(renameParam(d2, species, paramRows(d2, parentSpecs), 'width', 'w').draft, d2);
});

test('validation: ids, ranges, formulas, cycles', () => {
  const d = draft({
    params: [
      { id: '9x', default: 1 },
      { id: 'length', default: 1 },
      { id: 'a', default: 0, formula: 'b + 1' },
      { id: 'b', default: 0, formula: 'a * 2' },
      { id: 'c', default: 0, formula: 'nope / 2' },
      { id: 'd', default: 0, formula: 'width +' },
      { id: 'e', default: 5, min: 6, max: 4 },
      { id: 'f', default: 0, formula: 'style' },
    ],
  });
  const issues = validateParams(paramRows(d, parentSpecs));
  const codes = (id: string) => (issues.get(id) ?? []).map((i) => i.formula?.code ?? i.code);
  assert.deepEqual(codes('9x'), ['idChars']);
  assert.deepEqual(codes('length'), ['idReserved']);
  assert.deepEqual(codes('a'), ['cycle']);
  assert.deepEqual(codes('b'), ['cycle']);
  assert.deepEqual(codes('c'), ['unknown']);
  assert.deepEqual(codes('d'), ['end']);
  assert.deepEqual(codes('e'), ['minMax', 'outOfRange']);
  assert.deepEqual(codes('f'), ['text']);
  assert.equal(issues.has('width'), false);
});

test('computed values per species', () => {
  const d = draft({ params: [{ id: 'half', default: 0, formula: '(width - 2 * frame_width) / 2' }, { id: 'wide', kind: 'bool', default: false, formula: 'width > 1.4' }] });
  const rows = paramRows(d, parentSpecs);
  const s: DraftSpecies = { id: 's', name: 'S', values: { width: 1.5 } };
  const v = resolvedValues(rows, s);
  assert.ok(Math.abs(Number(v.half) - 0.69) < 1e-9);
  assert.equal(v.wide, true);
  assert.equal(resolvedValues(rows, null).wide, false);
  assert.deepEqual(speciesValues(rows, s), { width: 1.5, frame_width: 0.06 });
});

test('species ids, copies and save commands', () => {
  assert.equal(nextSpeciesId('user.window', 'Wide 2100', []), 'user.window.wide-2100');
  assert.equal(nextSpeciesId('user.window', 'Вид 2', []), 'user.window.species-2');
  assert.equal(nextSpeciesId('user.window', 'Wide', ['user.window.wide']), 'user.window.wide-2');
  const copies = copySpecies(
    'user.window',
    [
      { id: 'apex.window.a', name: 'A', values: { width: 1.5 } },
      { id: 'apex.window.b', name: 'B', default: true, values: { width: 1.2 } },
    ],
    (r) => `«${r.name}»`,
  );
  assert.deepEqual(copies.map((s) => [s.id, s.name]), [['user.window.b', '«B»'], ['user.window.a', '«A»']]);
  const rows = paramRows(draft(), parentSpecs);
  const added = addSpecies('user.window', copies, rows, 'Wide', copies[0]);
  assert.equal(added.id, 'user.window.wide');
  assert.deepEqual(added.species[2].values, { width: 1.2, frame_width: 0.06 });
  const saved = copies;
  const current = [{ ...copies[0], name: 'B2' }, added.species[2]];
  assert.deepEqual(speciesCommands('user.window', saved, current, rows), [
    { op: 'delete_species', id: 'user.window.a' },
    { op: 'create_species', genus: 'user.window', id: 'user.window.b', name: 'B2', params: { width: 1.2 } },
    { op: 'create_species', genus: 'user.window', id: 'user.window.wide', name: 'Wide', params: { width: 1.2, frame_width: 0.06 } },
  ]);
  assert.deepEqual(speciesCommands('user.window', saved, saved, rows), []);
});

test('params read by the geometry are reported', () => {
  const d = draft({ body: [{ id: 'bar', item: 'solid', shape: 'box', min: [0, 'sill', 0], max: ['width', 1, 0.1] } as never] });
  assert.deepEqual([...usedByGeometry(d)].sort(), ['sill', 'width']);
});

test('every shipped species has an EN and RU name', async () => {
  const { readFileSync } = await import('node:fs');
  const { en } = await import('../src/i18n/catalogs/en.ts');
  const { ru } = await import('../src/i18n/catalogs/ru.ts');
  const src = readFileSync(new URL('../../../crates/apex-core/src/registry.rs', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('pub fn builtin_species'));
  const ids = [...body.slice(0, body.indexOf('\n}\n')).matchAll(/"(apex\.[a-z]+\.[a-z0-9-]+)"/g)].map((m) => m[1]);
  assert.ok(ids.length >= 7, ids.join());
  for (const id of ids) {
    const key = `species.${id}`;
    assert.ok((en as Record<string, string>)[key], key);
    assert.ok((ru as Record<string, string>)[key] && (ru as Record<string, string>)[key] !== (en as Record<string, string>)[key], key);
  }
});
