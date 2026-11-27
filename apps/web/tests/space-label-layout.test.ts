import { test } from 'node:test';
import assert from 'node:assert/strict';
import { separateSpaceLabels, spaceLabelsOverlap, type SpaceLabelBox } from '../src/ui/spaceLabelLayout.ts';

test('Bathroom and Master bathroom tags separate when they share a row', () => {
  const labels: SpaceLabelBox[] = [
    { left: 200, top: 180, text: 'Bathroom', maxWidth: 88 },
    { left: 250, top: 180, text: 'Master bathroom', maxWidth: 88 },
  ];
  assert.equal(spaceLabelsOverlap(labels[0], labels[1]), true);
  separateSpaceLabels(labels);
  assert.equal(spaceLabelsOverlap(labels[0], labels[1]), false);
  assert.ok(Math.abs(labels[0].left - 200) <= 48);
  assert.ok(Math.abs(labels[1].left - 250) <= 48);
});
