import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  filtersFromAccept,
  pathBasename,
} from '../src/desktop/projectIo.ts';

describe('pathBasename', () => {
  it('handles POSIX and Windows separators', () => {
    assert.equal(pathBasename('/tmp/foo/apex-project.json'), 'apex-project.json');
    assert.equal(pathBasename('C:\\Users\\a\\desk\\house.json'), 'house.json');
    assert.equal(pathBasename('alone.json'), 'alone.json');
  });
});

describe('filtersFromAccept', () => {
  it('collects dotted extensions and skips MIME types', () => {
    const filters = filtersFromAccept(['application/json', '.json', '.ifc', 'IFC']);
    assert.equal(filters.length, 1);
    assert.deepEqual(filters[0].extensions.sort(), ['ifc', 'json']);
  });

  it('falls back to json when accept is empty', () => {
    const filters = filtersFromAccept([]);
    assert.deepEqual(filters[0].extensions, ['json']);
  });
});
