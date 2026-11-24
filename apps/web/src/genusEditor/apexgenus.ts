/**
 * `.apexgenus` — one genus per file.
 *
 * Version 1 is the genus body the editor already edits (params, species,
 * references, dimensions, sketches, solids, cuts, nested genera, mirror)
 * plus the species value sets. A newer `version` is refused.
 */
import type { ParamValue } from '../types';
import { defineGenusCommand, type GenusDraft } from './model.ts';

export const APEXGENUS_FORMAT = 'apexgenus';
export const APEXGENUS_VERSION = 1;

export interface ApexGenusSpecies {
  id: string;
  name: string;
  values: Record<string, ParamValue>;
}

export interface ApexGenusFile {
  format: typeof APEXGENUS_FORMAT;
  version: number;
  genus: GenusDraft;
  species: ApexGenusSpecies[];
}

export type GenusFileErrorCode =
  | 'notJson'
  | 'notObject'
  | 'format'
  | 'version'
  | 'versionNewer'
  | 'genus'
  | 'genusId'
  | 'genusName'
  | 'body'
  | 'placement'
  | 'species'
  | 'builtIn';

export type DecodeGenusResult =
  | { ok: true; file: ApexGenusFile }
  | { ok: false; code: GenusFileErrorCode; version?: number };

/** Built-in genera are read-only; a file may not replace one. */
export function isBuiltInGenusId(id: string): boolean {
  return id.startsWith('apex.');
}

export function genusFile(draft: GenusDraft, species: readonly ApexGenusSpecies[]): ApexGenusFile {
  const genus: GenusDraft = {
    id: draft.id,
    name: draft.name,
    params: draft.params,
    refs: draft.refs,
    body: draft.body,
    dims: draft.dims,
    remove: draft.remove,
  };
  if (draft.category) genus.category = draft.category;
  if (draft.purpose) genus.purpose = draft.purpose;
  if (draft.extends) genus.extends = draft.extends;
  if (draft.placement) genus.placement = draft.placement;
  return {
    format: APEXGENUS_FORMAT,
    version: APEXGENUS_VERSION,
    genus,
    species: species.map((s) => ({ id: s.id, name: s.name, values: { ...s.values } })),
  };
}

export function encodeGenusFile(draft: GenusDraft, species: readonly ApexGenusSpecies[]): string {
  return `${JSON.stringify(genusFile(draft, species), null, 2)}\n`;
}

function readSpecies(raw: unknown): ApexGenusSpecies[] | null {
  if (!Array.isArray(raw)) return null;
  const out: ApexGenusSpecies[] = [];
  for (const row of raw) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
    const rec = row as Record<string, unknown>;
    if (typeof rec.id !== 'string' || rec.id.length === 0) return null;
    if (typeof rec.name !== 'string') return null;
    if (!rec.values || typeof rec.values !== 'object' || Array.isArray(rec.values)) return null;
    const values: Record<string, ParamValue> = {};
    for (const [key, value] of Object.entries(rec.values as Record<string, unknown>)) {
      if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') values[key] = value;
      else return null;
    }
    out.push({ id: rec.id, name: rec.name, values });
  }
  return out;
}

function readDraft(raw: unknown): { draft: GenusDraft } | { code: GenusFileErrorCode } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { code: 'genus' };
  const g = raw as Record<string, unknown>;
  if (typeof g.id !== 'string' || g.id.trim() === '') return { code: 'genusId' };
  if (typeof g.name !== 'string' || g.name.trim() === '') return { code: 'genusName' };
  if (!Array.isArray(g.body)) return { code: 'body' };
  if (g.placement !== undefined && (typeof g.placement !== 'object' || g.placement === null || Array.isArray(g.placement))) {
    return { code: 'placement' };
  }
  const draft: GenusDraft = {
    id: g.id,
    name: g.name,
    params: Array.isArray(g.params) ? (g.params as GenusDraft['params']) : [],
    refs: Array.isArray(g.refs) ? (g.refs as GenusDraft['refs']) : [],
    body: g.body as GenusDraft['body'],
    dims: Array.isArray(g.dims) ? (g.dims as GenusDraft['dims']) : [],
    remove: Array.isArray(g.remove) ? g.remove.filter((id): id is string => typeof id === 'string') : [],
  };
  if (typeof g.category === 'string' && g.category) draft.category = g.category;
  if (typeof g.purpose === 'string' && g.purpose) draft.purpose = g.purpose;
  if (typeof g.extends === 'string' && g.extends) draft.extends = g.extends;
  if (g.placement && typeof g.placement === 'object') draft.placement = g.placement as GenusDraft['placement'];
  return { draft };
}

export function decodeGenusFile(text: string): DecodeGenusResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, code: 'notJson' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, code: 'notObject' };
  const rec = parsed as Record<string, unknown>;
  if (rec.format !== APEXGENUS_FORMAT) return { ok: false, code: 'format' };
  if (typeof rec.version !== 'number' || !Number.isInteger(rec.version) || rec.version < 1) {
    return { ok: false, code: 'version' };
  }
  if (rec.version > APEXGENUS_VERSION) return { ok: false, code: 'versionNewer', version: rec.version };
  const draft = readDraft(rec.genus);
  if ('code' in draft) return { ok: false, code: draft.code };
  if (isBuiltInGenusId(draft.draft.id)) return { ok: false, code: 'builtIn' };
  const species = readSpecies(rec.species ?? []);
  if (!species) return { ok: false, code: 'species' };
  return { ok: true, file: { format: APEXGENUS_FORMAT, version: rec.version, genus: draft.draft, species } };
}

/** define_genus plus one create_species per stored species (create upserts). */
export function importCommands(file: ApexGenusFile): Record<string, unknown>[] {
  return [
    defineGenusCommand(file.genus),
    ...file.species.map((s) => ({
      op: 'create_species',
      genus: file.genus.id,
      id: s.id,
      name: s.name || s.id,
      params: s.values,
    })),
  ];
}
