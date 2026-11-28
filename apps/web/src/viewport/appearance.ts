import type { ElementListDto } from '../types';

/** RGB albedo for the lit 3D fill. Plan poche and CAD edges stay neutral. */
export type Rgb = readonly [number, number, number];

/** Unassigned meshes keep the historical neutral fill. */
export const DEFAULT_ALBEDO: Rgb = [0.72, 0.76, 0.8];

const PLASTER: Rgb = [0.93, 0.91, 0.87];
const CONCRETE: Rgb = [0.76, 0.75, 0.72];
const GREEN_ROOF: Rgb = [0.36, 0.5, 0.3];
const DARK_ACCENT: Rgb = [0.26, 0.22, 0.18];
const WOOD: Rgb = [0.52, 0.36, 0.22];
const FRAME: Rgb = [0.15, 0.16, 0.17];
const METAL: Rgb = [0.22, 0.24, 0.26];
const FENCE: Rgb = [0.33, 0.36, 0.32];
const SOIL: Rgb = [0.64, 0.5, 0.34];
const STONE: Rgb = [0.72, 0.67, 0.58];

const BY_COMPONENT: Record<string, Rgb> = {
  'apex.wall': PLASTER,
  'apex.slab': CONCRETE,
  'apex.roof': GREEN_ROOF,
  'apex.pitched_roof': GREEN_ROOF,
  'apex.roof.pitched': GREEN_ROOF,
  'apex.column': DARK_ACCENT,
  'apex.beam': DARK_ACCENT,
  'apex.stair': STONE,
  'apex.door': WOOD,
  'apex.window': FRAME,
  'apex.gate': METAL,
  'apex.fence': FENCE,
  'apex.terrain': SOIL,
};

const SURFACE: Record<string, Rgb> = {
  lawn: [0.4, 0.64, 0.26],
  path: [0.62, 0.48, 0.32],
  gravel: [0.64, 0.62, 0.56],
  paved: [0.82, 0.8, 0.74],
  driveway: [0.22, 0.23, 0.25],
};

const BY_CATEGORY: Record<string, Rgb> = {
  wall: PLASTER,
  slab: CONCRETE,
  roof: GREEN_ROOF,
  column: DARK_ACCENT,
  beam: DARK_ACCENT,
  stair: STONE,
  site: SURFACE.paved,
  topo: SOIL,
  fence: FENCE,
};

/** Per-element fill colour. Site surfaces follow `surface_kind`; glass is tinted in the shader. */
export function appearanceRgb(el: {
  component_id: string;
  category: string;
  surface_kind?: string | null;
}): Rgb {
  if (el.component_id === 'apex.site_surface') {
    const kind = el.surface_kind ?? '';
    return SURFACE[kind] ?? SURFACE.lawn;
  }
  return BY_COMPONENT[el.component_id] ?? BY_CATEGORY[el.category] ?? DEFAULT_ALBEDO;
}

export function appearanceByPick(elements: readonly ElementListDto[]): Map<number, Rgb> {
  const map = new Map<number, Rgb>();
  for (const el of elements) map.set(el.pick_id, appearanceRgb(el));
  return map;
}

/**
 * How far a plan slab fill moves from the neutral paper colour toward the
 * material. Floors stay paper (0) so the drawing stays a line drawing;
 * site surfaces and terrain wash in so the yard reads.
 */
export function planWashByPick(elements: readonly ElementListDto[]): Map<number, number> {
  const map = new Map<number, number>();
  for (const el of elements) {
    const yard = el.component_id === 'apex.site_surface' || el.component_id === 'apex.terrain';
    if (yard) map.set(el.pick_id, 0.85);
  }
  return map;
}
