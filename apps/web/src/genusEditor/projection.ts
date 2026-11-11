/**
 * Genus editor views: orthographic projections of a preview_genus result,
 * plus the sample host, references and dimensions, as plain 2D primitives
 * (u right, v up, metres) for the SVG views. Pure; unit tested.
 *
 * Genus frame: x along the element, y up, z across (wall normal).
 *  - front (elevation): seen from +z: u = x,  v = y
 *  - plan:              seen from +y: u = x,  v = -z
 *  - side:              seen from +x: u = -z, v = y
 */
import type { GenusMeshDto, GenusPreviewDto } from '../types';
import { topItemOfPath, type TestHost } from './model.ts';

export type OrthoView = 'front' | 'plan' | 'side';
export type V3 = [number, number, number];
export type P2 = [number, number];

type OkPreview = Extract<GenusPreviewDto, { ok: true }>;

export interface Bounds3 {
  min: V3;
  max: V3;
}

export interface SolidShape {
  /** Top-level body item id (for selection / colour). */
  item: string;
  path: string;
  kind: 'solid' | 'glass' | 'cut';
  /** Front-facing triangles. */
  tris: P2[][];
  /** Segments [u0, v0, u1, v1]. */
  edges: number[][];
  /** Larger = closer to the viewer (draw order). */
  depth: number;
}

export interface RefShape {
  id: string;
  /** Polyline (two points for a plane line). */
  points: P2[];
  /** Plane trace: drawn across the whole view. */
  infinite: 'h' | 'v' | null;
  point: boolean;
}

export interface DimShape {
  id: string;
  a: P2;
  b: P2;
  /** Dimension line direction on screen. */
  dir: 'h' | 'v';
  value: number;
  param?: string;
  locked?: boolean;
  /** Both ends are planes seen edge-on: the dim line may sit anywhere along them. */
  free?: boolean;
  /** Vertical dims: draw left of the points instead of right. */
  before?: boolean;
}

export interface HostShape {
  /** Polygons (outer, then holes) drawn with even-odd fill. */
  loops: P2[][];
  /** Cut by the view plane (plan / side sections): hatched heavier. */
  section: boolean;
}

export interface ViewModel {
  solids: SolidShape[];
  host: HostShape | null;
  refs: RefShape[];
  dims: DimShape[];
  /** Plan symbol lines (plan view only). */
  symbols: number[][];
  /** Level line at y = 0 (front / side). */
  level: number | null;
  /** Solids only (no host, cuts or refs): for overall dimensions. */
  extents: { min: P2; max: P2 } | null;
  bounds: { min: P2; max: P2 };
}

export function project(view: OrthoView, p: ArrayLike<number>, i = 0): P2 {
  const x = p[i];
  const y = p[i + 1];
  const z = p[i + 2];
  if (view === 'front') return [x, y];
  if (view === 'plan') return [x, -z];
  return [-z, y];
}

/** Depth toward the viewer. */
function depthOf(view: OrthoView, p: ArrayLike<number>, i = 0): number {
  return view === 'front' ? p[i + 2] : view === 'plan' ? p[i + 1] : p[i];
}

function towardViewer(view: OrthoView): V3 {
  return view === 'front' ? [0, 0, 1] : view === 'plan' ? [0, 1, 0] : [1, 0, 0];
}

export function meshBounds(meshes: GenusMeshDto[]): Bounds3 | null {
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  for (const m of meshes) {
    const p = m.positions;
    for (let i = 0; i + 2 < p.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        if (p[i + k] < min[k]) min[k] = p[i + k];
        if (p[i + k] > max[k]) max[k] = p[i + k];
      }
    }
  }
  return Number.isFinite(min[0]) ? { min, max } : null;
}

function solidShape(view: OrthoView, mesh: GenusMeshDto, path: string, kind: SolidShape['kind']): SolidShape {
  const p = mesh.positions;
  const idx = mesh.indices.length ? mesh.indices : Array.from({ length: p.length / 3 }, (_, i) => i);
  const toward = towardViewer(view);
  const tris: P2[][] = [];
  let depth = -Infinity;
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const a = idx[t] * 3;
    const b = idx[t + 1] * 3;
    const c = idx[t + 2] * 3;
    const e1 = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]];
    const e2 = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const facing = n[0] * toward[0] + n[1] * toward[1] + n[2] * toward[2];
    for (const v of [a, b, c]) depth = Math.max(depth, depthOf(view, p, v));
    if (facing <= 1e-12) continue;
    tris.push([project(view, p, a), project(view, p, b), project(view, p, c)]);
  }
  const edges: number[][] = [];
  // Silhouette: edges used by exactly one front-facing triangle (the core's
  // feature edges can skip outer outlines of prisms with holes).
  const q = (i: number) => `${Math.round(p[i] * 1e5)},${Math.round(p[i + 1] * 1e5)},${Math.round(p[i + 2] * 1e5)}`;
  const once = new Map<string, [number, number]>();
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const vs = [idx[t] * 3, idx[t + 1] * 3, idx[t + 2] * 3];
    const e1 = [p[vs[1]] - p[vs[0]], p[vs[1] + 1] - p[vs[0] + 1], p[vs[1] + 2] - p[vs[0] + 2]];
    const e2 = [p[vs[2]] - p[vs[0]], p[vs[2] + 1] - p[vs[0] + 1], p[vs[2] + 2] - p[vs[0] + 2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    if (n[0] * toward[0] + n[1] * toward[1] + n[2] * toward[2] <= 1e-12) continue;
    for (let k = 0; k < 3; k++) {
      const a = vs[k];
      const b = vs[(k + 1) % 3];
      const ka = q(a);
      const kb = q(b);
      const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      if (once.has(key)) once.delete(key);
      else once.set(key, [a, b]);
    }
  }
  for (const [a, b] of once.values()) {
    const [u0, v0] = project(view, p, a);
    const [u1, v1] = project(view, p, b);
    if (Math.abs(u0 - u1) + Math.abs(v0 - v1) < 1e-6) continue;
    edges.push([u0, v0, u1, v1]);
  }
  const e = mesh.edges;
  for (let i = 0; i + 5 < e.length; i += 6) {
    const [u0, v0] = project(view, e, i);
    const [u1, v1] = project(view, e, i + 3);
    if (Math.abs(u0 - u1) + Math.abs(v0 - v1) < 1e-6) continue;
    edges.push([u0, v0, u1, v1]);
  }
  return { item: topItemOfPath(path), path, kind, tris, edges, depth: Number.isFinite(depth) ? depth : 0 };
}

/** The sample host's opening: the union box of cuts that target the host. */
export function hostOpening(preview: OkPreview): Bounds3 | null {
  return meshBounds(preview.cuts.filter((c) => c.targets?.host).map((c) => c.mesh));
}

/** Host extent along x: the genus plus 0.8 m each side (at least 3 m wide). */
export function hostSpan(preview: OkPreview): [number, number] {
  const b = meshBounds([...preview.solids.map((s) => s.mesh), ...preview.cuts.map((c) => c.mesh)]);
  const lo = b ? b.min[0] : -0.5;
  const hi = b ? b.max[0] : 0.5;
  const mid = (lo + hi) / 2;
  const half = Math.max((hi - lo) / 2 + 0.8, 1.5);
  return [mid - half, mid + half];
}

function rect(u0: number, v0: number, u1: number, v1: number): P2[] {
  return [
    [u0, v0],
    [u1, v0],
    [u1, v1],
    [u0, v1],
  ];
}

export function hostShape(view: OrthoView, preview: OkPreview, host: TestHost): HostShape {
  const [x0, x1] = hostSpan(preview);
  const hole = hostOpening(preview);
  const d = host.depth / 2;
  const hy0 = hole ? Math.max(0, hole.min[1]) : 0;
  const hy1 = hole ? Math.min(host.height, hole.max[1]) : 0;
  if (view === 'front') {
    const loops = [rect(x0, 0, x1, host.height)];
    if (hole && hy1 > hy0) loops.push(rect(hole.min[0], hy0, hole.max[0], hy1));
    return { loops, section: false };
  }
  if (view === 'plan') {
    // Section through the middle of the opening (or 1 m up without one).
    if (!hole) return { loops: [rect(x0, -d, x1, d)], section: true };
    return {
      loops: [rect(x0, -d, hole.min[0], d), rect(hole.max[0], -d, x1, d)].filter((l) => l[1][0] > l[0][0]),
      section: true,
    };
  }
  // Side: section through the opening centre.
  if (!hole) return { loops: [rect(-d, 0, d, host.height)], section: true };
  const loops: P2[][] = [];
  if (hy0 > 1e-6) loops.push(rect(-d, 0, d, hy0));
  if (host.height - hy1 > 1e-6) loops.push(rect(-d, hy1, d, host.height));
  return { loops, section: true };
}

function refShapes(view: OrthoView, preview: OkPreview): RefShape[] {
  const out: RefShape[] = [];
  for (const ref of preview.refs) {
    const pts = ref.points.map((p) => project(view, p));
    if (ref.kind === 'plane') {
      const n = ref.normal ?? 'y';
      const o = pts[0];
      // A plane is a trace only when it is edge-on in this view.
      let infinite: 'h' | 'v' | null = null;
      if (view === 'front') infinite = n === 'x' ? 'v' : n === 'y' ? 'h' : null;
      else if (view === 'plan') infinite = n === 'x' ? 'v' : n === 'z' ? 'h' : null;
      else infinite = n === 'z' ? 'v' : n === 'y' ? 'h' : null;
      if (infinite && o) out.push({ id: ref.id, points: [o], infinite, point: false });
      continue;
    }
    if (ref.kind === 'point') {
      if (pts[0]) out.push({ id: ref.id, points: [pts[0]], infinite: null, point: true });
      continue;
    }
    if (pts.length >= 2) out.push({ id: ref.id, points: pts, infinite: null, point: false });
  }
  return out;
}

function dimShapes(view: OrthoView, preview: OkPreview): DimShape[] {
  const out: DimShape[] = [];
  const planes = new Set(preview.refs.filter((r) => r.kind === 'plane').map((r) => r.id));
  for (const dim of preview.dims) {
    const a = project(view, dim.a);
    const b = project(view, dim.b);
    const du = Math.abs(a[0] - b[0]);
    const dv = Math.abs(a[1] - b[1]);
    if (Math.max(du, dv) < 1e-6) continue;
    // Shown only where the measured distance lies in the view plane.
    const value = Math.abs(dim.value);
    if (Math.abs(Math.max(du, dv) - value) > 1e-4 && Math.abs(Math.hypot(du, dv) - value) > 1e-4) continue;
    out.push({ id: dim.id, a, b, dir: du >= dv ? 'h' : 'v', value: dim.value, param: dim.param, locked: dim.locked, free: planes.has(dim.from) && planes.has(dim.to) });
  }
  return out;
}

export function buildView(view: OrthoView, preview: OkPreview, host: TestHost | null): ViewModel {
  const solids: SolidShape[] = [];
  for (const s of preview.solids) {
    if (view === 'plan' && s.plan === 'hidden') continue;
    solids.push(solidShape(view, s.mesh, s.path, s.glass ? 'glass' : 'solid'));
  }
  for (const c of preview.cuts) solids.push(solidShape(view, c.mesh, c.path, 'cut'));
  // Back to front; cuts on top so they stay visible as outlines.
  solids.sort((a, b) => (a.kind === 'cut' ? 1 : 0) - (b.kind === 'cut' ? 1 : 0) || a.depth - b.depth);
  const hostModel = host ? hostShape(view, preview, host) : null;
  const symbols =
    view === 'plan'
      ? preview.plan_lines.map(([p, q]) => [...project('plan', p), ...project('plan', q)])
      : [];
  const refs = refShapes(view, preview);
  const dims = dimShapes(view, preview);
  const level = view === 'plan' ? null : 0;

  let extents: ViewModel['extents'] = null;
  for (const s of solids) {
    if (s.kind === 'cut') continue;
    const pts: number[][] = [];
    for (const [u0, v0, u1, v1] of s.edges) pts.push([u0, v0], [u1, v1]);
    for (const tri of s.tris) pts.push(...tri);
    {
      for (const [u, v] of pts) {
        if (!extents) extents = { min: [u, v], max: [u, v] };
        extents.min[0] = Math.min(extents.min[0], u);
        extents.min[1] = Math.min(extents.min[1], v);
        extents.max[0] = Math.max(extents.max[0], u);
        extents.max[1] = Math.max(extents.max[1], v);
      }
    }
  }
  const min: P2 = [Infinity, Infinity];
  const max: P2 = [-Infinity, -Infinity];
  const add = (u: number, v: number) => {
    if (u < min[0]) min[0] = u;
    if (v < min[1]) min[1] = v;
    if (u > max[0]) max[0] = u;
    if (v > max[1]) max[1] = v;
  };
  for (const s of solids) {
    if (s.kind === 'cut' && hostModel) continue; // host cuts reach far past the wall
    for (const t of s.tris) for (const [u, v] of t) add(u, v);
    for (const [u0, v0, u1, v1] of s.edges) {
      add(u0, v0);
      add(u1, v1);
    }
  }
  if (hostModel) for (const l of hostModel.loops) for (const [u, v] of l) add(u, v);
  for (const r of refs) for (const [u, v] of r.points) add(u, v);
  for (const sym of symbols) {
    add(sym[0], sym[1]);
    add(sym[2], sym[3]);
  }
  if (level !== null && Number.isFinite(min[1])) add(min[0], 0);
  if (!Number.isFinite(min[0])) {
    min[0] = -1;
    min[1] = -1;
    max[0] = 1;
    max[1] = 1;
  }
  return { solids, host: hostModel, refs, dims, symbols, level, extents, bounds: { min, max } };
}

// —— 3D: sample host as boxes around the opening ——————————————————————

export interface BoxMesh {
  positions: number[];
  normals: number[];
  indices: number[];
  edges: number[];
}

/** Axis-aligned box mesh (flat-shaded, with its 12 edges). */
export function boxMesh(min: V3, max: V3, out: BoxMesh = { positions: [], normals: [], indices: [], edges: [] }): BoxMesh {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const faces: [V3, V3[]][] = [
    [[1, 0, 0], [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]]],
    [[-1, 0, 0], [[x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0]]],
    [[0, 1, 0], [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]]],
    [[0, -1, 0], [[x0, y0, z1], [x0, y0, z0], [x1, y0, z0], [x1, y0, z1]]],
    [[0, 0, 1], [[x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [x0, y0, z1]]],
    [[0, 0, -1], [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]]],
  ];
  for (const [n, q] of faces) {
    const base = out.positions.length / 3;
    for (const v of q) {
      out.positions.push(...v);
      out.normals.push(...n);
    }
    out.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const c: V3[] = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const pairs = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
  for (const [a, b] of pairs) out.edges.push(...c[a], ...c[b]);
  return out;
}

/** The sample host as up to four boxes framing the opening. */
export function hostMesh(preview: OkPreview, host: TestHost): BoxMesh {
  const [x0, x1] = hostSpan(preview);
  const d = host.depth / 2;
  const h = host.height;
  const hole = hostOpening(preview);
  const out: BoxMesh = { positions: [], normals: [], indices: [], edges: [] };
  if (!hole) return boxMesh([x0, 0, -d], [x1, h, d], out);
  const hx0 = Math.max(x0, hole.min[0]);
  const hx1 = Math.min(x1, hole.max[0]);
  const hy0 = Math.max(0, hole.min[1]);
  const hy1 = Math.min(h, hole.max[1]);
  if (hx0 > x0) boxMesh([x0, 0, -d], [hx0, h, d], out);
  if (x1 > hx1) boxMesh([hx1, 0, -d], [x1, h, d], out);
  if (hy0 > 1e-6) boxMesh([hx0, 0, -d], [hx1, hy0, d], out);
  if (h - hy1 > 1e-6) boxMesh([hx0, hy1, -d], [hx1, h, d], out);
  return out;
}
