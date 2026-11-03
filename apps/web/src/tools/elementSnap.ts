import type { Vec3 } from '../viewport/ViewportRenderer';
import type {
  ElementSnapGeometryDto,
  ElementSnapKindDto,
  ElementSnapTargetDto,
} from '../wasm/apex';
import type { ToolContext } from './Tool';

/** Screen tolerance (CSS px) for element snaps while placing / editing. */
export const ELEMENT_SNAP_PX = 22;

/** Prefer discrete kinds over edge when scores are close. */
function kindRank(kind: ElementSnapKindDto): number {
  switch (kind) {
    case 'end':
    case 'point':
      return 0;
    case 'vertex':
      return 1;
    case 'mid':
      return 2;
    case 'edge':
      return 3;
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

/** Element snap kinds plus the client-side crossing of two snappable lines. */
export type SnapHitKind = ElementSnapKindDto | 'intersection';

export interface ElementSnapHit {
  point: Vec3;
  kind: SnapHitKind;
  element_id: string;
  /** For `intersection`: the two crossing line owners. */
  other_element_id?: string;
}

/** User-facing snap groups toggled from the status bar. */
export type SnapGroup = 'end' | 'mid' | 'intersection' | 'edge';
export const SNAP_GROUPS: readonly SnapGroup[] = ['end', 'mid', 'intersection', 'edge'];
export type SnapFilter = Readonly<Record<SnapGroup, boolean>>;
export const ALL_SNAPS: SnapFilter = { end: true, mid: true, intersection: true, edge: true };

/** Status-bar group that governs a target kind (end covers vertices / points). */
export function snapGroupOf(kind: SnapHitKind): SnapGroup {
  switch (kind) {
    case 'mid':
      return 'mid';
    case 'edge':
      return 'edge';
    case 'intersection':
      return 'intersection';
    default:
      return 'end';
  }
}

const SNAP_FILTER_KEY = 'apex.snaps';

export function loadSnapFilter(storage?: Pick<Storage, 'getItem'>): SnapFilter {
  try {
    const raw = storage?.getItem(SNAP_FILTER_KEY);
    if (!raw) return ALL_SNAPS;
    const v = JSON.parse(raw) as Partial<Record<SnapGroup, unknown>>;
    const out = { ...ALL_SNAPS };
    for (const g of SNAP_GROUPS) if (typeof v[g] === 'boolean') out[g] = v[g] as boolean;
    return out;
  } catch {
    return ALL_SNAPS;
  }
}

export function saveSnapFilter(storage: Pick<Storage, 'setItem'> | undefined, f: SnapFilter): void {
  try {
    storage?.setItem(SNAP_FILTER_KEY, JSON.stringify(f));
  } catch {
    /* private mode */
  }
}

/** Max nearby lines considered for pairwise crossings (keeps k² tiny). */
const MAX_INTERSECTION_LINES = 12;

/**
 * Plan (XZ) crossing of segments a1→b1 and a2→b2. Null when parallel /
 * degenerate or when the crossing lies outside either segment (with a small
 * relative slop so crossings at segment ends still count). Y is lerped along
 * the first segment.
 */
export function intersectSegmentsXz(
  a1: Vec3,
  b1: Vec3,
  a2: Vec3,
  b2: Vec3,
  slop = 1e-4,
): Vec3 | null {
  const d1x = b1[0] - a1[0];
  const d1z = b1[2] - a1[2];
  const d2x = b2[0] - a2[0];
  const d2z = b2[2] - a2[2];
  const len1 = Math.hypot(d1x, d1z);
  const len2 = Math.hypot(d2x, d2z);
  if (len1 < 1e-6 || len2 < 1e-6) return null;
  const denom = d1x * d2z - d1z * d2x;
  // sin(angle) below ~0.5° → treat as parallel / collinear: no single crossing.
  if (Math.abs(denom) < 1e-2 * len1 * len2) return null;
  const ex = a2[0] - a1[0];
  const ez = a2[2] - a1[2];
  const t = (ex * d2z - ez * d2x) / denom;
  const u = (ex * d1z - ez * d1x) / denom;
  if (t < -slop || t > 1 + slop || u < -slop || u > 1 + slop) return null;
  return [a1[0] + d1x * t, a1[1] + (b1[1] - a1[1]) * t, a1[2] + d1z * t];
}

/**
 * Closest point on segment a→b to p in plan (XZ). Returns null for degenerate
 * segments. Y is lerped along the segment.
 */
export function closestOnSegmentXz(a: Vec3, b: Vec3, p: Vec3): { point: Vec3; t: number } | null {
  const abx = b[0] - a[0];
  const abz = b[2] - a[2];
  const lenSq = abx * abx + abz * abz;
  if (lenSq < 1e-10) return null;
  const apx = p[0] - a[0];
  const apz = p[2] - a[2];
  const t = Math.min(1, Math.max(0, (apx * abx + apz * abz) / lenSq));
  return {
    point: [a[0] + abx * t, a[1] + (b[1] - a[1]) * t, a[2] + abz * t],
    t,
  };
}

/**
 * Nearest element snap under the cursor in screen space. Discrete ends /
 * vertices / mids / points beat edge closest-points. Joinable peer ends are
 * already included in `geometry` from the core collector.
 */
export function findElementSnap(
  ctx: Pick<ToolContext, 'worldToClient'>,
  clientX: number,
  clientY: number,
  geometry: ElementSnapGeometryDto,
  cursorWorld: Vec3,
  tolerancePx = ELEMENT_SNAP_PX,
  filter: SnapFilter = ALL_SNAPS,
): ElementSnapHit | null {
  if (!filter.end && !filter.mid && !filter.intersection && !filter.edge) return null;
  let best: { hit: ElementSnapHit; score: number } | null = null;

  const consider = (target: ElementSnapTargetDto) => {
    if (!filter[snapGroupOf(target.kind)]) return;
    const screen = ctx.worldToClient(target.point);
    if (!screen) return;
    const dist = Math.hypot(screen[0] - clientX, screen[1] - clientY);
    if (dist > tolerancePx) return;
    const score = dist + kindRank(target.kind) * 0.01;
    if (best && score >= best.score) return;
    best = {
      hit: {
        point: [...target.point] as Vec3,
        kind: target.kind,
        element_id: target.element_id,
      },
      score,
    };
  };

  for (const target of geometry.points) {
    consider(target);
  }

  // Lines near the cursor (screen distance to their closest point), the only
  // candidates for crossings — a linear pass, then k² over a capped k.
  const near: { seg: (typeof geometry.segments)[number]; dist: number }[] = [];
  for (const seg of geometry.segments) {
    const closest = closestOnSegmentXz(seg.a, seg.b, cursorWorld);
    if (!closest) continue;
    const screen = ctx.worldToClient(closest.point);
    if (!screen) continue;
    const dist = Math.hypot(screen[0] - clientX, screen[1] - clientY);
    if (dist <= tolerancePx) near.push({ seg, dist });
  }
  if (filter.intersection && near.length >= 2) {
    near.sort((x, y) => x.dist - y.dist);
    if (near.length > MAX_INTERSECTION_LINES) near.length = MAX_INTERSECTION_LINES;
    let bestX: { hit: ElementSnapHit; dist: number } | null = null;
    for (let i = 0; i < near.length; i++) {
      for (let j = i + 1; j < near.length; j++) {
        const s1 = near[i].seg;
        const s2 = near[j].seg;
        const point = intersectSegmentsXz(s1.a, s1.b, s2.a, s2.b);
        if (!point) continue;
        const screen = ctx.worldToClient(point);
        if (!screen) continue;
        const dist = Math.hypot(screen[0] - clientX, screen[1] - clientY);
        if (dist > tolerancePx) continue;
        if (bestX && dist >= bestX.dist) continue;
        bestX = {
          hit: { point, kind: 'intersection', element_id: s1.element_id, other_element_id: s2.element_id },
          dist,
        };
      }
    }
    // A crossing beats any single-line edge snap; a discrete end / vertex /
    // mid wins only when it is clearly closer (e.g. a wall end at the crossing).
    if (bestX) {
      const discrete = best as { hit: ElementSnapHit; score: number } | null;
      if (discrete && discrete.score < bestX.dist - 2) return discrete.hit;
      return bestX.hit;
    }
  }

  if (!filter.edge) return (best as { hit: ElementSnapHit } | null)?.hit ?? null;
  for (const seg of geometry.segments) {
    const closest = closestOnSegmentXz(seg.a, seg.b, cursorWorld);
    if (!closest) continue;
    // Endpoints are covered by discrete End/Vertex/Point targets.
    if (closest.t < 0.05 || closest.t > 0.95) continue;
    const screen = ctx.worldToClient(closest.point);
    if (!screen) continue;
    const dist = Math.hypot(screen[0] - clientX, screen[1] - clientY);
    if (dist > tolerancePx) continue;
    const score = dist + kindRank('edge') * 0.01;
    if (best && score >= best.score) continue;
    best = {
      hit: {
        point: closest.point,
        kind: 'edge',
        element_id: seg.element_id,
      },
      score,
    };
  }

  return best?.hit ?? null;
}

export function snapKindLabel(kind: SnapHitKind): string {
  switch (kind) {
    case 'intersection':
      return 'intersection';
    case 'end':
      return 'end';
    case 'mid':
      return 'mid';
    case 'vertex':
      return 'vertex';
    case 'point':
      return 'point';
    case 'edge':
      return 'edge';
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}
