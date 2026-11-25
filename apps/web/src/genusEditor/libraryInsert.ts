/**
 * What «Вставить» does with a library genus against the open project.
 *
 * An id that is already registered is not written on the first click.
 * Replacing the definition is offered only when nothing is placed from it,
 * so the swap cannot rebuild existing instances.
 */
export type LibraryInsertPlan =
  | { kind: 'insert' }
  | { kind: 'already'; replace: boolean };

export function planLibraryInsert(present: boolean, instanceCount: number): LibraryInsertPlan {
  if (!present) return { kind: 'insert' };
  return { kind: 'already', replace: instanceCount === 0 };
}
