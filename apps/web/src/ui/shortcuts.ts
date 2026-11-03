/**
 * Revit-style two-letter keyboard shortcuts. Typed letters inside `windowMs`
 * form a code; single-letter hotkeys (M, C, P, F, 3) keep working because the
 * matcher only reports complete codes.
 */
export interface TwoLetterShortcut {
  code: string;
  /** Command id run by the host (see `SHORTCUT_COMMANDS`). */
  command: string;
}

/** Built-in codes. `tool:` commands activate a tool id; others are actions. */
export const TWO_LETTER_SHORTCUTS: readonly TwoLetterShortcut[] = [
  { code: 'WA', command: 'tool:place:apex.wall' },
  { code: 'DR', command: 'tool:place:apex.door' },
  { code: 'WN', command: 'tool:place:apex.window' },
  { code: 'SB', command: 'tool:place:apex.slab' },
  { code: 'GR', command: 'tool:grid-axis' },
  { code: 'LL', command: 'tool:level' },
  { code: 'MV', command: 'tool:apex.move' },
  { code: 'CO', command: 'tool:apex.copy' },
  { code: 'TL', command: 'action:thin-lines' },
];

export function shortcutForCommand(command: string): string | undefined {
  return TWO_LETTER_SHORTCUTS.find((s) => s.command === command)?.code;
}

export function createShortcutMatcher(
  shortcuts: readonly TwoLetterShortcut[] = TWO_LETTER_SHORTCUTS,
  windowMs = 900,
) {
  const byCode = new Map(shortcuts.map((s) => [s.code.toLowerCase(), s.command]));
  let prev = '';
  let last = -Infinity;
  return {
    /** Returns the command id when a two-letter code completes, else null. */
    feed(key: string, timeMs: number): string | null {
      const k = key.toLowerCase();
      if (k.length !== 1 || !/[a-z]/.test(k)) {
        prev = '';
        return null;
      }
      const fresh = timeMs - last <= windowMs;
      last = timeMs;
      if (fresh && prev) {
        const hit = byCode.get(prev + k);
        if (hit) {
          prev = '';
          return hit;
        }
      }
      prev = k;
      return null;
    },
    reset() {
      prev = '';
    },
  };
}
