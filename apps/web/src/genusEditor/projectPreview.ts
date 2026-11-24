/**
 * Test-in-project session.
 *
 * The editor keeps a draft. "Test" / "Place" writes that draft into the
 * project as a preview and remembers the project JSON from just before.
 * Apply drops the snapshot (the preview stays). Discard restores it.
 */

export interface ProjectTest {
  /** `exportProject()` taken before the preview was written. */
  baseline: string;
}

export function openProjectTest(baseline: string): ProjectTest {
  return { baseline };
}

/** `restore` is set only for Discard. */
export function closeProjectTest(test: ProjectTest, action: 'apply' | 'discard'): { restore: string | null } {
  if (action === 'discard') return { restore: test.baseline };
  return { restore: null };
}

/** Leaving the editor with a draft that is not in the project yet. */
export function leaveNeedsPrompt(dirty: boolean): boolean {
  return dirty;
}
