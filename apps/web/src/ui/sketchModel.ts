import type {
  ParamBinding,
  ParamSpecDto,
  ProfilePreviewDto,
  ProfileSketchDto,
  ProfileSpecDto,
  ProfileTypeDto,
  SketchDimensionDto,
} from '../types';

export const SKETCH_SNAP = 0.05;

export function snapSketch(x: number, y: number, step = SKETCH_SNAP): [number, number] {
  return [Math.round(x / step) * step, Math.round(y / step) * step];
}

export function edgeLength(a: [number, number], b: [number, number]): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

export function edgeMid(a: [number, number], b: [number, number]): [number, number] {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

export function distToSegment(
  p: [number, number],
  a: [number, number],
  b: [number, number],
): number {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const len2 = vx * vx + vy * vy;
  if (len2 < 1e-12) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * vx), p[1] - (a[1] + t * vy));
}

export function isHorizontal(a: [number, number], b: [number, number]): boolean {
  return Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]);
}

export function isVertical(a: [number, number], b: [number, number]): boolean {
  return Math.abs(b[1] - a[1]) > Math.abs(b[0] - a[0]);
}

/** Edges whose direction is parallel (or anti-parallel) to `edge`. */
export function parallelEdges(vertices: [number, number][], edge: number): number[] {
  const n = vertices.length;
  if (n < 2) return [edge];
  const a = vertices[edge];
  const b = vertices[(edge + 1) % n];
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const len = Math.hypot(ux, uy);
  if (len < 1e-9) return [edge];
  const nx = ux / len;
  const ny = uy / len;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const c = vertices[i];
    const d = vertices[(i + 1) % n];
    const vx = d[0] - c[0];
    const vy = d[1] - c[1];
    const vl = Math.hypot(vx, vy);
    if (vl < 1e-9) continue;
    const dot = Math.abs((vx / vl) * nx + (vy / vl) * ny);
    if (dot > 0.95) out.push(i);
  }
  return out.length > 0 ? out : [edge];
}

export function lengthParam(
  id: string,
  label: string,
  value: number,
  binding: ParamBinding,
): ParamSpecDto {
  return {
    id,
    label,
    kind: 'length',
    default: value,
    min: Number.MIN_VALUE,
    unit: 'm',
    binding,
  };
}

export function placeholderPolygon(vertices: [number, number][]): ProfileSpecDto {
  const pts =
    vertices.length >= 3
      ? vertices
      : ([
          [-0.1, -0.1],
          [0.1, -0.1],
          [0.1, 0.1],
        ] as [number, number][]);
  return {
    shape: 'polygon',
    points: pts.map(([x, y]) => [
      { op: 'const', value: x },
      { op: 'const', value: y },
    ]),
  };
}

export function inferSketch(
  profile: ProfileTypeDto,
  preview: ProfilePreviewDto | null,
): { vertices: [number, number][]; closed: boolean; dimensions: SketchDimensionDto[] } {
  if (profile.sketch && profile.sketch.vertices.length >= 3) {
    return {
      vertices: profile.sketch.vertices.map(([x, y]) => [x, y]),
      closed: true,
      dimensions: [...(profile.sketch.dimensions ?? [])],
    };
  }
  if (profile.spec.shape === 'circle') {
    return { vertices: [], closed: false, dimensions: [] };
  }
  const verts = (preview?.outer ?? []).map(([x, y]) => [x, y] as [number, number]);
  if (verts.length < 3) {
    return { vertices: [], closed: false, dimensions: [] };
  }
  const dimensions: SketchDimensionDto[] = [];
  const n = verts.length;
  for (let i = 0; i < n; i++) {
    const len = edgeLength(verts[i], verts[(i + 1) % n]);
    const match = profile.params.find(
      (param) => typeof param.default === 'number' && Math.abs(Number(param.default) - len) < 1e-3,
    );
    if (match) dimensions.push({ edge: i, param: match.id });
  }
  return { vertices: verts, closed: true, dimensions };
}

export function suggestDimension(
  category: string,
  vertices: [number, number][],
  edge: number,
  usedIds: Set<string>,
): { id: string; label: string; binding: ParamBinding } {
  const n = vertices.length;
  const a = vertices[edge];
  const b = vertices[(edge + 1) % n];
  const horiz = isHorizontal(a, b);
  if (category === 'wall') {
    if (horiz && !usedIds.has('thickness')) {
      return { id: 'thickness', label: 'Thickness', binding: 'type' };
    }
    if (!horiz && !usedIds.has('height')) {
      return { id: 'height', label: 'Height', binding: 'instance' };
    }
  }
  if (category === 'column' || category === 'beam') {
    if (horiz && !usedIds.has('width')) {
      return { id: 'width', label: 'Width', binding: 'type' };
    }
    if (!horiz && !usedIds.has('depth')) {
      return { id: 'depth', label: 'Depth', binding: 'type' };
    }
  }
  let i = 1;
  while (usedIds.has(`d${i}`)) i += 1;
  return { id: `d${i}`, label: `D${i}`, binding: 'type' };
}

export function sketchPayload(
  vertices: [number, number][],
  dimensions: SketchDimensionDto[],
): ProfileSketchDto {
  return { vertices, dimensions };
}
