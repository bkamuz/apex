import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setLocale } from '../src/i18n/t.ts';
import { localizeDocumentName } from '../src/ui/sampleLabels.ts';

test('sample names and uppercased sheet titles follow the locale', () => {
  setLocale('en');
  assert.equal(localizeDocumentName('sample.room.living'), 'Living, kitchen and dining');
  assert.equal(localizeDocumentName('sample.level.ground — Plan'), 'Ground floor — Plan');
  assert.equal(localizeDocumentName('SAMPLE.LEVEL.GROUND — PLAN'), 'Ground floor — Plan');
  assert.equal(localizeDocumentName('SAMPLE.LEVEL.UPPER — PLAN 2'), 'Upper floor — Plan 2');
  assert.equal(localizeDocumentName('Hall'), 'Hall');

  setLocale('ru');
  assert.equal(localizeDocumentName('sample.room.master'), 'Главная спальня');
  assert.equal(localizeDocumentName('SAMPLE.LEVEL.GROUND — PLAN'), 'Первый этаж — План');
  setLocale('en');
});
