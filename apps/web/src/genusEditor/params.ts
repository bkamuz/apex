/**
 * Genus editor: parameters and species (pure; unit tested).
 *
 * The param table merges what the genus inherits (`extends`) with what the
 * draft declares. Editing an inherited param redeclares it in the draft
 * (an override, as the core allows); "reset" drops the override. Species are
 * edited in the editor and written on Save in one batch with define_genus.
 */
import type { ParamSpecDto, ParamValue } from '../types';
import { evalAst, namesInJson, parseFormula, type Ast, type FormulaError } from './formula.ts';
import { paramInputFromSpec, type GenusDraft, type GenusParamInput } from './model.ts';

export type ParamKindInput = NonNullable<GenusParamInput['kind']>;
export const PARAM_KINDS: ParamKindInput[] = ['length', 'number', 'bool', 'text'];

/** Where a param's value is set: by the genus (formula), per species, per instance. */
export type ParamSource = 'genus' | 'species' | 'instance';

export interface ParamRow {
  id: string;
  /** Effective definition (own declaration, else the parent's). */
  input: GenusParamInput;
  /** Declared by the parent genus. */
  inherited: boolean;
  /** Inherited and redeclared in this draft. */
  overridden: boolean;
  /** The parent's kind is not editable here (choice, profile, angle …). */
  locked: boolean;
}

/** Params the core injects while building, and formula words: not usable as ids. */
const RESERVED = new Set(['species', 'host_depth', 'length', 'true', 'false', 'min', 'max', 'if', 'and', 'or', 'not']);
const EDITABLE_KINDS = new Set(['length', 'number', 'bool', 'text']);

export function kindOf(input: GenusParamInput): ParamKindInput {
  return input.kind ?? 'length';
}

export function sourceOf(input: GenusParamInput): ParamSource {
  if (input.formula) return 'genus';
  return input.species ? 'species' : 'instance';
}

/** Parent specs as rows (the `species` choice param is the species picker, not a row). */
function parentRows(parentSpecs: ParamSpecDto[]): ParamRow[] {
  return parentSpecs
    .filter((s) => s.id !== 'species')
    .map((s) => ({
      id: s.id,
      input: paramInputFromSpec(s),
      inherited: true,
      overridden: false,
      locked: !EDITABLE_KINDS.has(s.kind),
    }));
}

/** All params of a draft: inherited first (in the parent's order), then own. */
export function paramRows(draft: GenusDraft, parentSpecs: ParamSpecDto[]): ParamRow[] {
  const rows = draft.extends ? parentRows(parentSpecs) : [];
  for (const p of draft.params) {
    const slot = rows.find((r) => r.id === p.id);
    if (slot) {
      slot.input = p;
      slot.overridden = true;
    } else {
      rows.push({ id: p.id, input: p, inherited: false, overridden: false, locked: false });
    }
  }
  return rows;
}

function withParams(draft: GenusDraft, params: GenusParamInput[]): GenusDraft {
  return { ...draft, params };
}

/** Drop keys that do not apply to the kind / binding (the core rejects some). */
export function cleanInput(p: GenusParamInput): GenusParamInput {
  const out: GenusParamInput = { id: p.id, default: p.default };
  if (p.label && p.label !== p.id) out.label = p.label;
  const kind = kindOf(p);
  if (kind !== 'length') out.kind = kind;
  const numeric = kind === 'length' || kind === 'number';
  if (numeric && typeof p.min === 'number' && Number.isFinite(p.min)) out.min = p.min;
  if (numeric && typeof p.max === 'number' && Number.isFinite(p.max)) out.max = p.max;
  if (p.group) out.group = p.group;
  const formula = p.formula?.trim();
  if (formula && kind !== 'text') out.formula = formula;
  else if (p.species) out.species = true;
  return out;
}

/** The default a kind starts with. */
export function defaultFor(kind: ParamKindInput): ParamValue {
  if (kind === 'bool') return false;
  if (kind === 'text') return '';
  return kind === 'length' ? 0.5 : 1;
}

/** Coerce a default to a kind (kind changes keep what still fits). */
export function coerceDefault(value: ParamValue, kind: ParamKindInput): ParamValue {
  if (kind === 'bool') return typeof value === 'boolean' ? value : Boolean(value);
  if (kind === 'text') return typeof value === 'string' ? value : String(value);
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : defaultFor(kind);
}

/** Patch a param; an inherited one becomes an override. */
export function setParam(draft: GenusDraft, rows: ParamRow[], id: string, patch: Partial<GenusParamInput>): GenusDraft {
  const row = rows.find((r) => r.id === id);
  if (!row || row.locked) return draft;
  let next: GenusParamInput = { ...row.input, ...patch, id };
  if (patch.kind && patch.kind !== kindOf(row.input)) {
    next = { ...next, default: coerceDefault(next.default, patch.kind) };
  }
  next = cleanInput(next);
  const own = draft.params.some((p) => p.id === id);
  return withParams(draft, own ? draft.params.map((p) => (p.id === id ? next : p)) : [...draft.params, next]);
}

/** First free `param_N` id. */
export function nextParamId(rows: ParamRow[], base = 'param'): string {
  const used = new Set(rows.map((r) => r.id));
  let n = 1;
  while (used.has(`${base}_${n}`)) n += 1;
  return `${base}_${n}`;
}

export function addParam(draft: GenusDraft, rows: ParamRow[], kind: ParamKindInput = 'length', label?: string): { draft: GenusDraft; id: string } {
  const id = nextParamId(rows);
  const p = cleanInput({ id, label, kind, default: defaultFor(kind), group: 'other' });
  return { draft: withParams(draft, [...draft.params, p]), id };
}

/** Delete an own param, or reset an override back to the inherited one. */
export function deleteParam(draft: GenusDraft, id: string): GenusDraft {
  return withParams(draft, draft.params.filter((p) => p.id !== id));
}

/** Rename an own param (species values move with it). Overrides keep the parent id. */
export function renameParam(
  draft: GenusDraft,
  species: DraftSpecies[],
  rows: ParamRow[],
  from: string,
  to: string,
): { draft: GenusDraft; species: DraftSpecies[] } {
  const row = rows.find((r) => r.id === from);
  if (!row || row.inherited || from === to) return { draft, species };
  return {
    draft: withParams(draft, draft.params.map((p) => (p.id === from ? { ...p, id: to } : p))),
    species: species.map((s) => {
      if (!(from in s.values)) return s;
      const values = { ...s.values, [to]: s.values[from] };
      delete values[from];
      return { ...s, values };
    }),
  };
}

/** Param ids read by the draft's own body, refs and dims (cannot be deleted). */
export function usedByGeometry(draft: GenusDraft): Set<string> {
  return namesInJson([draft.body, draft.refs, draft.dims]);
}

// —— Validation ————————————————————————————————————————————————————

export interface ParamIssue {
  field: 'id' | 'default' | 'min' | 'max' | 'formula';
  /** Catalog key suffix: genusEditor.issue.<code>. */
  code: string;
  detail?: Record<string, string | number>;
  /** Formula syntax error (its own message set). */
  formula?: FormulaError;
}

export const ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Problems per param id (empty map = all valid). */
export function validateParams(rows: ParamRow[]): Map<string, ParamIssue[]> {
  const out = new Map<string, ParamIssue[]>();
  const add = (id: string, issue: ParamIssue) => {
    const list = out.get(id) ?? [];
    list.push(issue);
    out.set(id, list);
  };
  const seen = new Map<string, number>();
  for (const r of rows) seen.set(r.id, (seen.get(r.id) ?? 0) + 1);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const formulas = new Map<string, string[]>();
  for (const r of rows) {
    const p = r.input;
    if (!r.inherited) {
      if (!r.id) add(r.id, { field: 'id', code: 'idEmpty' });
      else if (!ID_PATTERN.test(r.id)) add(r.id, { field: 'id', code: 'idChars' });
      else if (RESERVED.has(r.id)) add(r.id, { field: 'id', code: 'idReserved', detail: { id: r.id } });
      if ((seen.get(r.id) ?? 0) > 1) add(r.id, { field: 'id', code: 'idDuplicate', detail: { id: r.id } });
    }
    const kind = kindOf(p);
    const numeric = kind === 'length' || kind === 'number';
    if (numeric && typeof p.min === 'number' && typeof p.max === 'number' && p.min > p.max) {
      add(r.id, { field: 'max', code: 'minMax' });
    }
    if (numeric && !p.formula) {
      const d = typeof p.default === 'number' ? p.default : NaN;
      if (!Number.isFinite(d)) add(r.id, { field: 'default', code: 'notNumber' });
      else if ((typeof p.min === 'number' && d < p.min) || (typeof p.max === 'number' && d > p.max)) {
        add(r.id, { field: 'default', code: 'outOfRange' });
      }
    }
    if (p.formula) {
      if (kind === 'text') {
        add(r.id, { field: 'formula', code: 'formulaText' });
        continue;
      }
      const parsed = parseFormula(p.formula);
      if (!parsed.ok) {
        add(r.id, { field: 'formula', code: 'formula', formula: parsed.error });
        continue;
      }
      for (const ref of parsed.refs) {
        const dep = byId.get(ref);
        if (!dep) add(r.id, { field: 'formula', code: 'formula', formula: { code: 'unknown', detail: { id: ref } } });
        else if (kindOf(dep.input) === 'text' || dep.locked) {
          add(r.id, { field: 'formula', code: 'formula', formula: { code: 'text', detail: { id: ref } } });
        }
      }
      formulas.set(r.id, parsed.refs);
    }
  }
  for (const cycle of formulaCycles(formulas)) {
    for (const id of new Set(cycle)) {
      add(id, { field: 'formula', code: 'formula', formula: { code: 'cycle', detail: { ids: cycle.join(' → ') } } });
    }
  }
  return out;
}

/** Params whose formulas depend on themselves (each cycle once, closed: a → b → a). */
function formulaCycles(deps: Map<string, string[]>): string[][] {
  const cycles: string[][] = [];
  const done = new Set<string>();
  const stack: string[] = [];
  const visit = (id: string) => {
    const at = stack.indexOf(id);
    if (at >= 0) {
      const cycle = stack.slice(at);
      if (!cycles.some((c) => c.length === cycle.length + 1 && cycle.every((x) => c.includes(x)))) cycles.push([...cycle, id]);
      return;
    }
    if (done.has(id) || !deps.has(id)) return;
    stack.push(id);
    for (const d of deps.get(id) ?? []) visit(d);
    stack.pop();
    done.add(id);
  };
  for (const id of deps.keys()) visit(id);
  return cycles;
}

// —— Species ——————————————————————————————————————————————————————

export interface DraftSpecies {
  id: string;
  name: string;
  /** Values of the species-bound params. */
  values: Record<string, ParamValue>;
}

/** Ids of params set per species (formulas never are). */
export function speciesParamIds(rows: ParamRow[]): string[] {
  return rows.filter((r) => r.input.species && !r.input.formula).map((r) => r.id);
}

function slug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[×x*]/g, 'x')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** A free species id under the genus (`user.window.wide`, else `…species-2`). */
export function nextSpeciesId(genusId: string, name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const raw = slug(name);
  // Names without Latin letters ("Вид 4") get a neutral id.
  const s = /[a-z]/.test(raw) ? raw : '';
  const base = `${genusId}.${s || 'species'}`;
  if (!used.has(base) && s) return base;
  let n = 2;
  while (used.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

/** Defaults of the species-bound params. */
export function speciesDefaults(rows: ParamRow[]): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {};
  for (const id of speciesParamIds(rows)) out[id] = rows.find((r) => r.id === id)!.input.default;
  return out;
}

export function addSpecies(
  genusId: string,
  list: DraftSpecies[],
  rows: ParamRow[],
  name: string,
  from?: DraftSpecies,
): { species: DraftSpecies[]; id: string } {
  const id = nextSpeciesId(genusId, name, list.map((s) => s.id));
  const values = { ...speciesDefaults(rows), ...(from?.values ?? {}) };
  return { species: [...list, { id, name, values }], id };
}

export function renameSpecies(list: DraftSpecies[], id: string, name: string): DraftSpecies[] {
  return list.map((s) => (s.id === id ? { ...s, name } : s));
}

export function deleteSpecies(list: DraftSpecies[], id: string): DraftSpecies[] {
  return list.filter((s) => s.id !== id);
}

export function setSpeciesValue(list: DraftSpecies[], id: string, param: string, value: ParamValue): DraftSpecies[] {
  return list.map((s) => (s.id === id ? { ...s, values: { ...s.values, [param]: value } } : s));
}

/** Values a species sends: its own for species-bound params, else defaults. */
export function speciesValues(rows: ParamRow[], species: DraftSpecies | null): Record<string, ParamValue> {
  const out = speciesDefaults(rows);
  if (species) for (const id of Object.keys(out)) if (id in species.values) out[id] = species.values[id];
  return out;
}

/**
 * Every param's value for one species (or the defaults): defaults, then the
 * species' values, then formulas in dependency order. NaN for a formula
 * that cannot be evaluated.
 */
export function resolvedValues(rows: ParamRow[], species: DraftSpecies | null): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {};
  for (const r of rows) out[r.id] = r.input.default;
  Object.assign(out, speciesValues(rows, species));
  const pending = new Map<string, { ast: Ast; refs: string[]; kind: ParamKindInput }>();
  for (const r of rows) {
    if (!r.input.formula) continue;
    const parsed = parseFormula(r.input.formula);
    if (parsed.ok) pending.set(r.id, { ast: parsed.ast, refs: parsed.refs, kind: kindOf(r.input) });
    else out[r.id] = NaN;
  }
  while (pending.size) {
    const ready = [...pending.entries()].find(([, f]) => !f.refs.some((d) => pending.has(d)));
    if (!ready) {
      for (const id of pending.keys()) out[id] = NaN;
      break;
    }
    const [id, f] = ready;
    const v = evalAst(f.ast, out);
    out[id] = f.kind === 'bool' ? v !== 0 && !Number.isNaN(v) : v;
    pending.delete(id);
  }
  return out;
}

export function speciesKey(list: DraftSpecies[]): string {
  return JSON.stringify(list.map((s) => [s.id, s.name, Object.entries(s.values).sort(([a], [b]) => a.localeCompare(b))]));
}

/**
 * Commands that bring the registered species of `genusId` from `saved` to
 * `current`: create_species (an upsert by id) for new / changed ones,
 * delete_species for removed ones.
 */
export function speciesCommands(genusId: string, saved: DraftSpecies[], current: DraftSpecies[], rows: ParamRow[]): Record<string, unknown>[] {
  const ids = speciesParamIds(rows);
  const pick = (s: DraftSpecies) => Object.fromEntries(ids.filter((id) => id in s.values).map((id) => [id, s.values[id]]));
  const key = (s: DraftSpecies) => JSON.stringify([s.name, Object.entries(pick(s)).sort(([a], [b]) => a.localeCompare(b))]);
  const out: Record<string, unknown>[] = [];
  for (const s of saved) {
    if (!current.some((c) => c.id === s.id)) out.push({ op: 'delete_species', id: s.id });
  }
  if (ids.length === 0) return out;
  for (const s of current) {
    const before = saved.find((x) => x.id === s.id);
    if (before && key(before) === key(s)) continue;
    out.push({ op: 'create_species', genus: genusId, id: s.id, name: s.name || s.id, params: pick(s) });
  }
  return out;
}

/** Copy a parent's species for a new derived genus (ids moved under it). */
export function copySpecies(
  genusId: string,
  parentSpecies: { id: string; name: string; default?: boolean; values?: Record<string, unknown> }[],
  nameOf: (row: { id: string; name: string }) => string,
): DraftSpecies[] {
  const out: DraftSpecies[] = [];
  // The parent's default species first: it is the one the views open on.
  const ordered = [...parentSpecies].sort((a, b) => Number(Boolean(b.default)) - Number(Boolean(a.default)));
  for (const row of ordered) {
    const tail = row.id.split('.').pop() ?? 'species';
    let id = `${genusId}.${tail}`;
    let n = 2;
    while (out.some((s) => s.id === id)) id = `${genusId}.${tail}-${n++}`;
    const values: Record<string, ParamValue> = {};
    for (const [k, v] of Object.entries(row.values ?? {})) {
      if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') values[k] = v;
    }
    out.push({ id, name: nameOf(row), values });
  }
  return out;
}

/** Group key a row is listed under. */
export function groupOf(input: GenusParamInput): string {
  if (input.group) return input.group;
  // Ungrouped (built-in) params: lengths read as dimensions.
  return kindOf(input) === 'length' && !input.formula ? 'dimensions' : 'other';
}
