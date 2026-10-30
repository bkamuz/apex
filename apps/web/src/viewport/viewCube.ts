/** View-cube orientation helpers (camera yaw/pitch ↔ cube faces/edges/corners). */

export const VIEW_CUBE_PITCH_LIMIT = Math.PI / 2 - 0.01;

export type ViewCubeFace = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom';

/** Unit direction from look-at toward the eye for each labeled face. */
export const FACE_EYE_DIR: Record<ViewCubeFace, readonly [number, number, number]> = {
  front: [0, 0, 1],
  back: [0, 0, -1],
  right: [1, 0, 0],
  left: [-1, 0, 0],
  top: [0, 1, 0],
  bottom: [0, -1, 0],
};

export const FACE_LABEL: Record<ViewCubeFace, string> = {
  front: 'FRONT',
  back: 'BACK',
  right: 'RIGHT',
  left: 'LEFT',
  top: 'TOP',
  bottom: 'BOTTOM',
};

export type ViewCubeHit =
  | { kind: 'face'; face: ViewCubeFace }
  | { kind: 'edge'; faces: readonly [ViewCubeFace, ViewCubeFace] }
  | { kind: 'corner'; faces: readonly [ViewCubeFace, ViewCubeFace, ViewCubeFace] };

export interface YawPitch {
  yaw: number;
  pitch: number;
}

/** Eye offset direction matching ViewportRenderer.eyePosition. */
export function eyeDirFromYawPitch(yaw: number, pitch: number): [number, number, number] {
  const cp = Math.cos(pitch);
  return [Math.sin(yaw) * cp, Math.sin(pitch), Math.cos(yaw) * cp];
}

export function yawPitchFromEyeDir(dx: number, dy: number, dz: number): YawPitch {
  const len = Math.hypot(dx, dy, dz) || 1;
  const x = dx / len;
  const y = dy / len;
  const z = dz / len;
  const pitch = Math.max(
    -VIEW_CUBE_PITCH_LIMIT,
    Math.min(VIEW_CUBE_PITCH_LIMIT, Math.asin(Math.max(-1, Math.min(1, y)))),
  );
  const yaw = Math.atan2(x, z);
  return { yaw, pitch };
}

function addDirs(
  faces: readonly ViewCubeFace[],
): [number, number, number] {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const face of faces) {
    const d = FACE_EYE_DIR[face];
    x += d[0];
    y += d[1];
    z += d[2];
  }
  return [x, y, z];
}

/** Target yaw/pitch for a cube hit. Top/bottom faces keep the current yaw. */
export function orientationForHit(hit: ViewCubeHit, currentYaw: number): YawPitch {
  if (hit.kind === 'face') {
    if (hit.face === 'top') {
      return { yaw: currentYaw, pitch: VIEW_CUBE_PITCH_LIMIT };
    }
    if (hit.face === 'bottom') {
      return { yaw: currentYaw, pitch: -VIEW_CUBE_PITCH_LIMIT };
    }
    return yawPitchFromEyeDir(...FACE_EYE_DIR[hit.face]);
  }
  return yawPitchFromEyeDir(...addDirs(hit.faces));
}

/** Shortest-path lerp for yaw across ±π. */
export function lerpAngle(from: number, to: number, t: number): number {
  let delta = to - from;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return from + delta * t;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Ease-out cubic for snap animations. */
export function easeOutCubic(t: number): number {
  const u = 1 - t;
  return 1 - u * u * u;
}

// --- Cube geometry / picking (unit cube centered at origin, half-extent 1) ---

const VERTICES: readonly (readonly [number, number, number])[] = [
  [-1, -1, -1],
  [1, -1, -1],
  [1, 1, -1],
  [-1, 1, -1],
  [-1, -1, 1],
  [1, -1, 1],
  [1, 1, 1],
  [-1, 1, 1],
];

/** Face → vertex indices (CCW when viewed from outside). */
const FACE_VERTS: Record<ViewCubeFace, readonly [number, number, number, number]> = {
  front: [4, 5, 6, 7], // +Z
  back: [1, 0, 3, 2], // -Z
  right: [5, 1, 2, 6], // +X
  left: [0, 4, 7, 3], // -X
  top: [7, 6, 2, 3], // +Y
  bottom: [0, 1, 5, 4], // -Y
};

const ALL_FACES: readonly ViewCubeFace[] = [
  'front',
  'back',
  'left',
  'right',
  'top',
  'bottom',
];

export interface ProjectedCube {
  /** Screen-space vertices (canvas pixels). */
  verts: Array<{ x: number; y: number; z: number }>;
  /** Faces sorted back-to-front by average depth. */
  faces: Array<{
    face: ViewCubeFace;
    indices: readonly [number, number, number, number];
    depth: number;
    facing: number;
  }>;
}

/**
 * Project the unit cube for the current camera yaw/pitch into a square canvas.
 * Matches `rotateX(+pitch) rotateY(-yaw)` then perspective so a positive
 * camera pitch (eye above target) shows the TOP face toward the viewer.
 */
export function projectViewCube(
  yaw: number,
  pitch: number,
  size: number,
  perspective = 4.5,
): ProjectedCube {
  const half = size * 0.5;
  const scale = size * 0.28;
  const cy = Math.cos(-yaw);
  const sy = Math.sin(-yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);

  const verts = VERTICES.map(([x0, y0, z0]) => {
    // rotateY(-yaw)
    const x1 = x0 * cy + z0 * sy;
    const y1 = y0;
    const z1 = -x0 * sy + z0 * cy;
    // rotateX(+pitch)
    const x2 = x1;
    const y2 = y1 * cp - z1 * sp;
    const z2 = y1 * sp + z1 * cp;
    // perspective along +Z toward viewer (camera at +Z looking −Z in this local space)
    const w = perspective / (perspective - z2);
    return {
      x: half + x2 * scale * w,
      y: half - y2 * scale * w,
      z: z2,
    };
  });

  const faces = ALL_FACES.map((face) => {
    const indices = FACE_VERTS[face];
    const depth =
      (verts[indices[0]].z + verts[indices[1]].z + verts[indices[2]].z + verts[indices[3]].z) /
      4;
    // Facing: outward normal · view (+Z after rotation ≈ camera looks −Z at cube)
    const n = FACE_EYE_DIR[face];
    // rotateY(-yaw) then rotateX(+pitch) on the face normal; facing = local +Z
    const ny1 = n[1];
    const nz1 = -n[0] * sy + n[2] * cy;
    const facing = ny1 * sp + nz1 * cp;
    return { face, indices, depth, facing };
  }).sort((a, b) => a.depth - b.depth);

  return { verts, faces };
}

function dist2(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

function pointInTri(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): boolean {
  const v0x = cx - ax;
  const v0y = cy - ay;
  const v1x = bx - ax;
  const v1y = by - ay;
  const v2x = px - ax;
  const v2y = py - ay;
  const dot00 = v0x * v0x + v0y * v0y;
  const dot01 = v0x * v1x + v0y * v1y;
  const dot02 = v0x * v2x + v0y * v2y;
  const dot11 = v1x * v1x + v1y * v1y;
  const dot12 = v1x * v2x + v1y * v2y;
  const inv = 1 / (dot00 * dot11 - dot01 * dot01 || 1);
  const u = (dot11 * dot02 - dot01 * dot12) * inv;
  const v = (dot00 * dot12 - dot01 * dot02) * inv;
  return u >= 0 && v >= 0 && u + v <= 1;
}

function pointInQuad(
  px: number,
  py: number,
  verts: ProjectedCube['verts'],
  indices: readonly [number, number, number, number],
): boolean {
  const a = verts[indices[0]];
  const b = verts[indices[1]];
  const c = verts[indices[2]];
  const d = verts[indices[3]];
  return (
    pointInTri(px, py, a.x, a.y, b.x, b.y, c.x, c.y) ||
    pointInTri(px, py, a.x, a.y, c.x, c.y, d.x, d.y)
  );
}

function distToSegment2(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const ab2 = abx * abx + aby * aby || 1;
  let t = (apx * abx + apy * aby) / ab2;
  t = Math.max(0, Math.min(1, t));
  return dist2(px, py, ax + abx * t, ay + aby * t);
}

const CORNER_FACE_SETS: readonly (readonly ViewCubeFace[])[] = [
  ['left', 'bottom', 'back'], // 0
  ['right', 'bottom', 'back'], // 1
  ['right', 'top', 'back'], // 2
  ['left', 'top', 'back'], // 3
  ['left', 'bottom', 'front'], // 4
  ['right', 'bottom', 'front'], // 5
  ['right', 'top', 'front'], // 6
  ['left', 'top', 'front'], // 7
];

const EDGE_DEFS: readonly {
  a: number;
  b: number;
  faces: readonly [ViewCubeFace, ViewCubeFace];
}[] = [
  { a: 0, b: 1, faces: ['bottom', 'back'] },
  { a: 1, b: 2, faces: ['right', 'back'] },
  { a: 2, b: 3, faces: ['top', 'back'] },
  { a: 3, b: 0, faces: ['left', 'back'] },
  { a: 4, b: 5, faces: ['bottom', 'front'] },
  { a: 5, b: 6, faces: ['right', 'front'] },
  { a: 6, b: 7, faces: ['top', 'front'] },
  { a: 7, b: 4, faces: ['left', 'front'] },
  { a: 0, b: 4, faces: ['left', 'bottom'] },
  { a: 1, b: 5, faces: ['right', 'bottom'] },
  { a: 2, b: 6, faces: ['right', 'top'] },
  { a: 3, b: 7, faces: ['left', 'top'] },
];

/**
 * Pick face / edge / corner under a canvas-local point.
 * Prefer corners, then edges, then front-most face.
 */
export function pickViewCube(
  projected: ProjectedCube,
  x: number,
  y: number,
  cornerRadius = 7,
  edgeRadius = 5,
): ViewCubeHit | null {
  const { verts, faces } = projected;
  const cr2 = cornerRadius * cornerRadius;
  let bestCorner = -1;
  let bestCornerD = cr2;
  for (let i = 0; i < verts.length; i++) {
    const d = dist2(x, y, verts[i].x, verts[i].y);
    if (d <= bestCornerD) {
      bestCornerD = d;
      bestCorner = i;
    }
  }
  if (bestCorner >= 0) {
    const set = CORNER_FACE_SETS[bestCorner];
    return { kind: 'corner', faces: [set[0], set[1], set[2]] };
  }

  const er2 = edgeRadius * edgeRadius;
  let bestEdge = -1;
  let bestEdgeD = er2;
  for (let i = 0; i < EDGE_DEFS.length; i++) {
    const e = EDGE_DEFS[i];
    const va = verts[e.a];
    const vb = verts[e.b];
    // Skip back-facing edges roughly (both endpoints behind)
    if (va.z < -0.15 && vb.z < -0.15) continue;
    const d = distToSegment2(x, y, va.x, va.y, vb.x, vb.y);
    if (d <= bestEdgeD) {
      bestEdgeD = d;
      bestEdge = i;
    }
  }
  if (bestEdge >= 0) {
    return { kind: 'edge', faces: EDGE_DEFS[bestEdge].faces };
  }

  // Front-most face under cursor (iterate painter order reversed)
  for (let i = faces.length - 1; i >= 0; i--) {
    const f = faces[i];
    if (f.facing <= 0.02) continue;
    if (pointInQuad(x, y, verts, f.indices)) {
      return { kind: 'face', face: f.face };
    }
  }
  return null;
}
