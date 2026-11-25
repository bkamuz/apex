/**
 * What «Вставить» does with a library genus against the open project.
 *
 * An id that is already registered is not written on the first click.
 * Replacing the definition is offered only when nothing placed would be
 * rebuilt: no instance of this genus, and none of a genus that extends it
 * or nests it (transitively). `upsert_genus` rebuilds that whole set.
 */
export type LibraryInsertPlan =
  | { kind: 'insert' }
  | { kind: 'already'; replace: boolean };

/** One installed genus, enough to walk `extends` and nested-genus edges. */
export interface GenusLink {
  id: string;
  extends?: string;
  /** Genus ids nested in the resolved body. */
  nests: readonly string[];
}

/**
 * Genera whose geometry depends on `id`: itself, genera that extend it,
 * and genera that nest any of those, transitively.
 * Mirrors `Project::genera_depending_on`.
 */
export function generaDependingOn(id: string, genera: readonly GenusLink[]): Set<string> {
  const affected = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const genus of genera) {
      if (affected.has(genus.id)) continue;
      const extendsHit = genus.extends !== undefined && affected.has(genus.extends);
      const nestHit = genus.nests.some((nested) => affected.has(nested));
      if (extendsHit || nestHit) {
        affected.add(genus.id);
        grew = true;
      }
    }
  }
  return affected;
}

export function planLibraryInsert(
  present: boolean,
  id: string,
  genera: readonly GenusLink[],
  placedComponentIds: readonly string[],
): LibraryInsertPlan {
  if (!present) return { kind: 'insert' };
  const affected = generaDependingOn(id, genera);
  const placed = placedComponentIds.some((componentId) => affected.has(componentId));
  return { kind: 'already', replace: !placed };
}
