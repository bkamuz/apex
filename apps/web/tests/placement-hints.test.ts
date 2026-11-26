import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { en } from '../src/i18n/catalogs/en.ts';
import { ru } from '../src/i18n/catalogs/ru.ts';
import { remainingPickHint } from '../src/tools/pickHint.ts';

function fill(template: string, params: Record<string, string | number>): string {
  let out = template;
  for (const [key, value] of Object.entries(params)) {
    out = out.replaceAll(`{${key}}`, String(value));
  }
  return out;
}

const plural = (n: number) => (n === 1 ? '' : 's');

const counted = [
  'tool.ref.hintClicks',
  'tool.construction-line.hintClicks',
  'tool.grid-axis.hintClicks',
  'tool.section-cut.hintClicks',
  'tool.apex.dimension.hintClicks',
  'tool.space.hintNeedMore',
] as const;

test('english counted hints stay singular for one pick', () => {
  for (const key of counted) {
    assert.match(en[key], /\{s\}/, key);
    const one = fill(en[key], { n: 1, picked: 1, need: 2, name: 'Point', s: plural(1) });
    const two = fill(en[key], { n: 2, picked: 2, need: 1, name: 'Point', s: plural(2) });
    assert.match(one, /\bpoint\b/);
    assert.doesNotMatch(one, /\bpoints\b/);
    assert.match(two, /\bpoints\b/);
  }
});

test('the first click uses the placing sentence, the next uses the count', () => {
  const placing = en['tool.grid-axis.hintPlacing'];
  const said = (pending: number) =>
    remainingPickHint(pending, 2, placing, (n) =>
      fill(en['tool.grid-axis.hintClicks'], { n, s: plural(n) }),
    );
  assert.equal(said(0), 'Click the first point of the grid axis.');
  assert.equal(said(1), 'Click 1 more point for the grid axis.');
  assert.equal(
    remainingPickHint(0, 1, fill(en['tool.ref.hintPlacing'], { name: 'Point' }), () => 'unused'),
    'Click to place Point.',
  );
  assert.equal(ru['tool.grid-axis.hintPlacing'], 'Щёлкните первую точку оси.');
  assert.equal(ru['tool.ref.hintPlacing'], 'Щёлкните, чтобы поставить «{name}».');
});

test('pick tools ask for the placing sentence before any click', () => {
  for (const file of [
    'src/tools/gridAxisTool.ts',
    'src/tools/constructionLineTool.ts',
    'src/tools/sectionCutTool.ts',
    'src/tools/referenceTool.ts',
    'src/annotations/builtinLinearDimension.ts',
  ]) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.match(src, /remainingPickHint\(/, file);
  }
});
