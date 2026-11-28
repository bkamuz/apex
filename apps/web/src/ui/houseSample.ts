import {
  apexCreateElement,
  apexCreateElementWithParent,
  apexCreateGridAxis,
  apexCreateLevel,
  apexCreatePlanView,
  apexDetectRoomsFromWalls,
  apexGetScene,
  apexGetSelected,
  apexListElements,
  apexNewProject,
  apexRenameLevel,
  apexRenameSpace,
  apexRenameView,
  apexSelectElement,
  apexSetActiveLevel,
  apexSetSlabShape,
} from "../wasm/apex";
import type { SceneDto, SlabShapeDto, Vec3, ViewKindDto } from "../types";
import type { ParamValue } from "../types";

/**
 * Contemporary two-storey house.
 *
 * Ground: solid west/north service bar (hall, stair, utility, WC, study) and a
 * glazed living / kitchen / dining pavilion to the south-east.
 * Upper: bedrooms and baths on a bar that cantilevers 2 m south over the
 * terrace, stopped short of the pavilion so that wing stays single-storey
 * under its own flat roof. Slim round columns carry the cantilever.
 * Site: graded terrain (flat pad, rise to the north), fence and gates,
 * draped lawn and garden paths over most of the yard, a flat paved
 * terrace and walk, and a flat driveway.
 *
 * Room and level names are catalog keys (`sample.*`) so the plan follows
 * the active locale. Same centreline geometry as house-e2e / house-mcp.
 */

const GROUND = 0;
const UPPER = 3.05;
const ROOF_Y = 6;
const EXT = 0.3;
const INT = 0.12;

type XZ = [number, number];
type Seg = [XZ, XZ];

const G_EXT: Seg[] = [
  [[0, 0], [4, 0]],
  [[4, 0], [14, 0]],
  [[14, 0], [14, 7]],
  [[14, 7], [10, 7]],
  [[10, 7], [10, 11]],
  [[10, 11], [7, 11]],
  [[7, 11], [4, 11]],
  [[4, 11], [0, 11]],
  [[0, 11], [0, 8]],
  [[0, 8], [0, 3]],
  [[0, 3], [0, 0]],
];

const G_INT: Seg[] = [
  [[4, 0], [4, 3]],
  [[4, 3], [4, 7]],
  [[4, 7], [4, 8]],
  [[4, 8], [4, 11]],
  [[0, 3], [4, 3]],
  [[0, 8], [4, 8]],
  [[4, 7], [7, 7]],
  [[7, 7], [10, 7]],
  [[7, 7], [7, 11]],
];

const U_EXT: Seg[] = [
  [[0, -2], [4, -2]],
  [[4, -2], [7, -2]],
  [[7, -2], [10, -2]],
  [[10, -2], [10, 8]],
  [[10, 8], [10, 11]],
  [[10, 11], [7, 11]],
  [[7, 11], [4, 11]],
  [[4, 11], [0, 11]],
  [[0, 11], [0, 3]],
  [[0, 3], [0, -2]],
];

const U_INT: Seg[] = [
  [[4, -2], [4, 3]],
  [[4, 3], [4, 8]],
  [[4, 8], [4, 11]],
  [[7, -2], [7, 3]],
  [[7, 3], [7, 8]],
  [[7, 8], [7, 11]],
  [[0, 3], [4, 3]],
  [[4, 3], [7, 3]],
  [[4, 8], [7, 8]],
  [[7, 8], [10, 8]],
];

/** Grid: 1–5 east, A–F north (cantilever, south facade, partitions). */
const AX = [0, 4, 7, 10, 14] as const;
const AZ = [-2, 0, 3, 7, 8, 11] as const;

const ROOMS_GROUND: Array<[string, number, number]> = [
  ["sample.room.hall", 2, 1.5],
  ["sample.room.stair", 2, 6],
  ["sample.room.utility", 2, 9.5],
  ["sample.room.wc", 5.5, 9],
  ["sample.room.study", 8.5, 9],
  ["sample.room.living", 9, 3.5],
];

const ROOMS_UPPER: Array<[string, number, number]> = [
  ["sample.room.bed2", 2, 0.5],
  ["sample.room.bed3", 5.5, 0.5],
  ["sample.room.master", 8.5, 2],
  ["sample.room.stair", 2, 7],
  ["sample.room.upperHall", 5.5, 5.5],
  ["sample.room.bath", 5.5, 9.5],
  ["sample.room.ensuite", 8.5, 9.5],
];

function xz(x: number, z: number, y: number): Vec3 {
  return [x, y, z];
}

function lastId(componentId: string): string | undefined {
  const hits = apexListElements().filter((e) => e.component_id === componentId);
  return hits[hits.length - 1]?.id;
}

function pathHostAt(x: number, z: number, category: string): string | undefined {
  const levelId = apexGetScene().active_level_id;
  for (const e of apexListElements()) {
    if (e.category !== category) continue;
    if (levelId && e.level_id !== levelId && e.effective_level_id !== levelId) {
      continue;
    }
    apexSelectElement(e.id);
    const pts = apexGetSelected()?.anchors ?? [];
    for (let i = 0; i + 1 < pts.length; i += 1) {
      const [ax, , az] = pts[i];
      const [bx, , bz] = pts[i + 1];
      const cross = (bx - ax) * (z - az) - (bz - az) * (x - ax);
      const within =
        Math.min(ax, bx) - 1e-3 <= x &&
        x <= Math.max(ax, bx) + 1e-3 &&
        Math.min(az, bz) - 1e-3 <= z &&
        z <= Math.max(az, bz) + 1e-3;
      if (Math.abs(cross) < 1e-3 && within) {
        apexSelectElement(null);
        return e.id;
      }
    }
  }
  apexSelectElement(null);
  return undefined;
}

function pointInPolygon(x: number, z: number, poly: Vec3[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, , zi] = poly[i];
    const [xj, , zj] = poly[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function planLevelId(kind: ViewKindDto): string | null {
  switch (kind.kind) {
    case "plan":
      return kind.level_id;
    case "three_d":
    case "section":
      return null;
    default: {
      const neverKind: never = kind;
      return neverKind;
    }
  }
}

function wall(a: XZ, b: XZ, thickness: number, elev: number): void {
  apexCreateElement(
    "apex.wall",
    [xz(a[0], a[1], elev), xz(b[0], b[1], elev)],
    { thickness },
    0,
    "two_point",
  );
}

function walls(segs: Seg[], thickness: number, elev: number): void {
  for (const [a, b] of segs) wall(a, b, thickness, elev);
}

interface Opening {
  kind: "apex.door" | "apex.window";
  at: XZ;
  params: Record<string, ParamValue>;
}

function glazing(
  width: number,
  height: number,
  sill: number,
  columns = 1,
): Record<string, ParamValue> {
  return {
    width,
    height,
    sill,
    columns,
    sash_width: columns > 1 ? 0.04 : 0,
    mullion_width: 0.05,
    frame_width: 0.05,
  };
}

function doorParams(width: number, height = 2.1, columns = 1): Record<string, ParamValue> {
  return {
    width,
    height,
    sill: 0,
    columns,
    mullion_width: 0.02,
    frame_width: 0.06,
  };
}

function placeOpenings(items: Opening[], elev: number): void {
  for (const item of items) {
    const [x, z] = item.at;
    const host = pathHostAt(x, z, "wall");
    if (!host) {
      throw new Error(`houseSample: no wall at (${x}, ${z})`);
    }
    apexCreateElementWithParent(
      item.kind,
      [xz(x, z, elev)],
      host,
      item.params,
      0,
      "point",
    );
  }
}

function poly(id: string, ring: XZ[], elev: number, params: Record<string, ParamValue>): string {
  apexCreateElement(
    id,
    ring.map(([x, z]) => xz(x, z, elev)),
    params,
    0,
    "polyline",
  );
  const created = lastId(id);
  if (!created) throw new Error(`houseSample: ${id} create failed`);
  return created;
}

function lift(id: string, corners: number, offset: number): void {
  const shape: SlabShapeDto = {
    z: Array.from({ length: corners }, () => offset),
    points: [],
    creases: [],
  };
  apexSetSlabShape(id, shape);
}

function renamePlan(levelId: string, key: string): void {
  const scene = apexGetScene();
  const view = (scene.views ?? []).find((v) => planLevelId(v.kind) === levelId);
  if (view) apexRenameView(view.id, `${key} — Plan`);
}

const GROUND_OPENINGS: Opening[] = [
  { kind: "apex.door", at: [2, 0], params: doorParams(1.2, 2.4) },
  { kind: "apex.window", at: [3.3, 0], params: glazing(0.7, 2.4, 0) },
  { kind: "apex.window", at: [6.3, 0], params: glazing(2.6, 2.6, 0, 2) },
  { kind: "apex.window", at: [9.2, 0], params: glazing(2.4, 2.6, 0, 2) },
  { kind: "apex.door", at: [11.6, 0], params: doorParams(1.6, 2.4, 2) },
  { kind: "apex.window", at: [13.2, 0], params: glazing(1.2, 2.6, 0) },
  { kind: "apex.window", at: [14, 2.2], params: glazing(2.6, 2.6, 0, 2) },
  { kind: "apex.window", at: [14, 5.2], params: glazing(2.4, 2.6, 0, 2) },
  { kind: "apex.window", at: [12, 7], params: glazing(2.2, 2.2, 0.15, 2) },
  { kind: "apex.window", at: [8.5, 11], params: glazing(1.8, 1.5, 0.9) },
  { kind: "apex.window", at: [5.5, 11], params: glazing(1.2, 1.0, 1.45) },
  { kind: "apex.window", at: [2, 11], params: glazing(1.6, 1.2, 1.3) },
  { kind: "apex.window", at: [0, 9.5], params: glazing(1.2, 1.1, 1.3) },
  { kind: "apex.window", at: [0, 5.5], params: glazing(0.6, 1.8, 1.0) },
  { kind: "apex.window", at: [0, 1.5], params: glazing(1.4, 1.5, 0.9) },
  { kind: "apex.door", at: [4, 1.6], params: doorParams(0.95) },
  { kind: "apex.door", at: [2, 3], params: doorParams(0.9) },
  { kind: "apex.door", at: [2, 8], params: doorParams(0.85) },
  { kind: "apex.door", at: [5.5, 7], params: doorParams(0.8) },
  { kind: "apex.door", at: [8.5, 7], params: doorParams(0.9) },
];

const UPPER_OPENINGS: Opening[] = [
  { kind: "apex.window", at: [2, -2], params: glazing(2.6, 2.4, 0, 2) },
  { kind: "apex.window", at: [5.5, -2], params: glazing(2.0, 2.4, 0, 2) },
  { kind: "apex.window", at: [8.5, -2], params: glazing(2.0, 2.4, 0, 2) },
  { kind: "apex.window", at: [10, 1], params: glazing(2.4, 2.4, 0, 2) },
  { kind: "apex.window", at: [10, 5], params: glazing(2.2, 2.4, 0, 2) },
  { kind: "apex.window", at: [10, 9.5], params: glazing(1.4, 1.3, 1.05) },
  { kind: "apex.window", at: [0, 0.5], params: glazing(1.8, 2.2, 0.15) },
  { kind: "apex.window", at: [0, 6], params: glazing(0.6, 1.8, 0.85) },
  { kind: "apex.window", at: [2, 11], params: glazing(1.6, 1.2, 1.2) },
  { kind: "apex.window", at: [5.5, 11], params: glazing(1.2, 1.0, 1.4) },
  { kind: "apex.window", at: [8.5, 11], params: glazing(1.4, 1.2, 1.2) },
  { kind: "apex.door", at: [2, 3], params: doorParams(0.9) },
  { kind: "apex.door", at: [5.5, 3], params: doorParams(0.9) },
  { kind: "apex.door", at: [4, 5.5], params: doorParams(0.9) },
  { kind: "apex.door", at: [7, 5.5], params: doorParams(0.9) },
  { kind: "apex.door", at: [5.5, 8], params: doorParams(0.8) },
  { kind: "apex.door", at: [8.5, 8], params: doorParams(0.8) },
];

function buildYard(elev: number): void {
  const terrainId = poly(
    "apex.terrain",
    [
      [-10, -12],
      [24, -12],
      [24, 20],
      [-10, 20],
    ],
    elev,
    {
      // A thin crust: the vertical face is only this deep. Boundary elevations
      // stay at the rim so the side is not a cut wall of (max − min + offset).
      bottom_offset: 0.06,
      elevation: 0,
      contour_interval: 0.1,
      major_contour_interval: 0.4,
      smooth: true,
    },
  );
  apexSetSlabShape(terrainId, {
    z: [0, 0, 0, 0],
    points: [
      [2, 4, 0],
      [8, 4, 0],
      [12, 6, 0],
      [4, 9, 0],
      [-2, 14, 0.55],
      [8, 15.5, 1.2],
      [16, 14, 0.75],
      [8, 18.2, 0.4],
      [18, 6, 0.04],
      [2, -6, 0],
    ],
    creases: [],
  });

  // North–south runs start at the high north end so a level fence
  // stands on that elevation and the posts reach down the slope.
  const fence: Seg[] = [
    [[-6, -8], [20, -8]],
    [[20, 16], [20, -8]],
    [[20, 16], [-6, 16]],
    [[-6, 16], [-6, -8]],
  ];
  const fenceParams = { species: "apex.site_line.fence" };
  for (const [a, b] of fence) {
    apexCreateElement(
      "apex.site_line",
      [xz(a[0], a[1], elev), xz(b[0], b[1], elev)],
      fenceParams,
      0,
      "two_point",
    );
  }
  const curb = { species: "apex.site_line.curb" };
  poly(
    "apex.site_line",
    [
      [7.4, 11.45],
      [8.5, 11.45],
      [8.5, 13.2],
      [16.6, 14.7],
    ],
    elev,
    curb,
  );
  poly(
    "apex.site_line",
    [
      [7.4, 14.05],
      [15.7, 15.55],
      [16.6, 15.55],
    ],
    elev,
    curb,
  );
  const pedestrian = pathHostAt(2, -8, "site_line");
  if (pedestrian) {
    apexCreateElementWithParent(
      "apex.gate",
      [xz(2, -8, elev)],
      pedestrian,
      { width: 1.2, height: 1.5 },
      0,
      "point",
    );
  }
  const vehicle = pathHostAt(20, 3, "site_line");
  if (vehicle) {
    apexCreateElementWithParent(
      "apex.gate",
      [xz(20, 3, elev)],
      vehicle,
      { width: 3.2, height: 1.5 },
      0,
      "point",
    );
  }

  const lawn = { thickness: 0.05, surface_kind: "lawn", placement_mode: "draped" };
  const path = { thickness: 0.03, surface_kind: "path", placement_mode: "draped" };
  const gravel = { thickness: 0.04, surface_kind: "gravel", placement_mode: "draped" };
  const paved = { thickness: 0.08, surface_kind: "paved", placement_mode: "flat" };
  const drive = { thickness: 0.1, surface_kind: "driveway", placement_mode: "flat" };
  // Free yard inside the fence, held back from wall centrelines. Soft
  // surfaces drape on the terrain; the terrace, walk and driveway stay level.
  const yards: Array<[XZ[], Record<string, ParamValue>]> = [
    [[[-5.8, -7.8], [-0.25, -7.8], [-0.25, 15.8], [-5.8, 15.8]], lawn],
    [[[-0.25, 11.25], [19.8, 11.25], [19.8, 15.8], [-0.25, 15.8]], lawn],
    [[[10.25, 7.25], [14.25, 7.25], [14.25, 11.25], [10.25, 11.25]], lawn],
    [[[14.25, 6.7], [19.8, 6.7], [19.8, 11.25], [14.25, 11.25]], lawn],
    [[[14.4, -7.8], [19.8, -7.8], [19.8, -0.5], [14.4, -0.5]], lawn],
    [[[3.05, -7.8], [14.05, -7.8], [14.05, -4.95], [3.05, -4.95]], lawn],
    [[[-0.25, -7.8], [1.15, -7.8], [1.15, -0.25], [-0.25, -0.25]], lawn],
    [[[3.05, -4.95], [4.05, -4.95], [4.05, -0.25], [3.05, -0.25]], lawn],
    [
      [
        [7.4, 11.45],
        [8.5, 11.45],
        [8.5, 13.2],
        [16.6, 14.7],
        [16.6, 15.55],
        [15.7, 15.55],
        [7.4, 14.05],
      ],
      path,
    ],
    [[[1.1, 12.3], [6.2, 12.3], [6.2, 14.6], [1.1, 14.6]], gravel],
    [[[4.2, -4.8], [14.2, -4.8], [14.2, -0.25], [4.2, -0.25]], paved],
    [[[1.3, -7.6], [2.9, -7.6], [2.9, -0.2], [1.3, -0.2]], paved],
    [[[14.2, -0.3], [19.5, -0.3], [19.5, 6.5], [14.2, 6.5]], drive],
  ];
  for (const [ring, params] of yards) poly("apex.site_surface", ring, elev, params);
}

function renameRooms(levelId: string, names: Array<[string, number, number]>): void {
  const scene = apexGetScene();
  const spaces = (scene.spaces ?? []).filter((s) => s.level_id === levelId);
  for (const [name, x, z] of names) {
    const hit = spaces.find((s) => pointInPolygon(x, z, s.anchors));
    if (hit) apexRenameSpace(hit.id, name);
  }
}

function column(x: number, z: number, height: number): void {
  apexCreateElement(
    "apex.column",
    [xz(x, z, GROUND)],
    { profile: "apex.round", width: 0.22, height },
    0,
    "point",
  );
}

/**
 * Build the sample and return the scene. Levels: ground, upper, roof.
 */
export function buildHouseSampleProject(): SceneDto {
  apexNewProject();
  let scene = apexGetScene();
  const l0 = scene.active_level_id ?? scene.levels[0]?.id;
  if (!l0) return scene;

  apexRenameLevel(l0, "sample.level.ground");
  renamePlan(l0, "sample.level.ground");

  // Axes belong to the ground storey. Plan export draws only the view's level,
  // and create_grid_axis uses whichever level is active.
  for (let i = 0; i < AX.length; i += 1) {
    const x = AX[i];
    apexCreateGridAxis([xz(x, -6, 0), xz(x, 14, 0)], { label: String(i + 1) });
  }
  for (let i = 0; i < AZ.length; i += 1) {
    const z = AZ[i];
    apexCreateGridAxis([xz(-4, z, 0), xz(18, z, 0)], { label: "ABCDEF"[i] ?? "" });
  }

  scene = apexCreateLevel("sample.level.upper", UPPER);
  const l1 = scene.levels.find((l) => Math.abs(l.elevation - UPPER) < 1e-4)?.id;
  scene = apexCreateLevel("sample.level.roof", ROOF_Y);
  const lRoof = scene.levels.find((l) => Math.abs(l.elevation - ROOF_Y) < 1e-4)?.id;
  if (!l1 || !lRoof) return apexGetScene();

  apexSetActiveLevel(l1);
  apexCreatePlanView(l1);
  renamePlan(l1, "sample.level.upper");

  apexSetActiveLevel(l0);
  walls(G_EXT, EXT, GROUND);
  walls(G_INT, INT, GROUND);
  placeOpenings(GROUND_OPENINGS, GROUND);
  poly(
    "apex.slab",
    [[0, 0], [14, 0], [14, 7], [10, 7], [10, 11], [0, 11]],
    GROUND,
    { thickness: 0.22 },
  );
  buildYard(GROUND);
  for (const x of [2, 5.5, 8.5]) column(x, -2, UPPER);

  apexSetActiveLevel(l1);
  walls(U_EXT, EXT, UPPER);
  walls(U_INT, INT, UPPER);
  placeOpenings(UPPER_OPENINGS, UPPER);
  poly(
    "apex.slab",
    [[0, -2], [10, -2], [10, 11], [0, 11]],
    UPPER,
    { thickness: 0.22 },
  );

  apexSetActiveLevel(l0);
  apexCreateElement(
    "apex.stair",
    [xz(1.15, 4.25, GROUND), xz(1.15, 7.75, GROUND)],
    { width: 1.05, height: UPPER },
    0,
    "two_point",
  );

  apexSetActiveLevel(l1);
  poly(
    "apex.roof",
    [[10, -0.15], [14.35, -0.15], [14.35, 7.25], [10, 7.25]],
    UPPER,
    { thickness: 0.22 },
  );
  const terraceGarden = poly(
    "apex.site_surface",
    [[10.35, 0.35], [13.9, 0.35], [13.9, 6.7], [10.35, 6.7]],
    UPPER,
    { thickness: 0.05, surface_kind: "lawn", placement_mode: "flat" },
  );
  lift(terraceGarden, 4, 0.28);

  apexSetActiveLevel(lRoof);
  poly(
    "apex.roof",
    [[-0.3, -2.3], [10.3, -2.3], [10.3, 11.3], [-0.3, 11.3]],
    ROOF_Y,
    { thickness: 0.28 },
  );
  const green = poly(
    "apex.site_surface",
    [[0.45, -1.55], [9.55, -1.55], [9.55, 10.55], [0.45, 10.55]],
    ROOF_Y,
    { thickness: 0.06, surface_kind: "lawn", placement_mode: "flat" },
  );
  lift(green, 4, 0.34);

  for (const levelId of [l0, l1]) {
    apexSetActiveLevel(levelId);
    apexDetectRoomsFromWalls();
  }
  renameRooms(l0, ROOMS_GROUND);
  renameRooms(l1, ROOMS_UPPER);

  apexSetActiveLevel(l0);
  apexSelectElement(null);
  return apexGetScene();
}
