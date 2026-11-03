import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clampSidebarWidth,
  matchesBrowserSearch,
  parseSidebarPrefs,
  SIDEBAR_DEFAULT,
} from '../src/ui/sidebarPrefs.ts';

test('sidebar prefs parse and clamp', () => {
  assert.deepEqual(parseSidebarPrefs(null), SIDEBAR_DEFAULT);
  assert.deepEqual(parseSidebarPrefs('{bad'), SIDEBAR_DEFAULT);
  assert.deepEqual(parseSidebarPrefs('{"tab":"genera","collapsed":true,"width":900}'), {
    tab: 'genera',
    collapsed: true,
    width: 480,
  });
  assert.equal(parseSidebarPrefs('{"tab":"nope"}').tab, 'model');
  assert.equal(clampSidebarWidth(10), 200);
});

test('browser search is case/ё-insensitive and needs every word', () => {
  assert.ok(matchesBrowserSearch('стена rect', 'Стена 1', 'Rectangle'));
  assert.ok(matchesBrowserSearch('ЕЛКА', 'Ёлка'));
  assert.ok(!matchesBrowserSearch('стена door', 'Стена 1'));
  assert.ok(matchesBrowserSearch('  ', 'x'));
});
