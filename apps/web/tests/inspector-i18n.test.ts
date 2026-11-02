// Every inspector string exists in EN and RU, and every key the inspector uses is defined.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { en } from '../src/i18n/catalogs/en.ts';
import { ru } from '../src/i18n/catalogs/ru.ts';
import { GROUP_ORDER } from '../src/ui/inspector/model.ts';

test('en and ru define the same inspector keys', () => {
  const enKeys = Object.keys(en).filter((k) => k.startsWith('inspector.')).sort();
  const ruKeys = Object.keys(ru).filter((k) => k.startsWith('inspector.')).sort();
  assert.deepEqual(ruKeys, enKeys);
  for (const key of enKeys) assert.ok(ru[key].trim().length > 0, key);
});

test('static keys used by the inspector are defined', () => {
  const files = [
    'src/ui/PropertiesPanel.tsx',
    'src/ui/GenusSpeciesSection.tsx',
    'src/ui/inspector/Section.tsx',
    'src/ui/inspector/ProvenanceBadge.tsx',
  ];
  const used = new Set<string>();
  for (const f of files) {
    for (const m of readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').matchAll(/t\('(inspector\.[\w.]+)'/g)) {
      used.add(m[1]);
    }
  }
  assert.ok(used.size > 20);
  for (const key of used) assert.ok(key in en, `missing en ${key}`);
});

test('dynamic inspector keys (groups, provenance, validation) are defined', () => {
  const keys = [
    ...GROUP_ORDER.map((g) => `inspector.group.${g}`),
    'inspector.group.species',
    ...['instance', 'species', 'genus', 'inherited', 'formula'].flatMap((s) => [
      `inspector.prov.${s}`,
      `inspector.provShort.${s}`,
    ]),
    ...['empty', 'nan', 'min', 'max'].map((r) => `inspector.invalid.${r}`),
  ];
  for (const key of keys) {
    assert.ok(key in en, `en ${key}`);
    assert.ok(key in ru, `ru ${key}`);
  }
});
