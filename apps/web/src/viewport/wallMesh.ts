/** Client-side wall box mesh — mirrors crates/apex-geometry wall extrusion for previews. */

export interface WallSolidMesh {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
}

type Vec3 = [number, number, number];

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function len(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

function normalize(v: Vec3): Vec3 | null {
  const l = len(v);
  if (l < 1e-8) return null;
  return [v[0] / l, v[1] / l, v[2] / l];
}

function scale(v: Vec3, s: number): Vec3 {
  return [v[0] * s, v[1] * s, v[2] * s];
}

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

/** Oriented box along start→end (Y-up). Returns null if degenerate. */
export function buildWallSolid(
  start: Vec3,
  end: Vec3,
  height: number,
  thickness: number,
): WallSolidMesh | null {
  if (height <= 0 || thickness <= 0) return null;
  let dir = normalize([end[0] - start[0], 0, end[2] - start[2]]);
  if (!dir) return null;
  const up: Vec3 = [0, 1, 0];
  let right = normalize(cross(up, dir));
  if (!right) right = [1, 0, 0];
  dir = normalize(cross(right, up))!;
  right = normalize(cross(up, dir))!;

  const baseY = Math.min(start[1], end[1]);
  const origin: Vec3 = [
    (start[0] + end[0]) * 0.5,
    baseY + height * 0.5,
    (start[2] + end[2]) * 0.5,
  ];
  const hx = len(sub([end[0], 0, end[2]], [start[0], 0, start[2]])) * 0.5;
  const hy = height * 0.5;
  const hz = thickness * 0.5;

  const local: Vec3[] = [
    [-hx, -hy, -hz],
    [hx, -hy, -hz],
    [hx, hy, -hz],
    [-hx, hy, -hz],
    [-hx, -hy, hz],
    [hx, -hy, hz],
    [hx, hy, hz],
    [-hx, hy, hz],
  ];
  const corners: Vec3[] = local.map((p) =>
    add(origin, add(scale(dir, p[0]), add(scale(up, p[1]), scale(right, p[2])))),
  );

  const faces: { idx: [number, number, number, number]; n: Vec3 }[] = [
    { idx: [0, 3, 2, 1], n: scale(right, -1) },
    { idx: [4, 5, 6, 7], n: right },
    { idx: [0, 1, 5, 4], n: scale(up, -1) },
    { idx: [3, 7, 6, 2], n: up },
    { idx: [0, 4, 7, 3], n: scale(dir, -1) },
    { idx: [1, 2, 6, 5], n: dir },
  ];

  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (const { idx, n } of faces) {
    const base = positions.length / 3;
    for (const i of idx) {
      positions.push(corners[i][0], corners[i][1], corners[i][2]);
      normals.push(n[0], n[1], n[2]);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
  };
}
