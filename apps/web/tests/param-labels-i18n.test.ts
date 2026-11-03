// Every English parameter label emitted by apex-core has RU+EN catalog entries
// (UI-side mapping in src/ui/paramLabels.ts), plus view-cube face captions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { en } from '../src/i18n/catalogs/en.ts';
import { ru } from '../src/i18n/catalogs/ru.ts';

const slug = (label: string) =>
  `param.label.${label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`;

function rustFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? rustFiles(p) : p.endsWith('.rs') ? [p] : [];
  });
}

test('core param labels are localized in EN and RU', () => {
  const labels = new Set<string>();
  const spec = /ParamSpec::(?:length|flag|number|angle|choice|text|profile|reference)\(\s*"[^"]+",\s*"([^"]+)"/g;
  const field = /label: "([^"]+)"\.(?:to_string|into)\(\)/g;
  for (const file of rustFiles(new URL('../../../crates/apex-core/src', import.meta.url).pathname)) {
    if (file.includes('/tests')) continue;
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(spec)) labels.add(m[1]);
    for (const m of src.matchAll(field)) labels.add(m[1]);
  }
  assert.ok(labels.size > 20);
  for (const label of labels) {
    const key = slug(label);
    assert.ok(en[key], `en missing ${key} (${label})`);
    assert.ok(ru[key], `ru missing ${key} (${label})`);
  }
});

test('view cube faces are localized', () => {
  for (const f of ['front', 'back', 'left', 'right', 'top', 'bottom']) {
    assert.ok(en[`viewCube.${f}`] && ru[`viewCube.${f}`], f);
  }
});
