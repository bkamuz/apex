import assert from 'node:assert/strict';
import test from 'node:test';

import type { ComponentDto, ParamValue } from '../src/types.ts';
import { placementDraftFor } from '../src/ui/placementDraft.ts';
import { defaultPlacementParams, syncSitePlacement } from '../src/ui/profileModel.ts';

const site = {
  id: 'apex.site_surface',
  display_name: 'Site surface',
  category: 'site',
  source: 'built_in',
  placement: 'polyline',
  params: [
    { id: 'surface_kind', label: 'Surface', kind: 'choice', default: 'lawn', options: ['lawn', 'path', 'gravel', 'paved', 'driveway'] },
    { id: 'placement_mode', label: 'Placement', kind: 'choice', default: 'draped', options: ['draped', 'flat'] },
    { id: 'thickness', label: 'Thickness', kind: 'length', default: 0.05 },
  ],
  recipe: { kind: 'extrude' },
} as ComponentDto;

test('choosing paving or a driveway leaves the draft flat', () => {
  const draft = defaultPlacementParams(site, []);
  assert.equal(draft.surface_kind, 'lawn');
  assert.equal(draft.placement_mode, 'draped');

  const paved = syncSitePlacement(draft, { ...draft, surface_kind: 'paved' });
  assert.equal(paved.placement_mode, 'flat');
  const drive = syncSitePlacement(paved, { ...paved, surface_kind: 'driveway' });
  assert.equal(drive.placement_mode, 'flat');
  const lawn = syncSitePlacement(drive, { ...drive, surface_kind: 'lawn' });
  assert.equal(lawn.placement_mode, 'draped');
  const path = syncSitePlacement(lawn, { ...lawn, surface_kind: 'path' });
  assert.equal(path.placement_mode, 'draped');
});

test('an explicit placement survives a kind change', () => {
  const drapedDrive: Record<string, ParamValue> = {
    surface_kind: 'driveway',
    placement_mode: 'draped',
    thickness: 0.1,
  };
  const paved = syncSitePlacement(drapedDrive, { ...drapedDrive, surface_kind: 'paved' });
  assert.equal(paved.placement_mode, 'draped');

  const flatLawn: Record<string, ParamValue> = {
    surface_kind: 'lawn',
    placement_mode: 'flat',
    thickness: 0.05,
  };
  const gravel = syncSitePlacement(flatLawn, { ...flatLawn, surface_kind: 'gravel' });
  assert.equal(gravel.placement_mode, 'flat');
});

test('a curb species overrides the fence defaults in the placement draft', () => {
  const line = {
    id: 'apex.site_line',
    display_name: 'Site line',
    category: 'site_line',
    source: 'built_in',
    placement: 'path',
    default_species: 'apex.site_line.fence',
    params: [
      { id: 'species', label: 'Species', kind: 'text', default: 'apex.site_line.fence' },
      { id: 'seating', label: 'Seating', kind: 'choice', binding: 'type', default: 'level_from_start', options: ['by_ends', 'level_from_start'] },
      { id: 'content', label: 'Content', kind: 'choice', binding: 'type', default: 'repeated', options: ['repeated', 'profile'] },
      { id: 'elevation_offset', label: 'Elevation offset', kind: 'length', binding: 'type', default: 0 },
      { id: 'profile_height', label: 'Profile height', kind: 'length', binding: 'type', default: 0.15 },
      { id: 'segment_length', label: 'Segment length', kind: 'length', binding: 'type', default: 0 },
    ],
    recipe: { kind: 'custom' },
  } as ComponentDto;
  const draft = placementDraftFor(line, [], 'apex.site_line.curb', [
    {
      id: 'apex.site_line.curb',
      values: {
        seating: 'by_ends',
        content: 'profile',
        elevation_offset: 0.02,
        profile_height: 0.18,
        segment_length: 1,
      },
    },
  ]);
  assert.equal(draft.species, 'apex.site_line.curb');
  assert.equal(draft.seating, 'by_ends');
  assert.equal(draft.content, 'profile');
  assert.equal(draft.elevation_offset, 0.02);
  assert.equal(draft.profile_height, 0.18);
  assert.equal(draft.segment_length, 1);
});

test('thickness edits do not rewrite placement', () => {
  const draft: Record<string, ParamValue> = {
    surface_kind: 'paved',
    placement_mode: 'flat',
    thickness: 0.08,
  };
  const next = syncSitePlacement(draft, { ...draft, thickness: 0.12 });
  assert.equal(next.placement_mode, 'flat');
  assert.equal(next.thickness, 0.12);
});
