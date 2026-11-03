export interface PaletteCommand {
  id: string;
  /** Label in the current locale. */
  label: string;
  /** Lower-cased haystack: RU + EN labels, ids, shortcut. */
  search: string;
  group: string;
  shortcut?: string;
  disabled?: boolean;
  run: () => void;
}

/** Every query word must appear somewhere (prefix-friendly, any order). */
export function matchCommand(cmd: PaletteCommand, query: string): number {
  const q = query.trim().toLowerCase().replace(/ё/g, 'е');
  if (!q) return 1;
  if (cmd.shortcut && cmd.shortcut.toLowerCase() === q.replace(/\s/g, '')) return 20;
  const hay = `${cmd.label.toLowerCase()} ${cmd.search}`.replace(/ё/g, 'е');
  let score = 0;
  for (const word of q.split(/\s+/)) {
    const at = hay.indexOf(word);
    if (at < 0) return 0;
    score += at === 0 ? 3 : /\s/.test(hay[at - 1] ?? ' ') ? 2 : 1;
  }
  return score;
}

export function filterCommands(cmds: readonly PaletteCommand[], query: string): PaletteCommand[] {
  return cmds
    .map((cmd, i) => ({ cmd, i, s: matchCommand(cmd, query) }))
    .filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((r) => r.cmd);
}
