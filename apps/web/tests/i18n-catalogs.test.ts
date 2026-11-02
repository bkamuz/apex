// Key coverage: RU must translate every EN key; every snap kind has a label.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { en } from '../src/i18n/catalogs/en.ts';
import { ru } from '../src/i18n/catalogs/ru.ts';

test('ru and en catalogs have the same keys', () => {
  const missing = Object.keys(en).filter((k) => !(k in ru));
  const extra = Object.keys(ru).filter((k) => !(k in en));
  assert.deepEqual({ missing, extra }, { missing: [], extra: [] });
});

test('every snap kind has an EN and RU label', () => {
  for (const kind of ['end', 'mid', 'vertex', 'point', 'edge', 'intersection']) {
    const key = `snap.kind.${kind}`;
    assert.ok(en[key], `en ${key}`);
    assert.ok(ru[key] && ru[key] !== en[key], `ru ${key}`);
  }
});
