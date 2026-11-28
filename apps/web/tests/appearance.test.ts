import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appearanceRgb, planWashByPick } from '../src/viewport/appearance.ts';

test('site surfaces and the shell use distinct fill colours', () => {
  const lawn = appearanceRgb({ component_id: 'apex.site_surface', category: 'site', surface_kind: 'lawn' });
  const path = appearanceRgb({ component_id: 'apex.site_surface', category: 'site', surface_kind: 'path' });
  const gravel = appearanceRgb({ component_id: 'apex.site_surface', category: 'site', surface_kind: 'gravel' });
  const drive = appearanceRgb({ component_id: 'apex.site_surface', category: 'site', surface_kind: 'driveway' });
  const paved = appearanceRgb({ component_id: 'apex.site_surface', category: 'site', surface_kind: 'paved' });
  const soil = appearanceRgb({ component_id: 'apex.terrain', category: 'topo' });
  const wall = appearanceRgb({ component_id: 'apex.wall', category: 'wall' });
  const frame = appearanceRgb({ component_id: 'apex.window', category: 'opening' });
  const roof = appearanceRgb({ component_id: 'apex.roof', category: 'roof' });
  const colors = [lawn, path, gravel, drive, paved, soil, wall, frame, roof];
  const keys = colors.map((rgb) => rgb.join(','));
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(lawn[1] > lawn[0] && lawn[1] > lawn[2], 'lawn is green');
  assert.ok(path[0] > path[1] && path[0] > 0.5, 'path is dirt');
  assert.ok(gravel[0] > 0.55 && gravel[1] > 0.55 && gravel[2] > 0.5, 'gravel is pale stone');
  assert.ok(drive[0] < 0.35 && drive[1] < 0.35, 'driveway is dark');
  assert.ok(wall[0] > 0.85, 'walls are light');
  assert.ok(roof[1] > roof[0] && roof[1] > 0.4, 'roof is green');
  assert.ok(frame[0] < 0.25, 'window frames are dark');
  const wash = planWashByPick([
    { pick_id: 1, component_id: 'apex.slab' },
    { pick_id: 2, component_id: 'apex.site_surface' },
    { pick_id: 3, component_id: 'apex.terrain' },
    { pick_id: 4, component_id: 'apex.wall' },
  ] as never);
  assert.equal(wash.has(1), false);
  assert.equal(wash.get(2), 0.85);
  assert.equal(wash.get(3), 0.85);
  assert.equal(wash.has(4), false);
});
