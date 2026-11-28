import type { ComponentDto, ParamValue, ProfileTypeDto, SpeciesDto } from '../types';
import { apexRunQuery } from '../wasm/apex';
import { defaultPlacementParams } from './profileModel';

/**
 * Placement params for a genus, with the chosen species' type values on top
 * of the spec defaults. Spec defaults alone would place every species as the
 * default one (a curb would start as a fence).
 */
export function placementDraftFor(
  component: ComponentDto,
  profiles: ProfileTypeDto[],
  speciesId: string,
  speciesRows: ReadonlyArray<Pick<SpeciesDto, 'id' | 'values'>>,
): Record<string, ParamValue> {
  const draft = defaultPlacementParams(component, profiles);
  if (!speciesId) return draft;
  draft.species = speciesId;
  const row = speciesRows.find((item) => item.id === speciesId);
  if (!row) return draft;
  for (const spec of component.params) {
    if (spec.binding !== 'type') continue;
    const value = row.values[spec.id];
    if (value !== undefined) draft[spec.id] = value;
  }
  return draft;
}

/** Draft for the active placement tool, reading species rows from the core. */
export function placementDraft(
  component: ComponentDto,
  profiles: ProfileTypeDto[],
  speciesId: string,
): Record<string, ParamValue> {
  let rows: SpeciesDto[] = [];
  if (speciesId) {
    try {
      const listed = apexRunQuery({ op: 'list_genus_species', genus: component.id });
      if (Array.isArray(listed)) rows = listed as SpeciesDto[];
    } catch {
      rows = [];
    }
  }
  return placementDraftFor(component, profiles, speciesId, rows);
}
