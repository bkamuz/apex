import { t } from '../i18n/t';
import type { ComponentDto, ParamSpecDto, ParamValue, ProfileTypeDto } from '../types';
import { placeholderPolygon } from './sketchModel';

export function isTypeBound(spec: ParamSpecDto): boolean {
  return spec.binding === 'type';
}

export function isInstanceBound(spec: ParamSpecDto): boolean {
  return spec.binding !== 'type';
}

export function profilesForCategory(
  profiles: ProfileTypeDto[],
  category: string,
): ProfileTypeDto[] {
  return profiles.filter((profile) => profile.category === category || profile.category === '');
}

export function instanceSpecs(
  component: ComponentDto,
  profile: ProfileTypeDto | undefined,
): ParamSpecDto[] {
  const fromProfile = profile?.params.filter(isInstanceBound) ?? [];
  const claimed = new Set(component.params.map((spec) => spec.id));
  return [...component.params, ...fromProfile.filter((spec) => !claimed.has(spec.id))];
}

export function typeSpecs(profile: ProfileTypeDto | undefined): ParamSpecDto[] {
  return profile?.params.filter(isTypeBound) ?? [];
}

/** Soft yard kinds follow the terrain. Paving and a driveway stay level. */
export function defaultSitePlacementMode(surfaceKind: string): 'draped' | 'flat' {
  return surfaceKind === 'paved' || surfaceKind === 'driveway' ? 'flat' : 'draped';
}

/** A site surface: the kind chooses the placement until the user sets one. */
export function placesOnTerrain(component: Pick<ComponentDto, 'params'>): boolean {
  const ids = new Set(component.params.map((spec) => spec.id));
  return ids.has('surface_kind') && ids.has('placement_mode');
}

/**
 * When the surface kind changes and placement is still that kind's default,
 * follow the new kind. An explicit Draped/Flat choice is left alone.
 * The spec default is always `draped`, so a draft that copies spec defaults
 * would otherwise drape a new paving surface.
 */
export function syncSitePlacement(
  prev: Record<string, ParamValue>,
  next: Record<string, ParamValue>,
): Record<string, ParamValue> {
  if (typeof next.surface_kind !== 'string' || next.surface_kind === prev.surface_kind) return next;
  const prevKind = typeof prev.surface_kind === 'string' ? prev.surface_kind : 'lawn';
  const prevMode = typeof prev.placement_mode === 'string'
    ? prev.placement_mode
    : defaultSitePlacementMode(prevKind);
  if (prevMode !== defaultSitePlacementMode(prevKind)) return next;
  return { ...next, placement_mode: defaultSitePlacementMode(next.surface_kind) };
}

export function defaultPlacementParams(
  component: ComponentDto,
  profiles: ProfileTypeDto[],
): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {};
  for (const spec of component.params) out[spec.id] = spec.default;
  const profileId = typeof out.profile === 'string' ? out.profile : '';
  const profile = profiles.find((item) => item.id === profileId);
  if (profile) {
    for (const spec of profile.params) {
      if (isTypeBound(spec)) continue;
      out[spec.id] = spec.default;
    }
  }
  if (placesOnTerrain(component)) {
    const kind = typeof out.surface_kind === 'string' ? out.surface_kind : 'lawn';
    out.placement_mode = defaultSitePlacementMode(kind);
  }
  return out;
}

export function applyProfileChange(
  component: ComponentDto,
  profiles: ProfileTypeDto[],
  prev: Record<string, ParamValue>,
  profileId: string,
): Record<string, ParamValue> {
  const profile = profiles.find((item) => item.id === profileId);
  const next: Record<string, ParamValue> = {};
  for (const spec of component.params) {
    next[spec.id] = spec.id === 'profile' ? profileId : (prev[spec.id] ?? spec.default);
  }
  if (profile) {
    for (const spec of profile.params) {
      if (isTypeBound(spec)) continue;
      next[spec.id] = prev[spec.id] ?? spec.default;
    }
  }
  return next;
}

export function nextProfileId(profiles: ProfileTypeDto[], category: string): string {
  const prefix = `user.${category || 'profile'}`;
  const taken = new Set(profiles.map((profile) => profile.id));
  if (!taken.has(prefix)) return prefix;
  let n = 2;
  while (taken.has(`${prefix}.${n}`)) n += 1;
  return `${prefix}.${n}`;
}

export function defaultNewProfile(category: string, id: string): ProfileTypeDto {
  return {
    id,
    display_name: 'Custom',
    category: category || 'wall',
    params: [],
    spec: placeholderPolygon([]),
    type_values: {},
    sketch: { vertices: [], dimensions: [], constraints: [] },
  };
}

export function profileLabel(profiles: ProfileTypeDto[], id: string): string {
  const found = profiles.find((profile) => profile.id === id);
  const fallback = found
    ? found.display_name
    : (id.includes('.') ? id.slice(id.lastIndexOf('.') + 1) : id).replace(/^./, (c) => c.toUpperCase());
  return t(`profile.${id}`, undefined, fallback);
}

export function typeValueMap(profile: ProfileTypeDto | undefined): Record<string, ParamValue> {
  if (!profile) return {};
  const out: Record<string, ParamValue> = { ...profile.type_values };
  for (const spec of profile.params) {
    if (!isTypeBound(spec)) continue;
    if (out[spec.id] === undefined) out[spec.id] = spec.default;
  }
  return out;
}
