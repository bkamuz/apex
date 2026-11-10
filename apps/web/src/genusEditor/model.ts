/**
 * Genus editor mode: pure data model (no React, no WASM).
 *
 * A *draft* is the define_genus payload being edited. Opening an existing
 * user genus copies its authored body; "Create based on" starts an empty draft
 * that `extends` a built-in. The structure tree, dirty check and the
 * preview_genus request are derived from the draft here so they can be unit
 * tested without a browser.
 */
import type {
  ComponentDto,
  GenusBodyItemDto,
  GenusDefDto,
  GenusDimDto,
  GenusPlacementDto,
  GenusRefDto,
  ParamSpecDto,
  ParamValue,
} from '../types';

/** What the editor was opened on. */
export type GenusEditorTarget =
  | { kind: 'edit'; genusId: string }
  | { kind: 'derive'; baseId: string };

/** One define_genus param (the core's `GenusParamInput`). */
export interface GenusParamInput {
  id: string;
  label?: string;
  kind?: 'length' | 'number' | 'text' | 'bool';
  default: ParamValue;
  min?: number;
  max?: number;
  species?: boolean;
  group?: string;
  /** Computed param: its value is this formula over other params. */
  formula?: string;
}

/** The define_genus payload being edited (no `op`). */
export interface GenusDraft {
  id: string;
  name: string;
  category?: string;
  purpose?: string;
  extends?: string;
  placement?: GenusPlacementDto;
  params: GenusParamInput[];
  refs: GenusRefDto[];
  body: GenusBodyItemDto[];
  dims: GenusDimDto[];
  remove: string[];
}

/** `get_genus` result, the fields the editor reads. */
export interface GetGenusDto {
  id: string;
  name: string;
  category?: string;
  built_in?: boolean;
  authored?: GenusDefDto | null;
  resolved?: GenusDefDto | null;
  /** Param provenance: `from` = the genus that declares it. */
  params?: { id: string; from?: string; source?: string }[];
}

/** Built-in genera are read-only; their `genus` body can still be viewed. */
export function isBuiltIn(component: ComponentDto): boolean {
  return component.source === 'built_in';
}

/** Genera the editor mode can open: those with a universal genus body. */
export function isGenusComponent(component: ComponentDto): boolean {
  return Boolean(component.genus) && component.category !== 'genus-part';
}

const PARAM_KINDS = new Set(['length', 'number', 'text', 'bool']);

/** A component param spec as a define_genus param (the core rejects extra keys). */
export function paramInputFromSpec(spec: ParamSpecDto): GenusParamInput {
  const kind = PARAM_KINDS.has(spec.kind) ? (spec.kind as GenusParamInput['kind']) : 'number';
  const out: GenusParamInput = { id: spec.id, default: spec.default };
  if (spec.label && spec.label !== spec.id) out.label = spec.label;
  if (kind !== 'length') out.kind = kind;
  if (typeof spec.min === 'number') out.min = spec.min;
  if (typeof spec.max === 'number') out.max = spec.max;
  if (spec.binding === 'type') out.species = true;
  if (spec.group) out.group = spec.group;
  if (spec.formula) {
    out.formula = spec.formula;
    delete out.species;
  }
  return out;
}

/**
 * Draft for an existing user genus: its authored body and the params it
 * declares itself (`own`: ids from get_genus provenance; all when unknown).
 */
export function draftFromGenus(
  component: ComponentDto,
  authored: GenusDefDto | null | undefined,
  own?: Iterable<string>,
): GenusDraft {
  const g = authored ?? component.genus ?? { body: [] };
  const ownIds = own ? new Set(own) : null;
  return {
    id: component.id,
    name: component.display_name,
    category: component.category || undefined,
    purpose: component.descriptor?.purpose || undefined,
    extends: g.extends,
    placement: g.placement,
    // `species` is the choice param the core adds to typed genera.
    params: component.params
      .filter((p) => p.id !== 'species' && (!ownIds || ownIds.has(p.id)))
      .map(paramInputFromSpec),
    refs: [...(g.refs ?? [])],
    body: [...(g.body ?? [])],
    dims: [...(g.dims ?? [])],
    remove: [...(g.remove ?? [])],
  };
}

/** First free `user.<base>` id (`user.window`, `user.window.2`, …). */
export function nextDerivedId(baseId: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const tail = baseId.replace(/^(apex|user)\./, '');
  const prefix = `user.${tail || 'genus'}`;
  if (!used.has(prefix)) return prefix;
  let n = 2;
  while (used.has(`${prefix}.${n}`)) n += 1;
  return `${prefix}.${n}`;
}

/** Empty draft extending `base` ("Create based on"). */
export function deriveDraft(base: ComponentDto, taken: Iterable<string>, name: string): GenusDraft {
  return {
    id: nextDerivedId(base.id, taken),
    name,
    category: base.category || undefined,
    extends: base.id,
    params: [],
    refs: [],
    body: [],
    dims: [],
    remove: [],
  };
}

/** The define_genus command for a draft (empty lists dropped). */
export function defineGenusCommand(draft: GenusDraft): Record<string, unknown> {
  const out: Record<string, unknown> = { op: 'define_genus', id: draft.id, name: draft.name };
  if (draft.category) out.category = draft.category;
  if (draft.purpose) out.purpose = draft.purpose;
  if (draft.extends) out.extends = draft.extends;
  if (draft.placement) out.placement = draft.placement;
  if (draft.params.length) out.params = draft.params;
  if (draft.refs.length) out.refs = draft.refs;
  out.body = draft.body;
  if (draft.dims.length) out.dims = draft.dims;
  if (draft.remove.length) out.remove = draft.remove;
  return out;
}

export interface PreviewOptions {
  species?: string | null;
  /** Unsaved species values (the species matrix column being previewed). */
  speciesValues?: Record<string, ParamValue> | null;
  hostDepth?: number;
  length?: number;
}

/** preview_genus request for a draft (no `op`; see apexPreviewGenus). */
export function previewRequest(draft: GenusDraft, opts: PreviewOptions = {}): Record<string, unknown> {
  const { op: _op, ...fields } = defineGenusCommand(draft);
  void _op;
  const out: Record<string, unknown> = { ...fields };
  if (opts.species) out.species = opts.species;
  if (opts.speciesValues && Object.keys(opts.speciesValues).length) out.species_values = opts.speciesValues;
  if (opts.hostDepth !== undefined) out.host_depth = opts.hostDepth;
  if (opts.length !== undefined) out.length = opts.length;
  return out;
}

/** Stable text of a draft, for the unsaved-changes check. */
export function draftKey(draft: GenusDraft): string {
  return JSON.stringify(defineGenusCommand(draft));
}

// —— Structure tree ——————————————————————————————————————————————

export type TreeItemKind = 'ref' | 'solid' | 'cut' | 'nested' | 'host';

export interface TreeItem {
  /** Item / ref id (unique within its section). */
  id: string;
  kind: TreeItemKind;
  /** Shape / ref kind / nested genus id, for the secondary label. */
  detail: string;
  /** Show-condition formula text, if any. */
  visible?: string;
  /** Cut targets summary: `host`, `self`, `neighbours`. */
  targets?: string[];
  /** From `extends` (not authored in this genus). */
  inherited: boolean;
  /** Listed in `remove` (inherited, dropped here). */
  removed?: boolean;
  /** Authored here with the id of a parent item (overrides it). */
  overrides?: boolean;
}

export interface GenusTree {
  refs: TreeItem[];
  body: TreeItem[];
  inherited: TreeItem[];
  /** Genus the inherited section comes from. */
  inheritedFrom: string | null;
}

function formulaText(f: unknown): string {
  return typeof f === 'number' ? String(f) : String(f ?? '');
}

export function refItem(ref: GenusRefDto, inherited: boolean): TreeItem {
  let detail: string = ref.ref;
  if (ref.ref === 'plane') detail = `plane ${ref.normal ?? 'y'}`;
  return { id: ref.id, kind: 'ref', detail, inherited };
}

export function bodyItem(item: GenusBodyItemDto, inherited: boolean): TreeItem {
  const visible = item.visible !== undefined ? formulaText(item.visible) : undefined;
  if (item.item === 'nested') {
    return { id: item.id, kind: 'nested', detail: item.genus, visible, inherited };
  }
  const detail = 'shape' in item ? String(item.shape) : '';
  if (item.item === 'cut') {
    const t = item.targets ?? {};
    const targets: string[] = [];
    if (t.host) targets.push('host');
    if (t.self) targets.push('self');
    if (t.neighbours) targets.push('neighbours');
    return { id: item.id, kind: 'cut', detail, visible, targets, inherited };
  }
  return { id: item.id, kind: 'solid', detail, visible, inherited };
}

/**
 * Tree for a draft: own refs and body, then what `extends` brings in.
 * `parentResolved` is the parent's resolved body (get_genus of `extends`).
 */
export function buildTree(draft: GenusDraft, parentResolved: GenusDefDto | null | undefined): GenusTree {
  const ownRefIds = new Set(draft.refs.map((r) => r.id));
  const ownBodyIds = new Set(draft.body.map((b) => b.id));
  const removed = new Set(draft.remove);
  const parentRefs = parentResolved?.refs ?? [];
  const parentBody = parentResolved?.body ?? [];
  const parentIds = new Set([...parentRefs.map((r) => r.id), ...parentBody.map((b) => b.id)]);
  const refs = [
    ...draft.refs.map((r) => ({ ...refItem(r, false), overrides: parentIds.has(r.id) })),
    ...parentRefs
      .filter((r) => !ownRefIds.has(r.id))
      .map((r) => ({ ...refItem(r, true), removed: removed.has(r.id) })),
  ];
  const body = draft.body.map((b) => ({ ...bodyItem(b, false), overrides: parentIds.has(b.id) }));
  const inherited = parentBody
    .filter((b) => !ownBodyIds.has(b.id))
    .map((b) => ({ ...bodyItem(b, true), removed: removed.has(b.id) }));
  return {
    refs,
    body,
    inherited,
    inheritedFrom: draft.extends ?? null,
  };
}

/** Top-level body item a preview solid / cut path belongs to (`frame/part#0` → `frame`). */
export function topItemOfPath(path: string): string {
  const slash = path.indexOf('/');
  const head = slash >= 0 ? path.slice(0, slash) : path;
  const hash = head.indexOf('#');
  return hash >= 0 ? head.slice(0, hash) : head;
}

// —— Test host ——————————————————————————————————————————————————

export interface TestHost {
  /** Host category (`wall`, `fence`, …). */
  category: string;
  /** Thickness across (z), metres. */
  depth: number;
  /** Height, metres. */
  height: number;
}

const HOST_DEPTH: Record<string, number> = { wall: 0.25, fence: 0.1 };
const HOST_HEIGHT: Record<string, number> = { wall: 3.0, fence: 1.8 };

/** A sample host for host-placed genera (a 250 mm wall for windows and doors). */
export function testHostFor(placement: GenusPlacementDto | null | undefined): TestHost | null {
  if (!placement || placement.kind !== 'host') return null;
  const category = placement.categories[0] ?? 'wall';
  return {
    category,
    depth: HOST_DEPTH[category] ?? 0.2,
    height: HOST_HEIGHT[category] ?? 3.0,
  };
}

/** Resolved placement of a draft: its own, else the parent's, else point. */
export function effectivePlacement(
  draft: GenusDraft,
  parentResolved: GenusDefDto | null | undefined,
): GenusPlacementDto {
  return draft.placement ?? parentResolved?.placement ?? { kind: 'point' };
}
