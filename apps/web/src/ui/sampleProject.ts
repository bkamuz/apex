import {
  apexCreateElement,
  apexCreateGridAxis,
  apexCreateReference,
  apexGetScene,
  apexNewProject,
  apexSetActiveLevel,
} from '../wasm/apex';
import type { SceneDto } from '../types';
import type { ParamValue } from '../types';

const wallParams: Record<string, ParamValue> = {
  profile: 'apex.wall.rect',
  height: 3,
};

const slabParams: Record<string, ParamValue> = {
  thickness: 0.2,
};

/** Small demo: rectangular room, slab, one grid axis, ref plane segment. */
export function buildSampleProject(): SceneDto {
  let scene = apexNewProject();
  const levelId = scene.active_level_id ?? scene.levels[0]?.id ?? null;
  if (levelId) scene = apexSetActiveLevel(levelId);

  const y = scene.levels.find((l) => l.id === levelId)?.elevation ?? 0;
  const xz = (x: number, zVal: number): [number, number, number] => [x, y, zVal];

  scene = apexCreateElement('apex.wall', [xz(0, 0), xz(6, 0)], wallParams, 0, 'two_point');
  scene = apexCreateElement('apex.wall', [xz(6, 0), xz(6, 5)], wallParams, 0, 'two_point');
  scene = apexCreateElement('apex.wall', [xz(6, 5), xz(0, 5)], wallParams, 0, 'two_point');
  scene = apexCreateElement('apex.wall', [xz(0, 5), xz(0, 0)], wallParams, 0, 'two_point');

  scene = apexCreateElement(
    'apex.slab',
    [xz(0, 0), xz(6, 0), xz(6, 5), xz(0, 5)],
    slabParams,
    0,
    'polyline',
  );

  scene = apexCreateGridAxis([xz(0, -1), xz(0, 6)]);
  scene = apexCreateReference('plane', [xz(1, 0), xz(5, 0)]);

  return apexGetScene();
}
