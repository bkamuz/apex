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

test('thin-lines toolbar strings exist in EN and RU', () => {
  for (const k of ['toolbar.lines', 'toolbar.thinLines', 'toolbar.thinLinesTitle'] as const) {
    assert.ok((en as Record<string, string>)[k]);
    assert.ok((ru as Record<string, string>)[k]);
    assert.notEqual((en as Record<string, string>)[k], (ru as Record<string, string>)[k]);
  }
});

test('theme strings exist in EN and RU', () => {
  for (const k of [
    'chrome.theme',
    'chrome.theme.system',
    'chrome.theme.light',
    'chrome.theme.dark',
  ]) {
    assert.ok((en as Record<string, string>)[k], k);
    assert.ok((ru as Record<string, string>)[k], k);
    assert.notEqual((en as Record<string, string>)[k], (ru as Record<string, string>)[k]);
  }
});

test('old theme-button strings are gone', () => {
  for (const k of ['toolbar.theme', 'toolbar.themeToLight', 'toolbar.themeToDark', 'toolbar.themeTitle']) {
    assert.equal((en as Record<string, string>)[k], undefined, k);
    assert.equal((ru as Record<string, string>)[k], undefined, k);
  }
});

test('ribbon, context bar and palette strings exist in EN and RU', () => {
  const keys = Object.keys(en).filter((k) => /^(ribbon|ctx|palette|cmd)\./.test(k));
  assert.ok(keys.length > 30, String(keys.length));
  for (const k of keys) {
    assert.ok((ru as Record<string, string>)[k], k);
  }
  for (const k of [...Object.keys(en), ...Object.keys(ru)]) {
    const v = ((en as Record<string, string>)[k] ?? '') + ((ru as Record<string, string>)[k] ?? '');
    if (/^(ribbon|ctx|palette|cmd)\./.test(k)) assert.ok(!/famil/i.test(v), k);
  }
});

/** Ribbon, palette, and editor tool chrome — both locales, same keys, no family wording. */
const TOOL_LABEL_KEY = /^(tool\.|tab\.|ribbon\.|palette\.|cmd\.|mode\.|toolbar\.(view|plan|fit|axon|persp|thin|lines)|genusEditor\.(tool|group|tab|layout|show)\.|component\.apex\.)/;

test('RU and EN tool label key sets match', () => {
  const enKeys = Object.keys(en).filter((k) => TOOL_LABEL_KEY.test(k)).sort();
  const ruKeys = Object.keys(ru).filter((k) => TOOL_LABEL_KEY.test(k)).sort();
  assert.deepEqual(ruKeys, enKeys);
  assert.ok(enKeys.length > 80, String(enKeys.length));
  const sharedOk = new Set(['3D', 'IFC', 'DXF']);
  for (const k of enKeys) {
    const ev = en[k];
    const rv = ru[k];
    assert.ok(ev.trim(), `empty en ${k}`);
    assert.ok(rv.trim(), `empty ru ${k}`);
    const blob = `${ev} ${rv}`;
    assert.ok(!/famil/i.test(blob), k);
    assert.ok(!/семейств/i.test(blob), k);
    assert.ok(!/Построительн|Аксои|Ящик/.test(rv), k);
    if (ev === rv && !sharedOk.has(ev)) assert.fail(`${k} is identical in EN and RU: ${ev}`);
  }
});

test('browser kind badges and view labels are translated in RU', () => {
  for (const k of ['browser.badge.instance', 'browser.badge.type', 'browser.badge.space', 'viewTab.saveView', 'viewTab.export', 'viewKind.plan', 'viewName.threeD', 'component.apex.roof.pitched']) {
    assert.ok(en[k] && ru[k], k);
    assert.notEqual(ru[k], en[k], k);
  }
});
