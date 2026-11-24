/**
 * Genus editor: nested genera (an instance of another genus inside this
 * one), their param bindings, and mirroring body items about a plane ref.
 * Pure (no React / WASM); unit tested.
 */
import type { ComponentDto, GenusAxis, GenusBodyItemDto, GenusFormula, GenusSketchItemDto, GenusVec2, GenusVec3, ParamSpecDto } from '../types';
import { AXES, axisIndex, formulaString, type V3 } from './refs.ts';
import { planeAxes, REF_PREFIX } from './sketch.ts';

export type NestedItem = Extract<GenusBodyItemDto, { item: 'nested' }>;

export function isNested(b: GenusBodyItemDto | null | undefined): b is NestedItem {
  return b?.item === 'nested';
}

/** Genus ids nested (directly or deeper) by `id`, following registered bodies. */
function nestedClosure(id: string, components: ComponentDto[], seen = new Set<string>()): Set<string> {
  const c = components.find((x) => x.id === id);
  for (const b of c?.genus?.body ?? []) {
    if (b.item !== 'nested' || seen.has(b.genus)) continue;
    seen.add(b.genus);
    nestedClosure(b.genus, components, seen);
  }
  return seen;
}

/**
 * Genera that can be nested into `selfId`: every genus with a body except
 * itself and those that already contain it (no cycles).
 */
export function nestableGenera(components: ComponentDto[], selfId: string): ComponentDto[] {
  return components.filter((c) => c.genus && c.id !== selfId && !nestedClosure(c.id, components).has(selfId));
}

/** A new nested item at a genus point, or on a point ref. */
export function newNested(id: string, genus: string, at: { ref: string } | { point: V3 }): NestedItem {
  const r = (v: number) => Math.round(v * 1e4) / 1e4;
  if ('ref' in at) return { id, item: 'nested', genus, at: at.ref };
  return { id, item: 'nested', genus, offset: [r(at.point[0]), r(at.point[1]), r(at.point[2])] };
}

/** Child params a formula can drive (the core binds numbers). */
export function bindableParams(child: ComponentDto | undefined): ParamSpecDto[] {
  return (child?.params ?? []).filter((p) => p.kind === 'length' || p.kind === 'angle' || p.kind === 'number' || p.kind === 'bool');
}

/** Set (or clear, with `undefined` / '') the binding of one child param. */
export function setBinding(item: NestedItem, param: string, f: GenusFormula | undefined): NestedItem {
  const params = { ...(item.params ?? {}) };
  if (f === undefined || f === '') delete params[param];
  else params[param] = f;
  const out: NestedItem = { ...item, params };
  if (!Object.keys(params).length) delete out.params;
  return out;
}

/**
 * Where an unbound child param gets its value: this genus's same-named
 * param, else the child's default (the core's rule).
 */
export function bindingSource(param: string, ownParams: string[]): 'same' | 'default' {
  return ownParams.includes(param) ? 'same' : 'default';
}

// —— Mirror about a plane ref ——————————————————————————————————————

/** `2·plane − f`: the formula mirrored about plane ref `ref`. */
export function mirrorFormula(f: GenusFormula, ref: string): GenusFormula {
  const plane = `${REF_PREFIX}${ref}`;
  if (typeof f === 'number') return f === 0 ? `2 * ${plane}` : f < 0 ? `2 * ${plane} + ${-f}` : `2 * ${plane} - ${f}`;
  const s = formulaString(f).trim();
  return /^[\w.]+$/.test(s) ? `2 * ${plane} - ${s}` : `2 * ${plane} - (${s})`;
}

const neg = (f: GenusFormula): GenusFormula => (typeof f === 'number' ? -f : `-(${formulaString(f)})`);

function mirrorSketch(items: GenusSketchItemDto[], c: 0 | 1, ref: string): GenusSketchItemDto[] {
  const m = (q: GenusVec2): GenusVec2 => (c === 0 ? [mirrorFormula(q[0], ref), q[1]] : [q[0], mirrorFormula(q[1], ref)]);
  return items.map((it) => {
    if (it.kind === 'circle') return { ...it, c: m(it.c) };
    if (it.kind === 'arc') return { ...it, a: m(it.a), b: m(it.b), bulge: neg(it.bulge) };
    return { ...it, a: m(it.a), b: m(it.b) };
  });
}

/** Why an item cannot be mirrored about a plane of that normal (catalog key genusEditor.mirror.no.<code>). */
export type MirrorBlock = 'shape' | 'vertical' | 'on' | null;

export function mirrorBlock(b: GenusBodyItemDto, normal: GenusAxis): MirrorBlock {
  if (b.item === 'nested') return normal === 'y' ? 'vertical' : null;
  if (b.shape === 'box') return null;
  if (b.shape === 'prism') return b.on ? 'on' : null;
  return 'shape';
}

/**
 * A mirrored copy of `b` (new id) about plane ref `ref` with `normal`, or
 * null when it cannot be mirrored (see [`mirrorBlock`]). Coordinates become
 * `2·ref − f` formulas, so the copy follows the plane when it moves.
 */
export function mirrorItem(b: GenusBodyItemDto, id: string, ref: string, normal: GenusAxis): GenusBodyItemDto | null {
  if (mirrorBlock(b, normal)) return null;
  const k = axisIndex(normal);
  if (b.item === 'nested') {
    const off: GenusVec3 = [...(b.offset ?? [0, 0, 0])] as GenusVec3;
    const pos = AXES.map((a, i): GenusFormula => {
      if (!b.at) return off[i];
      const base = `${REF_PREFIX}${b.at}.${a}`;
      const o = off[i];
      return o === 0 ? base : `${base} + ${typeof o === 'number' && o < 0 ? `(${o})` : formulaString(o)}`;
    }) as GenusVec3;
    pos[k] = mirrorFormula(pos[k], ref);
    const rot = b.rotation ?? 0;
    // Reflection across x: yaw → −yaw; across z (= 180° turn · x reflection): yaw → 180 − yaw.
    const rotation: GenusFormula =
      normal === 'x' ? neg(rot) : typeof rot === 'number' ? 180 - rot : `180 - (${formulaString(rot)})`;
    const out: NestedItem = { ...b, id, offset: pos, rotation, mirror: !b.mirror };
    delete out.at;
    if (out.rotation === 0 || out.rotation === -0) delete out.rotation;
    if (!out.mirror) delete out.mirror;
    return out;
  }
  if (b.shape === 'box') {
    const min = [...b.min] as GenusVec3;
    const max = [...b.max] as GenusVec3;
    min[k] = mirrorFormula(b.max[k], ref);
    max[k] = mirrorFormula(b.min[k], ref);
    return { ...b, id, min, max };
  }
  if (b.shape === 'prism') {
    const n = b.normal ?? 'z';
    if (n === normal) return { ...b, id, depth: [mirrorFormula(b.depth[1], ref), mirrorFormula(b.depth[0], ref)] };
    const c = (planeAxes(n)[0] === k ? 0 : 1) as 0 | 1;
    const out = { ...b, id };
    if (b.sketch) out.sketch = mirrorSketch(b.sketch, c, ref);
    if (b.loops?.length) {
      out.loops = b.loops.map((l) =>
        l.map((q): GenusVec2 => (c === 0 ? [mirrorFormula(q[0], ref), q[1]] : [q[0], mirrorFormula(q[1], ref)])).reverse(),
      );
    }
    return out;
  }
  return null;
}
