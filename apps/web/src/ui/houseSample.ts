import {
  apexCommandScene,
  apexCreateElement,
  apexCreateElementWithParent,
  apexCreateGridAxis,
  apexCreateLevel,
  apexDetectRoomsFromWalls,
  apexGetScene,
  apexGetSelected,
  apexListElements,
  apexNewProject,
  apexRenameSpace,
  apexSelectElement,
  apexSetActiveLevel,
  apexSetSlabShape,
} from "../wasm/apex";
import type { SceneDto, Vec3 } from "../types";
import type { ParamValue } from "../types";

const wallParams: Record<string, ParamValue> = {
  profile: "apex.wall.rect",
  height: 3,
};

const slabParams: Record<string, ParamValue> = {
  thickness: 0.2,
};

/** Footprint 10 × 8 m. Axes 1–3 at x = 0/5/10, A–C at z = 0/4/8. */
const AX = [0, 5, 10] as const;
const AZ = [0, 4, 8] as const;

const ROOM_NAMES_L0: Array<[string, number, number]> = [
  ["LIVING", 2.5, 4],
  ["BEDROOM", 7.5, 2],
  ["KITCHEN", 7.5, 6],
];

const ROOM_NAMES_L1: Array<[string, number, number]> = [
  ["HALL / STAIR", 2.5, 4],
  ["BEDROOM 2", 7.5, 2],
  ["BEDROOM 3", 7.5, 6],
];

function xz(x: number, z: number, y: number): Vec3 {
  return [x, y, z];
}

/** Newest element of a component (create order). */
function lastId(componentId: string): string | undefined {
  const hits = apexListElements().filter((e) => e.component_id === componentId);
  return hits[hits.length - 1]?.id;
}

/** Host wall whose centreline contains (x, z) on the active level. */
function wallHostAt(x: number, z: number): string | undefined {
  const levelId = apexGetScene().active_level_id;
  for (const e of apexListElements()) {
    if (e.category !== "wall") continue;
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

/**
 * One storey of the demo house: exterior loop, partition walls, doors,
 * windows, and the main slab. Returns exterior wall ids (loop order).
 */
function buildStorey(
  elev: number,
  opts: { entrance: boolean },
): { exteriorIds: string[] } {
  const loop: Array<[number, number]> = [
    [0, 0],
    [10, 0],
    [10, 8],
    [0, 8],
    [0, 0],
  ];
  const exteriorIds: string[] = [];
  for (let i = 0; i < 4; i += 1) {
    apexCreateElement(
      "apex.wall",
      [xz(loop[i][0], loop[i][1], elev), xz(loop[i + 1][0], loop[i + 1][1], elev)],
      wallParams,
      0,
      "two_point",
    );
    const id = lastId("apex.wall");
    if (id) exteriorIds.push(id);
  }
  apexCreateElement(
    "apex.wall",
    [xz(5, 0, elev), xz(5, 8, elev)],
    wallParams,
    0,
    "two_point",
  );
  apexCreateElement(
    "apex.wall",
    [xz(5, 4, elev), xz(10, 4, elev)],
    wallParams,
    0,
    "two_point",
  );

  const doors: Array<[number, number]> = [
    [5, 2],
    [5, 6],
    ...(opts.entrance ? ([[2, 0]] as Array<[number, number]>) : []),
  ];
  const windows: Array<[number, number]> = [
    [7.5, 0],
    [10, 2],
    [10, 6],
    [7.5, 8],
    [2.5, 8],
    [0, 4],
    ...(opts.entrance ? [] : ([[2, 0]] as Array<[number, number]>)),
  ];
  for (const [x, z] of doors) {
    const host = wallHostAt(x, z);
    if (host) {
      apexCreateElementWithParent(
        "apex.door",
        [xz(x, z, elev)],
        host,
        {},
        0,
        "point",
      );
    }
  }
  for (const [x, z] of windows) {
    const host = wallHostAt(x, z);
    if (host) {
      apexCreateElementWithParent(
        "apex.window",
        [xz(x, z, elev)],
        host,
        {},
        0,
        "point",
      );
    }
  }

  if (opts.entrance) {
    // 45° wall east of the house with a door and a window.
    apexCreateElement(
      "apex.wall",
      [xz(10.8, 0.8, elev), xz(12.8, 2.8, elev)],
      wallParams,
      0,
      "two_point",
    );
    const diag = lastId("apex.wall");
    if (diag) {
      apexCreateElementWithParent(
        "apex.door",
        [xz(11.3, 1.3, elev)],
        diag,
        {},
        0,
        "point",
      );
      apexCreateElementWithParent(
        "apex.window",
        [xz(12.2, 2.2, elev)],
        diag,
        {},
        0,
        "point",
      );
    }
  }

  apexCreateElement(
    "apex.slab",
    [
      xz(0, 0, elev),
      xz(10, 0, elev),
      xz(10, 8, elev),
      xz(0, 8, elev),
    ],
    slabParams,
    0,
    "polyline",
  );

  return { exteriorIds };
}

function renameRoomsOnLevel(
  levelId: string,
  names: Array<[string, number, number]>,
): void {
  const scene = apexGetScene();
  const spaces = (scene.spaces ?? []).filter((s) => s.level_id === levelId);
  for (const [name, x, z] of names) {
    const hit = spaces.find((s) => pointInPolygon(x, z, s.anchors));
    if (hit) apexRenameSpace(hit.id, name);
  }
}

/**
 * Two-storey demo house (10×8 m footprint) with pitched roof, stair,
 * grid axes, and Spaces from wall-loop detect — same construction as
 * `scripts/house-e2e.mjs` / `packages/apex-mcp/scripts/house-mcp.mjs`.
 */
export function buildHouseSampleProject(): SceneDto {
  apexNewProject();
  let scene = apexGetScene();
  const l0 = scene.active_level_id ?? scene.levels[0]?.id;
  if (!l0) return scene;
  apexSetActiveLevel(l0);

  for (let i = 0; i < AX.length; i += 1) {
    const x = AX[i];
    apexCreateGridAxis([xz(x, -2, 0), xz(x, 10, 0)], {
      label: String(i + 1),
    });
  }
  for (let i = 0; i < AZ.length; i += 1) {
    const z = AZ[i];
    apexCreateGridAxis([xz(-2, z, 0), xz(12, z, 0)], {
      label: "ABC"[i] ?? "",
    });
  }

  buildStorey(0, { entrance: true });

  // Ramp slab east of the house; far edge lifted 0.6 m.
  apexCreateElement(
    "apex.slab",
    [xz(11, 4, 0), xz(14, 4, 0), xz(14, 7, 0), xz(11, 7, 0)],
    slabParams,
    0,
    "polyline",
  );
  const rampId = lastId("apex.slab");
  if (rampId) {
    try {
      apexSetSlabShape(rampId, {
        z: [0, 0.6, 0.6, 0],
        points: [],
        creases: [],
      });
    } catch {
      /* shape edit optional if kernel rejects */
    }
  }

  scene = apexCreateLevel("Level 1", 3);
  const l1 =
    scene.levels.find((l) => l.id !== l0 && Math.abs(l.elevation - 3) < 1e-6)
      ?.id ?? scene.levels[scene.levels.length - 1]?.id;
  if (!l1) return apexGetScene();

  apexSetActiveLevel(l1);
  const storey1 = buildStorey(3, { entrance: false });

  // Stair from L0; cuts the L1 slab.
  apexSetActiveLevel(l0);
  apexCreateElement(
    "apex.stair",
    [xz(1, 1.5, 0), xz(1, 6, 0)],
    { width: 1.0, height: 3 },
    0,
    "two_point",
  );

  // Pitched roof on L1, ridge along axis B.
  apexSetActiveLevel(l1);
  apexCreateElement(
    "apex.roof.pitched",
    [xz(0, 4, 3), xz(10, 4, 3)],
    {
      width: 8,
      overhang: 0.5,
      eave_cut: "perpendicular",
    },
    0,
    "two_point",
  );

  // Attach L1 exterior walls to the roof (gables + eaves).
  if (storey1.exteriorIds.length > 0) {
    try {
      apexCommandScene({
        op: "attach_top",
        ids: storey1.exteriorIds,
      });
    } catch {
      /* attach is best-effort for the sample */
    }
  }

  // Spaces from closed wall centreline loops on each level.
  for (const levelId of [l0, l1]) {
    apexSetActiveLevel(levelId);
    apexDetectRoomsFromWalls();
  }
  renameRoomsOnLevel(l0, ROOM_NAMES_L0);
  renameRoomsOnLevel(l1, ROOM_NAMES_L1);

  apexSetActiveLevel(l0);
  return apexGetScene();
}
