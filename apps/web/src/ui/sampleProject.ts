import {
  apexCreateElement,
  apexCreateElementWithParent,
  apexCreateGridAxis,
  apexCreateReference,
  apexGetScene,
  apexListElements,
  apexNewProject,
  apexSetActiveLevel,
} from "../wasm/apex";
import type { SceneDto } from "../types";
import type { ParamValue } from "../types";

const wallParams: Record<string, ParamValue> = {
  profile: "apex.wall.rect",
  height: 3,
};

const slabParams: Record<string, ParamValue> = {
  thickness: 0.2,
};

/**
 * Small demo: a 6×5 m room split by an interior wall (T joins), with doors,
 * windows, a free-standing column, a stair, a slab, a grid axis and a
 * reference plane, so every plan symbol and boolean has something to act on.
 */
export function buildSampleProject(): SceneDto {
  let scene = apexNewProject();
  const levelId = scene.active_level_id ?? scene.levels[0]?.id ?? null;
  if (levelId) scene = apexSetActiveLevel(levelId);

  const y = scene.levels.find((l) => l.id === levelId)?.elevation ?? 0;
  const xz = (x: number, zVal: number): [number, number, number] => [
    x,
    y,
    zVal,
  ];

  scene = apexCreateElement(
    "apex.wall",
    [xz(0, 0), xz(6, 0)],
    wallParams,
    0,
    "two_point",
  );
  scene = apexCreateElement(
    "apex.wall",
    [xz(6, 0), xz(6, 5)],
    wallParams,
    0,
    "two_point",
  );
  scene = apexCreateElement(
    "apex.wall",
    [xz(6, 5), xz(0, 5)],
    wallParams,
    0,
    "two_point",
  );
  scene = apexCreateElement(
    "apex.wall",
    [xz(0, 5), xz(0, 0)],
    wallParams,
    0,
    "two_point",
  );

  scene = apexCreateElement(
    "apex.wall",
    [xz(3.5, 0), xz(3.5, 5)],
    wallParams,
    0,
    "two_point",
  );
  const wallAt = (x: number, zVal: number) =>
    apexListElements().find((e) => {
      if (e.category !== "wall" || e.anchors.length < 2) return false;
      const [a, b] = e.anchors;
      const inside =
        x >= Math.min(a[0], b[0]) - 1e-6 &&
        x <= Math.max(a[0], b[0]) + 1e-6 &&
        zVal >= Math.min(a[2], b[2]) - 1e-6 &&
        zVal <= Math.max(a[2], b[2]) + 1e-6;
      if (!inside) return false;
      const cross = (b[0] - a[0]) * (zVal - a[2]) - (b[2] - a[2]) * (x - a[0]);
      return Math.abs(cross) < 1e-6;
    })?.id;
  const south = wallAt(2, 0);
  const east = wallAt(6, 2.5);
  const north = wallAt(2, 5);
  const interior = wallAt(3.5, 2);
  if (south)
    scene = apexCreateElementWithParent(
      "apex.door",
      [xz(1.6, 0)],
      south,
      {},
      0,
      "point",
    );
  if (interior)
    scene = apexCreateElementWithParent(
      "apex.door",
      [xz(3.5, 3.8)],
      interior,
      {},
      0,
      "point",
    );
  if (east)
    scene = apexCreateElementWithParent(
      "apex.window",
      [xz(6, 2.5)],
      east,
      {},
      0,
      "point",
    );
  if (north)
    scene = apexCreateElementWithParent(
      "apex.window",
      [xz(1.75, 5)],
      north,
      {},
      0,
      "point",
    );
  scene = apexCreateElement("apex.column", [xz(2, 2.5)], {}, 0, "point");
  scene = apexCreateElement(
    "apex.stair",
    [xz(5.2, 0.6), xz(5.2, 4.2)],
    { width: 1.0, height: 3 },
    0,
    "two_point",
  );

  scene = apexCreateElement(
    "apex.slab",
    [xz(0, 0), xz(6, 0), xz(6, 5), xz(0, 5)],
    slabParams,
    0,
    "polyline",
  );

  scene = apexCreateGridAxis([xz(0, -1), xz(0, 6)]);
  scene = apexCreateReference("plane", [xz(1, 0), xz(5, 0)]);

  return apexGetScene();
}
