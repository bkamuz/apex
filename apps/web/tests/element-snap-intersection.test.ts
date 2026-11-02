// Run: node --experimental-strip-types --test tests/element-snap-intersection.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findElementSnap, intersectSegmentsXz } from '../src/tools/elementSnap.ts';

type V = [number, number, number];
// Plan camera: 100 px per metre, x→screen x, z→screen y.
const ctx = { worldToClient: (p: V): [number, number] => [p[0] * 100, p[2] * 100] };
const seg = (id: string, a: V, b: V) => ({ element_id: id, a, b });
const geom = (segments: any[], points: any[] = []) => ({ points, segments }) as any;
const snap = (g: any, x: number, z: number, tol?: number) =>
  findElementSnap(ctx, x * 100, z * 100, g, [x, 0, z], tol);

test('crossing segments meet at the exact point', () => {
  assert.deepEqual(intersectSegmentsXz([0, 0, 0], [2, 0, 2], [0, 0, 2], [2, 0, 0]), [1, 0, 1]);
});

test('parallel and collinear lines have no crossing', () => {
  assert.equal(intersectSegmentsXz([0, 0, 0], [2, 0, 0], [0, 0, 1], [2, 0, 1]), null);
  assert.equal(intersectSegmentsXz([0, 0, 0], [2, 0, 0], [1, 0, 0], [3, 0, 0]), null);
  const g = geom([seg('a', [0, 0, 0], [4, 0, 0]), seg('b', [0, 0, 0.1], [4, 0, 0.1])]);
  assert.equal(snap(g, 2, 0.05)?.kind, 'edge');
});

test('segments that would cross only when extended do not snap', () => {
  assert.equal(intersectSegmentsXz([0, 0, 0], [1, 0, 0], [2, 0, -1], [2, 0, 1]), null);
});

test('intersection beats single-line nearest', () => {
  const g = geom([seg('grid:A', [0, 0, 2], [10, 0, 2]), seg('grid:1', [3, 0, -5], [3, 0, 5])]);
  // Cursor is 5 px from axis A but 12 px from the crossing.
  const hit = snap(g, 3.11, 2.05);
  assert.equal(hit?.kind, 'intersection');
  assert.deepEqual(hit?.point, [3, 0, 2]);
  assert.deepEqual([hit?.element_id, hit?.other_element_id].sort(), ['grid:1', 'grid:A']);
});

test('tolerance: far from the crossing falls back to edge or nothing', () => {
  const g = geom([seg('h', [0, 0, 2], [10, 0, 2]), seg('v', [3, 0, -5], [3, 0, 5])]);
  assert.equal(snap(g, 3.5, 2.05)?.kind, 'edge'); // 50 px from crossing
  assert.equal(snap(g, 3.08, 2.08, 10)?.kind, 'edge'); // lines 8 px, crossing 11.3 px > tol
});

test('a wall end clearly closer than the crossing still wins', () => {
  const g = geom(
    [seg('h', [0, 0, 0], [10, 0, 0]), seg('v', [5, 0, -5], [5, 0, 5])],
    [{ point: [5.15, 0, 0], kind: 'end', element_id: 'w' }],
  );
  assert.equal(snap(g, 5.15, 0.01)?.kind, 'end');
});
