import type { ParamSpecDto } from '../types';
import { unitFor } from './inspector/model';

/**
 * UI-side localisation of core (Rust) parameter labels and units. Core specs
 * carry English labels; known ones map to `param.label.*` catalog keys. Unknown
 * (user-authored) labels are shown as typed.
 */
export function paramLabelKey(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `param.label.${slug}`;
}

type Translate = (key: string, params?: undefined, fallback?: string) => string;

export function localizedParamLabel(spec: Pick<ParamSpecDto, 'label'>, t: Translate): string {
  return t(paramLabelKey(spec.label), undefined, spec.label);
}

const UNIT_KEYS: Record<string, string> = {
  m: 'param.unit.m',
  mm: 'param.unit.mm',
  rad: 'param.unit.rad',
  deg: 'param.unit.deg',
};

export function localizedUnit(spec: ParamSpecDto, t: Translate): string | null {
  const unit = unitFor(spec);
  if (!unit) return null;
  const key = UNIT_KEYS[unit];
  return key ? t(key, undefined, unit) : unit;
}
