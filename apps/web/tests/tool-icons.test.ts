// Poché icon set: every catalog name ships at 16/24/32, two tones of currentColor only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GENUS_ICON_ALIAS, GENUS_ICON_SVG, TOOL_ICON_SIZES, TOOL_ICON_SVG } from '../src/tools/iconCatalog.generated.ts';

const iconsSrc = readFileSync(new URL('../src/tools/icons.ts', import.meta.url), 'utf8');
const catalog = iconsSrc.slice(iconsSrc.indexOf('export const TOOL_ICONS'), iconsSrc.indexOf('} as const;'));
const names = [...catalog.matchAll(/:\s*'([a-z0-9-]+)'/g)].map((m) => m[1]);

test('every TOOL_ICONS name has a glyph at every size', () => {
  assert.ok(names.length >= 40);
  for (const size of TOOL_ICON_SIZES) {
    const missing = names.filter((n) => !TOOL_ICON_SVG[size][n]);
    assert.deepEqual(missing, [], `size ${size}`);
  }
});

test('genus editor aliases point at shipped main glyphs', () => {
  for (const [id, main] of Object.entries(GENUS_ICON_ALIAS)) {
    assert.ok(TOOL_ICON_SVG[24][main], `${id} → ${main}`);
    assert.equal(GENUS_ICON_SVG[24][id], undefined, `${id} is aliased, not duplicated`);
  }
});

test('glyphs use currentColor; #000/#fff only inside masks', () => {
  const all = TOOL_ICON_SIZES.flatMap((s) => [...Object.values(TOOL_ICON_SVG[s]), ...Object.values(GENUS_ICON_SVG[s])]);
  for (const svg of all) {
    const outside = svg.replace(/<mask[\s\S]*?<\/mask>/g, '');
    const colours = [...outside.matchAll(/(?:fill|stroke)="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(colours.filter((c) => c !== 'currentColor' && c !== 'none'), []);
  }
});
