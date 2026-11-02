// Pure inspector logic (no React): grouping, numeric validation, provenance
// lookup and multi-selection merge. Unit-tested in tests/inspector-model.test.ts.
import type { ParamSpecDto, ParamValue } from '../../types';

/** Section order, top to bottom — the same for every element kind. */
export const GROUP_ORDER = [
  'identity',
  'constraints',
  'dimensions',
  'materials',
  'genus',
  'analytics',
] as const;
export type GroupId = (typeof GROUP_ORDER)[number];

const IDENTITY = /^(name|mark|label|comments?|description|number)$/;
const CONSTRAINT =
  /(^allow_join|^join|^attach|_to$|targets?$|^justif|offset|^sill$|elevation|^rotation$|^flip|^host|^level|^base_|^top_|^location_line$|^reference$|^plane$)/;
const MATERIAL = /(material|colou?r|finish|appearance|texture|^shape$)/;
const ANALYTICS = /(^ifc|^export|^analytic|fire|thermal|u_value|^load|acoustic|^phase)/;

/**
 * Which section a param belongs to. `userGenus` sends the leftovers of a
 * user-authored genus to its own "Genus parameters" section.
 */
export function groupForSpec(spec: ParamSpecDto, userGenus = false): GroupId {
  const id = spec.id;
  if (IDENTITY.test(id) && spec.kind === 'text') return 'identity';
  if (ANALYTICS.test(id)) return 'analytics';
  if (CONSTRAINT.test(id) || spec.kind === 'reference') return 'constraints';
  if (spec.kind === 'profile' || MATERIAL.test(id)) return 'materials';
  if (userGenus) return 'genus';
  if (spec.kind === 'length' || spec.kind === 'angle' || spec.kind === 'number') return 'dimensions';
  if (spec.kind === 'bool') return 'constraints';
  return 'genus';
}

/** Group specs in section order, keeping declaration order inside a section. */
export function groupSpecs(
  specs: ParamSpecDto[],
  userGenus = false,
): { id: GroupId; specs: ParamSpecDto[] }[] {
  const buckets = new Map<GroupId, ParamSpecDto[]>();
  for (const spec of specs) {
    const g = groupForSpec(spec, userGenus);
    buckets.set(g, [...(buckets.get(g) ?? []), spec]);
  }
  return GROUP_ORDER.filter((g) => buckets.has(g)).map((g) => ({ id: g, specs: buckets.get(g)! }));
}

/** Display unit for a numeric spec (`m` for lengths unless the spec says otherwise). */
export function unitFor(spec: ParamSpecDto): string | null {
  if (spec.unit) return spec.unit;
  if (spec.kind === 'length') return 'm';
  if (spec.kind === 'angle') return 'rad';
  return null;
}

export type NumberCheck =
  | { ok: true; value: number }
  | { ok: false; reason: 'empty' | 'nan' | 'min' | 'max'; limit?: number };

/** Validate typed numeric input against the spec's range. Never yields NaN. */
export function checkNumber(text: string, spec: Pick<ParamSpecDto, 'min' | 'max'>): NumberCheck {
  const trimmed = text.trim().replace(',', '.');
  if (trimmed === '') return { ok: false, reason: 'empty' };
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return { ok: false, reason: 'nan' };
  if (spec.min != null && value < spec.min - 1e-12) return { ok: false, reason: 'min', limit: spec.min };
  if (spec.max != null && value > spec.max + 1e-12) return { ok: false, reason: 'max', limit: spec.max };
  return { ok: true, value };
}

/** Input step: centimetres for lengths, ~1° for angles, 1 for plain counts. */
export function stepFor(spec: ParamSpecDto): number {
  if (spec.kind === 'length') return 0.01;
  if (spec.kind === 'angle') return 0.0175;
  const ints = Number.isInteger(spec.default) && (spec.min == null || Number.isInteger(spec.min));
  return ints ? 1 : 0.01;
}

/** One row of the core `param_provenance` query. */
export interface ProvenanceRow {
  id: string;
  value: ParamValue;
  source: 'instance' | 'species' | 'genus' | 'inherited' | 'formula';
  from?: string;
  formula?: string;
}

export function provenanceIndex(rows: ProvenanceRow[] | null | undefined): Record<string, ProvenanceRow> {
  const out: Record<string, ProvenanceRow> = {};
  for (const row of rows ?? []) out[row.id] = row;
  return out;
}

/** An override can go back to the species / genus value. */
export function canReset(row: ProvenanceRow | undefined): boolean {
  return row?.source === 'instance' && row.id !== 'species' && row.id !== 'profile';
}

export const MIXED = Symbol('mixed');
export type MaybeMixed = ParamValue | typeof MIXED;

function same(a: ParamValue | undefined, b: ParamValue | undefined): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-9;
  return a === b;
}

/**
 * Params shared by every selected element (same id and kind). A value that
 * differs between elements comes back as {@link MIXED} (shown as "—").
 */
export function commonParams(
  items: { specs: ParamSpecDto[]; values: Record<string, ParamValue> }[],
): { spec: ParamSpecDto; value: MaybeMixed }[] {
  if (items.length === 0) return [];
  const [first, ...rest] = items;
  const out: { spec: ParamSpecDto; value: MaybeMixed }[] = [];
  for (const spec of first.specs) {
    const peers = rest.map((item) => item.specs.find((s) => s.id === spec.id && s.kind === spec.kind));
    if (peers.some((p) => !p)) continue;
    const v0 = first.values[spec.id] ?? spec.default;
    const mixed = rest.some((item, i) => !same(item.values[spec.id] ?? peers[i]!.default, v0));
    out.push({ spec, value: mixed ? MIXED : v0 });
  }
  return out;
}
