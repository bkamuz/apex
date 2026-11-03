import test from 'node:test';
import assert from 'node:assert/strict';
import { createShortcutMatcher, TWO_LETTER_SHORTCUTS } from '../src/ui/shortcuts.ts';

test('two-letter codes complete inside the window', () => {
  const m = createShortcutMatcher();
  assert.equal(m.feed('w', 0), null);
  assert.equal(m.feed('a', 100), 'tool:place:apex.wall');
  assert.equal(m.feed('t', 200), null);
  assert.equal(m.feed('L', 300), 'action:thin-lines');
});

test('stale first letter does not complete a code', () => {
  const m = createShortcutMatcher();
  m.feed('m', 0);
  assert.equal(m.feed('v', 5000), null);
});

test('overlapping letters: second letter can start a new code', () => {
  const m = createShortcutMatcher();
  m.feed('x', 0);
  assert.equal(m.feed('c', 50), null);
  assert.equal(m.feed('o', 100), 'tool:apex.copy');
});

test('all required codes exist and are unique', () => {
  const codes = TWO_LETTER_SHORTCUTS.map((s) => s.code);
  for (const c of ['WA', 'DR', 'WN', 'SB', 'GR', 'LL', 'MV', 'CO', 'TL']) assert.ok(codes.includes(c), c);
  assert.equal(new Set(codes).size, codes.length);
});
