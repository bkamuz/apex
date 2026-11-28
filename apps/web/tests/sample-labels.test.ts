import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { en } from '../src/i18n/catalogs/en.ts';
import { ru } from '../src/i18n/catalogs/ru.ts';
import { instanceDisplayName } from '../src/i18n/display.ts';
import { setLocale } from '../src/i18n/t.ts';
import { localizeDocumentName } from '../src/ui/sampleLabels.ts';
import { viewsByType } from '../src/ui/viewModel.ts';
import type { ViewDto } from '../src/types.ts';

test('sample names and uppercased sheet titles follow the locale', () => {
  setLocale('en');
  assert.equal(localizeDocumentName('sample.room.living'), 'Living, kitchen and dining');
  assert.equal(localizeDocumentName('sample.level.ground — Plan'), 'Ground floor — Plan');
  assert.equal(localizeDocumentName('SAMPLE.LEVEL.GROUND — PLAN'), 'Ground floor — Plan');
  assert.equal(localizeDocumentName('SAMPLE.LEVEL.UPPER — PLAN 2'), 'Upper floor — Plan 2');
  assert.equal(localizeDocumentName('Hall'), 'Hall');

  setLocale('ru');
  assert.equal(localizeDocumentName('sample.room.master'), 'Главная спальня');
  assert.equal(localizeDocumentName('sample.room.upperHall'), 'Холл');
  assert.equal(localizeDocumentName('SAMPLE.LEVEL.GROUND — PLAN'), 'Первый этаж — План');
  setLocale('en');
  assert.equal(localizeDocumentName('sample.room.upperHall'), 'Upper hall');
});

test('every sample.* key used by the house sample has RU and EN text', () => {
  const src = readFileSync(new URL('../src/ui/houseSample.ts', import.meta.url), 'utf8');
  const keys = [...new Set(src.match(/sample(?:\.[a-z0-9_]+)+/gi) ?? [])];
  assert.ok(keys.includes('sample.room.upperHall'), keys.join(','));
  assert.ok(keys.length >= 10, String(keys.length));
  for (const raw of keys) {
    const enKey = Object.keys(en).find((key) => key.toLowerCase() === raw.toLowerCase());
    const ruKey = Object.keys(ru).find((key) => key.toLowerCase() === raw.toLowerCase());
    assert.ok(enKey && en[enKey]?.trim(), `en ${raw}`);
    assert.ok(ruKey && ru[ruKey]?.trim(), `ru ${raw}`);
    assert.notEqual(ru[ruKey!], en[enKey!], raw);
    setLocale('en');
    const shownEn = localizeDocumentName(raw);
    setLocale('ru');
    const shownRu = localizeDocumentName(raw);
    assert.notEqual(shownEn, raw, raw);
    assert.notEqual(shownRu, raw, raw);
    assert.equal(shownEn, en[enKey!]);
    assert.equal(shownRu, ru[ruKey!]);
  }
  setLocale('en');
});

test('default instance names follow the locale without rewriting the stored string', () => {
  setLocale('ru');
  assert.equal(instanceDisplayName('Door 1'), 'Дверь 1');
  assert.equal(instanceDisplayName('Gate 1'), 'Калитка 1');
  assert.equal(instanceDisplayName('Wall 22'), 'Стена 22');
  assert.equal(instanceDisplayName('Terrain 1'), 'Рельеф 1');
  assert.equal(instanceDisplayName('Column 1'), 'Колонна 1');
  assert.equal(instanceDisplayName('Grid 1'), 'Ось 1');
  assert.equal(instanceDisplayName('Ref point 2'), 'Опорная точка 2');
  assert.equal(instanceDisplayName('Level 4'), 'Уровень 4');
  assert.equal(instanceDisplayName('Construction line 2'), 'Вспомогательная линия 2');
  assert.equal(instanceDisplayName('Custom bay 3'), 'Custom bay 3');
  setLocale('en');
  assert.equal(instanceDisplayName('Door 1'), 'Door 1');
  assert.equal(instanceDisplayName('Wall 22'), 'Wall 22');
});

test('view browser folders use the locale, not the English type label', () => {
  const settings = {
    scale: 100,
    category_visible: {},
    detail_level: 'medium' as const,
    edge_style: 'simple' as const,
  };
  const views: ViewDto[] = [
    {
      id: 'p',
      name: 'L1 — Plan',
      type_label: 'Plan',
      kind: { kind: 'plan', level_id: 'l', cut_height: 1, view_range_top: 2, view_range_bottom: 0 },
      settings,
    },
    {
      id: 'd',
      name: '3D View',
      type_label: '3D',
      kind: {
        kind: 'three_d',
        camera: { target: [0, 0, 0], distance: 10, yaw: 0, pitch: 0.4 },
        projection: 'perspective',
      },
      settings,
    },
  ];
  setLocale('ru');
  const groups = viewsByType(views);
  assert.ok(groups['План']?.length === 1);
  assert.equal(groups['Plan'], undefined);
  assert.ok(groups['3D']?.length === 1);
  setLocale('en');
  const enGroups = viewsByType(views);
  assert.ok(enGroups['Plan']?.length === 1);
  assert.equal(enGroups['План'], undefined);
});
