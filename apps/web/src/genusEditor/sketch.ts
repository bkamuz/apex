/**
 * Genus editor: sketches (lines, arcs, rectangles, circles drawn in a view)
 * and the solids built from them — extrude, revolve, sweep — plus boxes.
 * Pure (no React / WASM); unit tested.
 *
 * A sketch lives in the plane of the view it was drawn in, in the core's
 * plane axes (normal z: (x, y); normal y: (x, z); normal x: (z, y)).
 * Coordinates are formulas; `ref.<id>` (a plane's offset) and
 * `ref.<id>.x|y|z` (a point) lock a vertex to a reference, so the shape
 * follows the reference when a dimension flexes the genus.
 */
import type { GenusAxis, GenusBodyItemDto, GenusFormula, GenusRefDto, GenusSketchItemDto, GenusVec2, GenusVec3 } from '../types';
import { formulaRefs } from './formula.ts';
import { AXES, axisIndex, evalFormula, formulaString, snap, type EvalRef, type V3 } from './refs.ts';
import type { OrthoView, P2 } from './projection.ts';

export const REF_PREFIX = 'ref.';

export type SolidKind = 'extrude' | 'revolve' | 'sweep' | 'box';
export type SketchTool = 'line' | 'arc' | 'rect' | 'circle';

/** Sketch plane normal of a view (the axis into the screen). */
export function viewNormal(view: OrthoView): GenusAxis {
  return view === 'front' ? 'z' : view === 'plan' ? 'y' : 'x';
}

export function normalView(normal: GenusAxis | undefined): OrthoView {
  return normal === 'y' ? 'plan' : normal === 'x' ? 'side' : 'front';
}

/** Genus axis index of each plane coordinate. */
export function planeAxes(normal: GenusAxis): [number, number] {
  return normal === 'z' ? [0, 1] : normal === 'y' ? [0, 2] : [2, 1];
}

/** View point → plane coordinates (numbers). */
export function viewToPlane(view: OrthoView, p: P2): P2 {
  if (view === 'front') return [p[0], p[1]];
  if (view === 'plan') return [p[0], -p[1]];
  return [-p[0], p[1]];
}

export function planeToView(view: OrthoView, q: P2): P2 {
  if (view === 'front') return [q[0], q[1]];
  if (view === 'plan') return [q[0], -q[1]];
  return [-q[0], q[1]];
}

/** Formula values plus `ref.<id>` names, as the core injects them for shapes. */
export function refValues(values: Record<string, unknown>, refs: EvalRef[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...values };
  for (const r of refs) {
    const p = r.points[0] ?? [0, 0, 0];
    AXES.forEach((a, k) => (out[`${REF_PREFIX}${r.id}.${a}`] = p[k]));
    if (r.kind === 'plane' && r.normal) out[`${REF_PREFIX}${r.id}`] = p[axisIndex(r.normal)];
  }
  return out;
}

/** Names `ref.*` formulas may use, for the given refs. */
export function refNames(refs: { id: string; ref: GenusRefDto['ref'] }[]): string[] {
  const out: string[] = [];
  for (const r of refs) {
    if (r.ref === 'plane') out.push(`${REF_PREFIX}${r.id}`);
    for (const a of AXES) out.push(`${REF_PREFIX}${r.id}.${a}`);
  }
  return out;
}

/** The ref id a `ref.<id>[.x|y|z]` name reads, else null. */
export function refOfName(name: string): string | null {
  if (!name.startsWith(REF_PREFIX)) return null;
  const rest = name.slice(REF_PREFIX.length);
  return /\.[xyz]$/.test(rest) ? rest.slice(0, -2) : rest;
}

/** Ref ids a formula locks to. */
export function lockedRefs(f: GenusFormula | undefined): string[] {
  if (typeof f !== 'string') return [];
  return formulaRefs(f)
    .map(refOfName)
    .filter((x): x is string => Boolean(x));
}

// —— Evaluation and closed-profile check (mirrors the core) ——————————————

const TOL = 1e-6;
const ev2 = (q: GenusVec2, v: Record<string, unknown>): P2 => [evalFormula(q[0], v), evalFormula(q[1], v)];

/** Points of an arc a → b with `bulge`, a included, b excluded. */
export function arcPoints(a: P2, b: P2, bulge: number): P2[] {
  if (Math.abs(bulge) < 1e-9) return [a];
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const sweep = 4 * Math.atan(bulge);
  const k = (1 - bulge * bulge) / (4 * bulge);
  const c: P2 = [(a[0] + b[0]) / 2 - dy * k, (a[1] + b[1]) / 2 + dx * k];
  const r = Math.hypot(a[0] - c[0], a[1] - c[1]);
  const a0 = Math.atan2(a[1] - c[1], a[0] - c[0]);
  const n = Math.max(2, Math.ceil(Math.abs(sweep) / (Math.PI / 12)));
  const out: P2[] = [];
  for (let i = 0; i < n; i++) {
    const t = a0 + (sweep * i) / n;
    out.push([c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)]);
  }
  return out;
}

export function circlePoints(c: P2, r: number, n = 32): P2[] {
  return Array.from({ length: n }, (_, i) => {
    const t = (2 * Math.PI * i) / n;
    return [c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)] as P2;
  });
}

/** Bulge of the arc a → b through m (three-point arc). */
export function bulgeThrough(a: P2, m: P2, b: P2): number {
  const d = 2 * (a[0] * (m[1] - b[1]) + m[0] * (b[1] - a[1]) + b[0] * (a[1] - m[1]));
  if (Math.abs(d) < 1e-12) return 0;
  const sq = (p: P2) => p[0] * p[0] + p[1] * p[1];
  const cx = (sq(a) * (m[1] - b[1]) + sq(m) * (b[1] - a[1]) + sq(b) * (a[1] - m[1])) / d;
  const cy = (sq(a) * (b[0] - m[0]) + sq(m) * (a[0] - b[0]) + sq(b) * (m[0] - a[0])) / d;
  const ang = (p: P2) => Math.atan2(p[1] - cy, p[0] - cx);
  const tau = 2 * Math.PI;
  const norm = (x: number) => ((x % tau) + tau) % tau;
  const ccw = norm(ang(b) - ang(a));
  const mid = norm(ang(m) - ang(a));
  const sweep = mid < ccw ? ccw : ccw - tau;
  return Math.round(Math.tan(sweep / 4) * 1e4) / 1e4;
}

function area(ring: P2[]): number {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    s += p[0] * q[1] - q[0] * p[1];
  }
  return s / 2;
}

function inside(pt: P2, ring: P2[]): boolean {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a[1] > pt[1] !== b[1] > pt[1] && pt[0] < ((b[0] - a[0]) * (pt[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
}

/** Why a sketch is not a valid profile (catalog key genusEditor.sketch.err.<code>). */
export type SketchIssue = { code: 'empty' | 'open' | 'branch' | 'zero' | 'outside' | 'formula'; at?: P2 };

export type SketchLoops = { ok: true; loops: P2[][] } | { ok: false; issue: SketchIssue };

const key = (q: P2) => `${Math.round(q[0] / TOL)},${Math.round(q[1] / TOL)}`;

/** Closed loops of a sketch (outline first), or the first problem. */
export function sketchLoops(items: GenusSketchItemDto[], values: Record<string, unknown>): SketchLoops {
  const loops: P2[][] = [];
  const pieces: { pts: P2[]; a: P2; b: P2 }[] = [];
  const bad = (q: number[]) => q.some((v) => !Number.isFinite(v));
  for (const it of items) {
    if (it.kind === 'rect') {
      const a = ev2(it.a, values);
      const b = ev2(it.b, values);
      if (bad([...a, ...b])) return { ok: false, issue: { code: 'formula' } };
      if (Math.abs(a[0] - b[0]) < TOL || Math.abs(a[1] - b[1]) < TOL) return { ok: false, issue: { code: 'zero', at: a } };
      loops.push([a, [b[0], a[1]], b, [a[0], b[1]]]);
    } else if (it.kind === 'circle') {
      const c = ev2(it.c, values);
      const r = evalFormula(it.r, values);
      if (bad([...c, r])) return { ok: false, issue: { code: 'formula' } };
      if (r < TOL) return { ok: false, issue: { code: 'zero', at: c } };
      loops.push(circlePoints(c, r));
    } else {
      const a = ev2(it.a, values);
      const b = ev2(it.b, values);
      const k = it.kind === 'arc' ? evalFormula(it.bulge, values) : 0;
      if (bad([...a, ...b, k])) return { ok: false, issue: { code: 'formula' } };
      if (key(a) === key(b)) return { ok: false, issue: { code: 'zero', at: a } };
      pieces.push({ pts: it.kind === 'arc' ? arcPoints(a, b, k) : [a], a, b });
    }
  }
  const degree = new Map<string, { n: number; q: P2 }>();
  for (const p of pieces) {
    for (const q of [p.a, p.b]) {
      const e = degree.get(key(q)) ?? { n: 0, q };
      e.n += 1;
      degree.set(key(q), e);
    }
  }
  for (const { n, q } of degree.values()) {
    if (n === 1) return { ok: false, issue: { code: 'open', at: q } };
    if (n > 2) return { ok: false, issue: { code: 'branch', at: q } };
  }
  const used = pieces.map(() => false);
  for (let s = 0; s < pieces.length; s++) {
    if (used[s]) continue;
    used[s] = true;
    const ring = [...pieces[s].pts];
    const first = key(pieces[s].a);
    let end = pieces[s].b;
    while (key(end) !== first) {
      const j = pieces.findIndex((p, i) => !used[i] && (key(p.a) === key(end) || key(p.b) === key(end)));
      if (j < 0) return { ok: false, issue: { code: 'open', at: end } };
      used[j] = true;
      const p = pieces[j];
      if (key(p.a) === key(end)) {
        ring.push(...p.pts);
        end = p.b;
      } else {
        const back = [...p.pts.slice(1), p.b].reverse();
        ring.push(...back);
        end = p.a;
      }
    }
    if (ring.length < 3) return { ok: false, issue: { code: 'zero', at: ring[0] } };
    loops.push(ring);
  }
  if (!loops.length) return { ok: false, issue: { code: 'empty' } };
  let outer = 0;
  loops.forEach((l, i) => {
    if (Math.abs(area(l)) > Math.abs(area(loops[outer]))) outer = i;
  });
  const [o] = loops.splice(outer, 1);
  for (const l of loops) if (!inside(l[0], o)) return { ok: false, issue: { code: 'outside', at: l[0] } };
  return { ok: true, loops: [o, ...loops] };
}

/** Each item as a view polyline (closed for rects / circles), for drawing. */
export function sketchPaths(view: OrthoView, items: GenusSketchItemDto[], values: Record<string, unknown>): { pts: P2[]; closed: boolean }[] {
  const v = (q: P2) => planeToView(view, q);
  return items.map((it) => {
    if (it.kind === 'rect') {
      const a = ev2(it.a, values);
      const b = ev2(it.b, values);
      return { pts: [a, [b[0], a[1]] as P2, b, [a[0], b[1]] as P2].map(v), closed: true };
    }
    if (it.kind === 'circle') return { pts: circlePoints(ev2(it.c, values), evalFormula(it.r, values)).map(v), closed: true };
    const a = ev2(it.a, values);
    const b = ev2(it.b, values);
    const pts = it.kind === 'arc' ? [...arcPoints(a, b, evalFormula(it.bulge, values)), b] : [a, b];
    return { pts: pts.map(v), closed: false };
  });
}

/** Vertices of a sketch (shared formulas count once), with their lock state. */
export function sketchVertices(items: GenusSketchItemDto[], values: Record<string, unknown>): { q: GenusVec2; at: P2; locked: boolean }[] {
  const out = new Map<string, { q: GenusVec2; at: P2; locked: boolean }>();
  const add = (q: GenusVec2) => {
    const at = ev2(q, values);
    const k = `${formulaString(q[0])}|${formulaString(q[1])}`;
    if (!out.has(k)) out.set(k, { q, at, locked: q.some((f) => lockedRefs(f).length > 0) });
  };
  for (const it of items) {
    if (it.kind === 'circle') add(it.c);
    else {
      add(it.a);
      add(it.b);
    }
  }
  return [...out.values()];
}

// —— Snapping a click to vertices and references ——————————————————————

export interface SnapTarget {
  /** Existing sketch vertex formulas. */
  vertices: { q: GenusVec2; at: P2 }[];
  /** Refs in effect, evaluated. */
  refs: EvalRef[];
}

/**
 * A clicked plane point as formulas: an existing vertex (copied exactly, so
 * shared corners stay shared), a point ref (both coordinates locked), plane
 * refs seen edge-on (that coordinate locked), else snapped to 5 mm.
 * `tol` is the snap distance in metres (a few pixels).
 */
export function snapPoint(normal: GenusAxis, q: P2, target: SnapTarget, tol: number): { q: GenusVec2; at: P2; locks: string[] } {
  let best: { q: GenusVec2; at: P2 } | null = null;
  let bestD = tol;
  for (const v of target.vertices) {
    const d = Math.hypot(v.at[0] - q[0], v.at[1] - q[1]);
    if (d <= bestD) {
      best = v;
      bestD = d;
    }
  }
  if (best) return { ...best, locks: [...lockedRefs(best.q[0]), ...lockedRefs(best.q[1])] };
  const axes = planeAxes(normal);
  for (const r of target.refs) {
    if (r.kind !== 'point') continue;
    const p = r.points[0];
    const at: P2 = [p[axes[0]], p[axes[1]]];
    if (Math.hypot(at[0] - q[0], at[1] - q[1]) <= tol) {
      return { q: [`${REF_PREFIX}${r.id}.${AXES[axes[0]]}`, `${REF_PREFIX}${r.id}.${AXES[axes[1]]}`], at, locks: [r.id] };
    }
  }
  const out: GenusVec2 = [snap(q[0], 0.005), snap(q[1], 0.005)];
  const at: P2 = [out[0] as number, out[1] as number];
  const locks: string[] = [];
  for (const k of [0, 1] as const) {
    let d = tol;
    for (const r of target.refs) {
      if (r.kind !== 'plane' || !r.normal || axisIndex(r.normal) !== axes[k]) continue;
      const off = r.points[0][axes[k]];
      if (Math.abs(off - q[k]) <= d) {
        d = Math.abs(off - q[k]);
        out[k] = `${REF_PREFIX}${r.id}`;
        at[k] = off;
        locks[k] = r.id;
      }
    }
  }
  return { q: out, at, locks: locks.filter(Boolean) };
}

// —— Body items ————————————————————————————————————————————————————

export type ShapeItem = Extract<GenusBodyItemDto, { item: 'solid' | 'cut' }>;

export function isShapeItem(b: GenusBodyItemDto): b is ShapeItem {
  return b.item === 'solid' || b.item === 'cut';
}

/** Editor kind of a body item's shape, if the editor can author it. */
export function solidKind(b: GenusBodyItemDto): SolidKind | null {
  if (!isShapeItem(b)) return null;
  if (b.shape === 'box') return 'box';
  if (b.shape === 'prism') return 'extrude';
  if (b.shape === 'revolve') return 'revolve';
  if (b.shape === 'sweep') return 'sweep';
  return null;
}

/** A void: a cut that subtracts from this genus's own solids. */
export function isVoid(b: GenusBodyItemDto): boolean {
  return b.item === 'cut';
}

/** Solid ↔ void (cut from self), keeping the shape and the item fields. */
export function setVoid(b: ShapeItem, makeVoid: boolean): ShapeItem {
  const rest = { ...(b as unknown as Record<string, unknown>) };
  delete rest.glass;
  delete rest.material;
  delete rest.targets;
  if (makeVoid) return { ...rest, item: 'cut', targets: { self: true } } as unknown as ShapeItem;
  const material = b.item === 'solid' ? b.material : undefined;
  return { ...rest, item: 'solid', ...(material ? { material } : {}) } as unknown as ShapeItem;
}

/** The sketch of an authored shape, if it has one. */
export function sketchOf(b: GenusBodyItemDto): GenusSketchItemDto[] | null {
  if (!isShapeItem(b)) return null;
  if (b.shape === 'prism' || b.shape === 'revolve' || b.shape === 'sweep') return b.sketch ?? null;
  return null;
}

/** View a shape's sketch is drawn in. */
export function sketchView(b: GenusBodyItemDto): OrthoView {
  if (isShapeItem(b) && (b.shape === 'prism' || b.shape === 'revolve' || b.shape === 'sweep')) return normalView(b.normal);
  return 'front';
}

/** Default extrude depth: ±50 mm about the sketch plane. */
export const DEFAULT_DEPTH: [GenusFormula, GenusFormula] = [-0.05, 0.05];

/** Line refs lying in the sketch plane (revolve axes). */
export function axisRefs(normal: GenusAxis, refs: EvalRef[]): EvalRef[] {
  const n = axisIndex(normal);
  return refs.filter((r) => r.kind === 'line' && r.points.length === 2 && Math.abs(r.points[0][n] - r.points[1][n]) < 1e-6);
}

/** Line / polyline refs (sweep paths). */
export function pathRefs(refs: EvalRef[]): EvalRef[] {
  return refs.filter((r) => (r.kind === 'line' || r.kind === 'polyline') && r.points.length >= 2);
}

export function newSketchShape(
  id: string,
  kind: Exclude<SolidKind, 'box'>,
  view: OrthoView,
  sketch: GenusSketchItemDto[],
  ref: string | undefined,
): ShapeItem {
  const normal = viewNormal(view);
  if (kind === 'extrude') return { id, item: 'solid', shape: 'prism', normal, sketch, depth: [...DEFAULT_DEPTH] };
  if (kind === 'revolve') return { id, item: 'solid', shape: 'revolve', normal, sketch, axis: ref, angle: 360 };
  return { id, item: 'solid', shape: 'sweep', normal, sketch, along: ref };
}

/** Replace the sketch of an authored shape (re-entered sketch). */
export function withSketch(b: ShapeItem, sketch: GenusSketchItemDto[]): ShapeItem {
  return { ...b, sketch } as ShapeItem;
}

/**
 * A box from two corners clicked in a view (formulas: locked corners keep
 * their `ref.*` names); the axis into the screen spans ±50 mm.
 */
export function newBox(id: string, view: OrthoView, a: GenusVec2, b: GenusVec2): ShapeItem {
  const n = viewNormal(view);
  const [i, j] = planeAxes(n);
  const min: GenusVec3 = [0, 0, 0];
  const max: GenusVec3 = [0, 0, 0];
  min[i] = a[0];
  max[i] = b[0];
  min[j] = a[1];
  max[j] = b[1];
  const k = axisIndex(n);
  min[k] = DEFAULT_DEPTH[0];
  max[k] = DEFAULT_DEPTH[1];
  return { id, item: 'solid', shape: 'box', min, max };
}

/** Rename `ref.<from>` → `ref.<to>` in one formula. */
export function renameRefInFormula(f: GenusFormula, from: string, to: string): GenusFormula {
  if (typeof f !== 'string') return f;
  const esc = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return f.replace(new RegExp(`\\bref\\.${esc}(?=\\.[xyz]\\b|\\b(?!\\.))`, 'g'), `${REF_PREFIX}${to}`);
}

const FORMULA_SKIP = new Set(['id', 'item', 'shape', 'kind', 'normal', 'axis', 'along', 'on', 'at', 'genus', 'species', 'material', 'targets', 'plan']);

/** Every formula string of a body item, rewritten by `fn`. */
export function mapFormulas<T>(value: T, fn: (f: GenusFormula) => GenusFormula): T {
  const walk = (v: unknown, k?: string): unknown => {
    if (k && FORMULA_SKIP.has(k)) return v;
    if (typeof v === 'string') return fn(v);
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([kk, x]) => [kk, walk(x, kk)]));
    return v;
  };
  return walk(value) as T;
}

/** Ref ids a body item reads: `on` / `along` / `at` / `axis` and `ref.*` formulas. */
export function bodyRefIds(b: GenusBodyItemDto): string[] {
  const x = b as unknown as Record<string, unknown>;
  const out = new Set<string>();
  for (const k of ['along', 'on', 'at', 'axis']) if (typeof x[k] === 'string') out.add(x[k] as string);
  mapFormulas(b, (f) => {
    for (const id of lockedRefs(f)) out.add(id);
    return f;
  });
  return [...out];
}

/** The shape's value in plane coordinates → view, for highlighting a vertex. */
export function vertexView(view: OrthoView, q: GenusVec2, values: Record<string, unknown>): P2 {
  return planeToView(view, ev2(q, values));
}

export type { V3 };
