import type { ComponentDto, ParamSpecDto, ParamValue, ProfileTypeDto } from '../types';

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
  if (category === 'column' || category === 'beam') {
    const width = category === 'beam' ? 0.2 : 0.4;
    const depth = category === 'beam' ? 0.4 : 0.4;
    return {
      id,
      display_name: 'Custom',
      category,
      params: [
        lengthParam('width', 'Width', width, 'type'),
        lengthParam('depth', 'Depth', depth, 'type'),
      ],
      spec: {
        shape: 'rectangle',
        width: { op: 'param', id: 'width' },
        height: { op: 'param', id: 'depth' },
      },
      type_values: {},
    };
  }
  return {
    id,
    display_name: 'Custom',
    category: category || 'wall',
    params: [
      lengthParam('thickness', 'Thickness', 0.2, 'type'),
      lengthParam('height', 'Height', 3, 'instance'),
    ],
    spec: {
      shape: 'rectangle',
      width: { op: 'param', id: 'thickness' },
      height: { op: 'param', id: 'height' },
    },
    type_values: {},
  };
}

function lengthParam(
  id: string,
  label: string,
  value: number,
  binding: 'type' | 'instance',
): ParamSpecDto {
  return {
    id,
    label,
    kind: 'length',
    default: value,
    min: Number.MIN_VALUE,
    unit: 'm',
    binding,
  };
}

export function profileLabel(profiles: ProfileTypeDto[], id: string): string {
  const found = profiles.find((profile) => profile.id === id);
  if (found) return found.display_name;
  const leaf = id.includes('.') ? id.slice(id.lastIndexOf('.') + 1) : id;
  return leaf.charAt(0).toUpperCase() + leaf.slice(1);
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
