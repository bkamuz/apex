/**
 * Genus editor: reference geometry (points, lines, planes, polylines) and
 * dimensions between them, plus "flex": turning a drag in a view into new
 * param values. Pure (no React / WASM); unit tested.
 *
 * Ref coordinates are formulas in metres over the genus params, in the
 * genus frame (x along, y up, z across). The browser evaluates them with
 * the same grammar as the core, so a drag can be solved for a param value
 * without waiting for a rebuild.
 */
import type { GenusAxis, GenusDefDto, GenusDimDto, GenusFormula, GenusRefDto, GenusVec3 } from '../types';
import { evalAst, parseFormula } from './formula.ts';
import type { GenusDraft } from './model.ts';
import { kindOf, resolvedValues, type DraftSpecies, type ParamRow } from './params.ts';
import type { OrthoView } from './projection.ts';

export type RefKindName = GenusRefDto['ref'];
export type V3 = [number, number, number];
export const AXES: GenusAxis[] = ['x', 'y', 'z'];
export const axisIndex = (a: GenusAxis): number => AXES.indexOf(a);

/** Tools that place refs or dims in an ortho view. */
export type PlaceTool = 'plane' | 'line' | 'point' | 'polyline' | 'dim';

// —— Formula helpers ————————————————————————————————————————————————

const round4 = (v: number) => Math.round(v * 1e4) / 1e4;

/** Snap metres to `step` (10 mm by default). */
export function snap(v: number, step = 0.01): number {
  return round4(Math.round(v / step) * step);
}

export function formulaString(f: GenusFormula | undefined): string {
  return typeof f === 'number' ? String(f) : String(f ?? '0');
}

/** The formula's value when it reads no params, else null. */
export function constValue(f: GenusFormula | undefined): number | null {
  if (typeof f === 'number') return f;
  const p = parseFormula(formulaString(f));
  if (!p.ok || p.refs.length) return null;
  const v = evalAst(p.ast, {});
  return Number.isFinite(v) ? v : null;
}

export function evalFormula(f: GenusFormula | undefined, values: Record<string, unknown>): number {
  if (typeof f === 'number') return f;
  const p = parseFormula(formulaString(f));
  return p.ok ? evalAst(p.ast, values) : NaN;
}

/** Names a formula reads. */
export function formulaNames(f: GenusFormula | undefined): string[] {
  if (typeof f === 'number') return [];
  const p = parseFormula(formulaString(f));
  return p.ok ? p.refs : [];
}

const LOOSE = /\b(or|and)\b|[<>=!]|\|\||&&/;

/** `f + name` / `f - name`, kept short (`0 + w` → `w`). */
export function addTerm(f: GenusFormula, name: string, sign: 1 | -1): GenusFormula {
  const c = constValue(f);
  if (c !== null && Math.abs(c) < 1e-12) return sign > 0 ? name : `-${name}`;
  const base = LOOSE.test(formulaString(f)) ? `(${formulaString(f)})` : formulaString(f);
  return `${base} ${sign > 0 ? '+' : '-'} ${name}`;
}

/** `f` shifted by `delta` metres: constants stay numbers, formulas get a term. */
export function offsetFormula(f: GenusFormula, delta: number): GenusFormula {
  const c = constValue(f);
  if (c !== null) return round4(c + delta);
  if (Math.abs(delta) < 1e-9) return f;
  const base = LOOSE.test(formulaString(f)) ? `(${formulaString(f)})` : formulaString(f);
  return `${base} ${delta > 0 ? '+' : '-'} ${round4(Math.abs(delta))}`;
}

// —— Refs and dims of a draft ———————————————————————————————————————

/** Every point of a ref (a plane: its origin), as formulas. */
export function refPoints(ref: GenusRefDto): GenusVec3[] {
  switch (ref.ref) {
    case 'point':
      return [ref.at];
    case 'line':
      return [ref.from, ref.to];
    case 'plane':
      return [ref.origin];
    case 'polyline':
      return ref.points;
  }
}

export function withPoints(ref: GenusRefDto, pts: GenusVec3[]): GenusRefDto {
  switch (ref.ref) {
    case 'point':
      return { ...ref, at: pts[0] };
    case 'line':
      return { ...ref, from: pts[0], to: pts[1] };
    case 'plane':
      return { ...ref, origin: pts[0] };
    case 'polyline':
      return { ...ref, points: pts };
  }
}

export interface ListedRef {
  ref: GenusRefDto;
  /** From `extends`, not authored here. */
  inherited: boolean;
  /** Authored here over an inherited ref of the same id. */
  overrides: boolean;
}

export interface ListedDim {
  dim: GenusDimDto;
  inherited: boolean;
  overrides: boolean;
}

function merged<T extends { id: string }>(own: T[], parent: T[], removed: string[]): { item: T; inherited: boolean; overrides: boolean }[] {
  const ownIds = new Set(own.map((x) => x.id));
  const parentIds = new Set(parent.map((x) => x.id));
  const drop = new Set(removed);
  return [
    ...parent.filter((x) => !ownIds.has(x.id) && !drop.has(x.id)).map((item) => ({ item, inherited: true, overrides: false })),
    ...own.map((item) => ({ item, inherited: false, overrides: parentIds.has(item.id) })),
  ];
}

/** Refs in effect: the parent's (unless removed / overridden), then this genus's. */
export function listRefs(draft: GenusDraft, parent: GenusDefDto | null | undefined): ListedRef[] {
  return merged(draft.refs, parent?.refs ?? [], draft.remove).map(({ item, inherited, overrides }) => ({ ref: item, inherited, overrides }));
}

export function listDims(draft: GenusDraft, parent: GenusDefDto | null | undefined): ListedDim[] {
  return merged(draft.dims, parent?.dims ?? [], draft.remove).map(({ item, inherited, overrides }) => ({ dim: item, inherited, overrides }));
}

/** First free `<prefix>_<n>` id. */
export function nextId(prefix: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  let n = 1;
  while (used.has(`${prefix}_${n}`)) n += 1;
  return `${prefix}_${n}`;
}

/** Every ref / dim / body id of the draft and its parent (ids share one space for `remove`). */
export function takenIds(draft: GenusDraft, parent: GenusDefDto | null | undefined): string[] {
  return [
    ...draft.refs.map((r) => r.id),
    ...draft.dims.map((d) => d.id),
    ...draft.body.map((b) => b.id),
    ...(parent?.refs ?? []).map((r) => r.id),
    ...(parent?.dims ?? []).map((d) => d.id),
    ...(parent?.body ?? []).map((b) => b.id),
  ];
}

/** Add or replace (override, for an inherited id) a ref authored in this genus. */
export function putRef(draft: GenusDraft, ref: GenusRefDto): GenusDraft {
  const i = draft.refs.findIndex((r) => r.id === ref.id);
  const refs = i >= 0 ? draft.refs.map((r, k) => (k === i ? ref : r)) : [...draft.refs, ref];
  return { ...draft, refs, remove: draft.remove.filter((x) => x !== ref.id) };
}

export function putDim(draft: GenusDraft, dim: GenusDimDto): GenusDraft {
  const clean: GenusDimDto = { id: dim.id, from: dim.from, to: dim.to };
  if (dim.axis) clean.axis = dim.axis;
  if (dim.param) clean.param = dim.param;
  if (dim.locked) clean.locked = true;
  const i = draft.dims.findIndex((d) => d.id === dim.id);
  const dims = i >= 0 ? draft.dims.map((d, k) => (k === i ? clean : d)) : [...draft.dims, clean];
  return { ...draft, dims, remove: draft.remove.filter((x) => x !== dim.id) };
}

/** Body items that sit on a ref (sweep along, prism on, nested at). */
export function refUsers(draft: GenusDraft, parent: GenusDefDto | null | undefined, id: string): string[] {
  const removed = new Set(draft.remove);
  const own = new Set(draft.body.map((b) => b.id));
  const body = [...(parent?.body ?? []).filter((b) => !own.has(b.id) && !removed.has(b.id)), ...draft.body];
  return body
    .filter((b) => {
      const x = b as unknown as Record<string, unknown>;
      return x.along === id || x.on === id || x.at === id;
    })
    .map((b) => b.id);
}

/** Drop a dim: authored ones are deleted, inherited ones listed in `remove`. */
export function deleteDim(draft: GenusDraft, parent: GenusDefDto | null | undefined, id: string): GenusDraft {
  const inParent = (parent?.dims ?? []).some((d) => d.id === id);
  return {
    ...draft,
    dims: draft.dims.filter((d) => d.id !== id),
    remove: inParent && !draft.remove.includes(id) ? [...draft.remove, id] : draft.remove,
  };
}

/** Drop a ref and the dims that measure it. Refuses (null) while body items sit on it. */
export function deleteRef(draft: GenusDraft, parent: GenusDefDto | null | undefined, id: string): GenusDraft | null {
  if (refUsers(draft, parent, id).length) return null;
  let out = draft;
  for (const { dim } of listDims(draft, parent)) {
    if (dim.from === id || dim.to === id) out = deleteDim(out, parent, dim.id);
  }
  const inParent = (parent?.refs ?? []).some((r) => r.id === id);
  return {
    ...out,
    refs: out.refs.filter((r) => r.id !== id),
    remove: inParent && !out.remove.includes(id) ? [...out.remove, id] : out.remove,
  };
}

/** Rename an authored (not inherited) ref; dims of this genus follow. */
export function renameRef(draft: GenusDraft, from: string, to: string): GenusDraft {
  return {
    ...draft,
    refs: draft.refs.map((r) => (r.id === from ? { ...r, id: to } : r)),
    dims: draft.dims.map((d) => ({ ...d, from: d.from === from ? to : d.from, to: d.to === from ? to : d.to })),
    body: draft.body.map((b) => {
      const x = { ...(b as unknown as Record<string, unknown>) };
      for (const k of ['along', 'on', 'at']) if (x[k] === from) x[k] = to;
      return x as unknown as typeof b;
    }),
  };
}

// —— Views: screen ↔ genus axes ——————————————————————————————————————

/** Genus axis (and sign) along a view's screen u (right) / v (up). */
export const VIEW_AXES: Record<OrthoView, { u: [number, 1 | -1]; v: [number, 1 | -1] }> = {
  front: { u: [0, 1], v: [1, 1] },
  plan: { u: [0, 1], v: [2, -1] },
  side: { u: [2, -1], v: [1, 1] },
};

/** A view point in genus coordinates (the axis into the screen at 0). */
export function toGenus(view: OrthoView, u: number, v: number): V3 {
  const out: V3 = [0, 0, 0];
  const a = VIEW_AXES[view];
  out[a.u[0]] = u * a.u[1];
  out[a.v[0]] = v * a.v[1];
  return out;
}

/** Normal of a plane drawn as a horizontal (`h`) or vertical (`v`) trace in a view. */
export function planeNormal(view: OrthoView, trace: 'h' | 'v'): GenusAxis {
  return AXES[trace === 'v' ? VIEW_AXES[view].u[0] : VIEW_AXES[view].v[0]];
}

const vec = (p: V3): GenusVec3 => [round4(p[0]), round4(p[1]), round4(p[2])];

export function newPointRef(id: string, p: V3): GenusRefDto {
  return { id, ref: 'point', at: vec(p) };
}

export function newPlaneRef(id: string, p: V3, normal: GenusAxis): GenusRefDto {
  const origin: V3 = [0, 0, 0];
  origin[axisIndex(normal)] = p[axisIndex(normal)];
  return { id, ref: 'plane', origin: vec(origin), normal };
}

export function newLineRef(id: string, a: V3, b: V3): GenusRefDto {
  return { id, ref: 'line', from: vec(a), to: vec(b) };
}

export function newPolylineRef(id: string, pts: V3[]): GenusRefDto {
  return { id, ref: 'polyline', points: pts.map(vec) };
}

// —— Evaluation ————————————————————————————————————————————————————

export interface EvalRef {
  id: string;
  kind: RefKindName;
  points: V3[];
  normal?: GenusAxis;
}

export function evalRef(ref: GenusRefDto, values: Record<string, unknown>): EvalRef {
  return {
    id: ref.id,
    kind: ref.ref,
    points: refPoints(ref).map((p) => p.map((f) => evalFormula(f, values)) as V3),
    normal: ref.ref === 'plane' ? (ref.normal ?? 'z') : undefined,
  };
}

/** Axis a dim measures along (null: straight distance), as the core does. */
export function dimAxis(dim: GenusDimDto, from: GenusRefDto | undefined): number | null {
  if (dim.axis) return axisIndex(dim.axis);
  if (from?.ref === 'plane') return axisIndex(from.normal ?? 'z');
  return null;
}

/** Distance a dim reads (m), from ref origins / first points like the core. */
export function measure(a: EvalRef, b: EvalRef, axis: number | null): number {
  const p = a.points[0] ?? [0, 0, 0];
  const q = b.points[0] ?? [0, 0, 0];
  if (axis !== null) return Math.abs(q[axis] - p[axis]);
  return Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
}

/**
 * Axis for a new dim from `a` to `b` drawn in `view`: shared plane normal,
 * else the first plane's normal, else the main screen direction between them.
 */
export function newDimAxis(view: OrthoView, a: EvalRef, b: EvalRef): GenusAxis {
  if (a.kind === 'plane' && b.kind === 'plane' && a.normal === b.normal) return a.normal!;
  if (a.kind === 'plane') return a.normal!;
  if (b.kind === 'plane') return b.normal!;
  const p = a.points[0];
  const q = b.points[0];
  const ax = VIEW_AXES[view];
  return AXES[Math.abs(q[ax.u[0]] - p[ax.u[0]]) >= Math.abs(q[ax.v[0]] - p[ax.v[0]]) ? ax.u[0] : ax.v[0]];
}

// —— Flex: solve a drag for param values ——————————————————————————————————

export interface FlexContext {
  refs: Map<string, GenusRefDto>;
  dims: GenusDimDto[];
  rows: ParamRow[];
  species: DraftSpecies | null;
  /** Build-injected values (host_depth, length). */
  extra: Record<string, number>;
}

export type FlexResult =
  | { kind: 'param'; id: string; value: number }
  | { kind: 'move'; ref: GenusRefDto }
  | { kind: 'blocked'; reason: 'locked' | 'formula' };

export function flexContext(
  draft: GenusDraft,
  parent: GenusDefDto | null | undefined,
  rows: ParamRow[],
  species: DraftSpecies | null,
  extra: Record<string, number> = {},
): FlexContext {
  return {
    refs: new Map(listRefs(draft, parent).map((r) => [r.ref.id, r.ref])),
    dims: listDims(draft, parent).map((d) => d.dim),
    rows,
    species,
    extra,
  };
}

/** Param values with `patch` applied (species values for species params). */
export function flexValues(ctx: FlexContext, patch: Record<string, number> = {}): Record<string, unknown> {
  let rows = ctx.rows;
  let species = ctx.species;
  for (const [id, value] of Object.entries(patch)) {
    const row = rows.find((r) => r.id === id);
    if (!row) continue;
    if (row.input.species && species) species = { ...species, values: { ...species.values, [id]: value } };
    else rows = rows.map((r) => (r.id === id ? { ...r, input: { ...r.input, default: value } } : r));
  }
  return { ...ctx.extra, ...resolvedValues(rows, species) };
}

/** Params a set of names depends on, through computed (formula) params. */
export function paramDeps(names: string[], rows: ParamRow[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    const row = rows.find((r) => r.id === id);
    if (!row) return;
    if (row.input.formula) formulaNames(row.input.formula).forEach(walk);
    else out.push(id);
  };
  names.forEach(walk);
  return out;
}

/** A param a drag may change: a number / length, set per species or instance. */
export function flexible(row: ParamRow | undefined): boolean {
  if (!row || row.locked || row.input.formula) return false;
  const k = kindOf(row.input);
  return k === 'length' || k === 'number';
}

function coordNames(ref: GenusRefDto | undefined, axis: number): string[] {
  if (!ref) return [];
  return refPoints(ref).flatMap((p) => formulaNames(p[axis]));
}

/** Params held by locked dims: those whose change would alter a locked distance. */
export function heldParams(ctx: FlexContext): Set<string> {
  const out = new Set<string>();
  const base = flexValues(ctx);
  for (const d of ctx.dims) {
    if (!d.locked) continue;
    const a = ctx.refs.get(d.from);
    const b = ctx.refs.get(d.to);
    if (!a || !b) continue;
    const axis = dimAxis(d, a);
    const names = [0, 1, 2].flatMap((k) => [...coordNames(a, k), ...coordNames(b, k)]);
    if (d.param) names.push(d.param);
    const dist = (v: Record<string, unknown>) => measure(evalRef(a, v), evalRef(b, v), axis);
    const now = dist(base);
    for (const p of paramDeps(names, ctx.rows)) {
      const x = Number(base[p]);
      if (!Number.isFinite(x)) continue;
      const h = Math.max(1e-3, Math.abs(x) * 1e-3);
      if (Math.abs(dist(flexValues(ctx, { [p]: x + h })) - now) > 1e-9) out.add(p);
    }
    if (d.param) out.add(d.param);
  }
  return out;
}

/** Refs that are ends of a locked dim along `axis` (moving them would break it). */
function lockedEnds(ctx: FlexContext, axis: number): Set<string> {
  const out = new Set<string>();
  for (const d of ctx.dims) {
    if (!d.locked) continue;
    const a = dimAxis(d, ctx.refs.get(d.from));
    if (a === null || a === axis) {
      out.add(d.from);
      out.add(d.to);
    }
  }
  return out;
}

function clampRow(row: ParamRow, v: number): number {
  const lo = row.input.min ?? (kindOf(row.input) === 'length' ? 0 : -Infinity);
  const hi = row.input.max ?? Infinity;
  return Math.min(hi, Math.max(lo, v));
}

/** Newton / secant: value of `param` that makes `fn` equal `target` (null: no effect). */
export function solveParam(ctx: FlexContext, param: string, fn: (values: Record<string, unknown>) => number, target: number): number | null {
  const row = ctx.rows.find((r) => r.id === param);
  if (!row) return null;
  const base = flexValues(ctx);
  let x = Number(base[param]);
  if (!Number.isFinite(x)) return null;
  for (let i = 0; i < 24; i++) {
    const f = fn(flexValues(ctx, { [param]: x })) - target;
    if (!Number.isFinite(f)) return null;
    if (Math.abs(f) < 1e-7) break;
    const h = Math.max(1e-4, Math.abs(x) * 1e-4);
    const slope = (fn(flexValues(ctx, { [param]: x + h })) - fn(flexValues(ctx, { [param]: x - h }))) / (2 * h);
    if (!Number.isFinite(slope) || Math.abs(slope) < 1e-9) return i === 0 ? null : x;
    x = clampRow(row, x - f / slope);
  }
  return Math.round(x * 1e4) / 1e4;
}

function candidates(names: string[], ctx: FlexContext, prefer: string[] = []): string[] {
  const held = heldParams(ctx);
  const deps = paramDeps(names, ctx.rows);
  const order = [...prefer.flatMap((p) => paramDeps([p], ctx.rows)), ...deps];
  return [...new Set(order)].filter((p) => deps.includes(p) && !held.has(p) && flexible(ctx.rows.find((r) => r.id === p)));
}

function solveFirst(ctx: FlexContext, names: string[], fn: (v: Record<string, unknown>) => number, target: number, prefer: string[] = []): FlexResult | null {
  for (const p of candidates(names, ctx, prefer)) {
    const v = solveParam(ctx, p, fn, target);
    if (v !== null) return { kind: 'param', id: p, value: v };
  }
  return null;
}

const coordFn = (ref: GenusRefDto, point: number, axis: number) => (values: Record<string, unknown>) =>
  evalFormula(refPoints(ref)[point]?.[axis], values);

/** Move point `point` of `ref` along `axis` to `target`: by a param when it reads one, else as a constant. */
export function flexCoord(ctx: FlexContext, refId: string, point: number, axis: number, target: number, prefer: string[] = []): FlexResult {
  const ref = ctx.refs.get(refId);
  if (!ref) return { kind: 'blocked', reason: 'formula' };
  const f = refPoints(ref)[point]?.[axis];
  const solved = solveFirst(ctx, formulaNames(f), coordFn(ref, point, axis), target, prefer);
  if (solved) return solved;
  return moveRef(ctx, ref, axis, target - evalFormula(f, flexValues(ctx)));
}

/** Shift a ref along `axis` by `delta` when its coordinates there are constants. */
function moveRef(ctx: FlexContext, ref: GenusRefDto, axis: number, delta: number): FlexResult {
  const pts = refPoints(ref);
  if (pts.some((p) => constValue(p[axis]) === null)) return { kind: 'blocked', reason: 'formula' };
  if (lockedEnds(ctx, axis).has(ref.id)) return { kind: 'blocked', reason: 'locked' };
  const moved = pts.map((p) => p.map((f, k) => (k === axis ? round4((constValue(f) ?? 0) + delta) : f)) as GenusVec3);
  return { kind: 'move', ref: withPoints(ref, moved) };
}

/**
 * Drag one end of a dim so that end sits at `target` along the dim's axis:
 * solve a param the end ref reads; else the dim's param (or what the
 * distance reads) for the new distance; else move the end ref.
 */
export function flexDim(ctx: FlexContext, dimId: string, end: 'from' | 'to', target: number): FlexResult {
  const dim = ctx.dims.find((d) => d.id === dimId);
  if (!dim) return { kind: 'blocked', reason: 'formula' };
  if (dim.locked) return { kind: 'blocked', reason: 'locked' };
  const fromRef = ctx.refs.get(dim.from);
  const toRef = ctx.refs.get(dim.to);
  const axis = dimAxis(dim, fromRef);
  if (!fromRef || !toRef || axis === null) return { kind: 'blocked', reason: 'formula' };
  const endRef = end === 'from' ? fromRef : toRef;
  const other = end === 'from' ? toRef : fromRef;
  const prefer = dim.param ? [dim.param] : [];
  const byEnd = solveFirst(ctx, coordNames(endRef, axis), coordFn(endRef, 0, axis), target, prefer);
  if (byEnd) return byEnd;
  const values = flexValues(ctx);
  const otherAt = evalFormula(refPoints(other)[0]?.[axis], values);
  const names = [...(dim.param ? [dim.param] : []), ...coordNames(fromRef, axis), ...coordNames(toRef, axis)];
  const dist = (v: Record<string, unknown>) => measure(evalRef(fromRef, v), evalRef(toRef, v), axis);
  const byDist = solveFirst(ctx, names, dist, Math.abs(target - otherAt), prefer);
  if (byDist) return byDist;
  const at = evalFormula(refPoints(endRef)[0]?.[axis], values);
  return moveRef(ctx, endRef, axis, target - at);
}

/** Drag a plane trace (along its normal) or a point (both screen axes) in `view`. */
export function flexRefDrag(ctx: FlexContext, refId: string, view: OrthoView, start: V3, now: V3): FlexResult[] {
  const ref = ctx.refs.get(refId);
  if (!ref) return [];
  const ax = VIEW_AXES[view];
  const axes = ref.ref === 'plane' ? [axisIndex(ref.normal ?? 'z')].filter((a) => a === ax.u[0] || a === ax.v[0]) : [ax.u[0], ax.v[0]];
  const values = flexValues(ctx);
  const out: FlexResult[] = [];
  let c = ctx;
  for (const axis of axes) {
    const delta = now[axis] - start[axis];
    if (Math.abs(delta) < 1e-9) continue;
    if (ref.ref === 'line' || ref.ref === 'polyline') {
      const r = moveRef(c, c.refs.get(refId) ?? ref, axis, delta);
      out.push(r);
      if (r.kind === 'move') c = { ...c, refs: new Map(c.refs).set(refId, r.ref) };
      continue;
    }
    const at = evalFormula(refPoints(ref)[0][axis], values);
    const r = flexCoord(c, refId, 0, axis, at + delta);
    out.push(r);
    c = applyToContext(c, r);
  }
  return out;
}

/** The context after a flex result (for chaining two axes). */
export function applyToContext(ctx: FlexContext, r: FlexResult): FlexContext {
  if (r.kind === 'move') return { ...ctx, refs: new Map(ctx.refs).set(r.ref.id, r.ref) };
  if (r.kind !== 'param') return ctx;
  const row = ctx.rows.find((x) => x.id === r.id);
  if (row?.input.species && ctx.species) return { ...ctx, species: { ...ctx.species, values: { ...ctx.species.values, [r.id]: r.value } } };
  return { ...ctx, rows: ctx.rows.map((x) => (x.id === r.id ? { ...x, input: { ...x.input, default: r.value } } : x)) };
}

// —— Labels (dims driven by params) ——————————————————————————————————————

/**
 * Bind `dim` to `param` so the param drives the distance: the end ref with
 * a constant coordinate along the dim's axis is rewritten as the other
 * end's formula ± the param. `driving` is false when neither end could be
 * rewritten (both already formulas, or a straight-distance dim): the dim
 * then only shows the param.
 */
export function bindDim(
  draft: GenusDraft,
  parent: GenusDefDto | null | undefined,
  dimId: string,
  param: string | null,
  values: Record<string, unknown>,
): { draft: GenusDraft; driving: boolean } {
  const listed = listDims(draft, parent).find((d) => d.dim.id === dimId);
  if (!listed) return { draft, driving: false };
  let out = putDim(draft, { ...listed.dim, param: param ?? undefined });
  if (!param) return { draft: out, driving: false };
  const refs = new Map(listRefs(out, parent).map((r) => [r.ref.id, r.ref]));
  const a = refs.get(listed.dim.from);
  const b = refs.get(listed.dim.to);
  const axis = dimAxis(listed.dim, a);
  if (!a || !b || axis === null || a.ref === 'line' || a.ref === 'polyline' || b.ref === 'line' || b.ref === 'polyline') return { draft: out, driving: false };
  const fa = refPoints(a)[0][axis];
  const fb = refPoints(b)[0][axis];
  const sign: 1 | -1 = evalFormula(fb, values) >= evalFormula(fa, values) ? 1 : -1;
  const set = (ref: GenusRefDto, f: GenusFormula) => {
    const p = [...refPoints(ref)[0]] as GenusVec3;
    p[axis] = f;
    out = putRef(out, withPoints(ref, [p]));
  };
  if (constValue(fb) !== null && !formulaNames(fa).includes(param)) set(b, addTerm(fa, param, sign));
  else if (constValue(fa) !== null && !formulaNames(fb).includes(param)) set(a, addTerm(fb, param, sign > 0 ? -1 : 1));
  else return { draft: out, driving: formulaNames(fa).includes(param) || formulaNames(fb).includes(param) };
  return { draft: out, driving: true };
}

/** Set a dim's distance to `value` (typed in the dim form): solve its param, else what it reads, else move its `to` ref. */
export function flexDimValue(ctx: FlexContext, dimId: string, value: number): FlexResult {
  const dim = ctx.dims.find((d) => d.id === dimId);
  if (!dim) return { kind: 'blocked', reason: 'formula' };
  if (dim.locked) return { kind: 'blocked', reason: 'locked' };
  const fromRef = ctx.refs.get(dim.from);
  const toRef = ctx.refs.get(dim.to);
  const axis = dimAxis(dim, fromRef);
  if (!fromRef || !toRef || axis === null) return { kind: 'blocked', reason: 'formula' };
  const prefer = dim.param ? [dim.param] : [];
  const names = [...prefer, ...coordNames(fromRef, axis), ...coordNames(toRef, axis)];
  const dist = (v: Record<string, unknown>) => measure(evalRef(fromRef, v), evalRef(toRef, v), axis);
  const solved = solveFirst(ctx, names, dist, Math.max(0, value), prefer);
  if (solved) return solved;
  const values = flexValues(ctx);
  const a = evalFormula(refPoints(fromRef)[0]?.[axis], values);
  const b = evalFormula(refPoints(toRef)[0]?.[axis], values);
  return moveRef(ctx, toRef, axis, a + (b >= a ? 1 : -1) * Math.max(0, value) - b);
}
