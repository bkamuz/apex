/**
 * Thin Open/Save adapter: Tauri native dialogs when the desktop shell is
 * present; callers fall back to the browser File API / download otherwise.
 */

export type DesktopOpenedFile = {
  /** Basename for display / dirty tracking. */
  name: string;
  text: string;
  /** Absolute path for subsequent Save without a picker. */
  path: string;
};

export type DesktopSavedFile = {
  name: string;
  path: string;
};

export type DesktopFileFilter = {
  name: string;
  /** Extensions without a leading dot, e.g. `json`, `ifc`. */
  extensions: string[];
};

type TauriWindow = Window & {
  __TAURI_INTERNALS__?: unknown;
  __TAURI__?: unknown;
};

/** True when the UI is hosted inside the Tauri 2 desktop shell. */
export function isTauriShell(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as TauriWindow;
  return w.__TAURI_INTERNALS__ != null || w.__TAURI__ != null;
}

/** Basename of a filesystem path (POSIX or Windows). */
export function pathBasename(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/');
  return parts[parts.length - 1] || path;
}

/**
 * Native open dialog + read text. Returns `null` if the user cancels.
 * Throws if called outside Tauri.
 */
export async function openTextFileDesktop(
  filters: DesktopFileFilter[],
): Promise<DesktopOpenedFile | null> {
  if (!isTauriShell()) {
    throw new Error('openTextFileDesktop requires the Tauri desktop shell');
  }
  const { open } = await import('@tauri-apps/plugin-dialog');
  const { readTextFile } = await import('@tauri-apps/plugin-fs');
  const selected = await open({
    multiple: false,
    directory: false,
    filters: filters.length > 0 ? filters : undefined,
  });
  if (selected == null) return null;
  const path = Array.isArray(selected) ? selected[0] : selected;
  if (!path) return null;
  const text = await readTextFile(path);
  return { path, name: pathBasename(path), text };
}

/**
 * Write text via a native save dialog (or overwrite `existingPath` when set
 * and `forcePicker` is false). Returns `null` if the user cancels.
 */
export async function saveTextFileDesktop(
  text: string,
  opts: {
    suggestedName: string;
    existingPath?: string | null;
    forcePicker?: boolean;
    filters?: DesktopFileFilter[];
  },
): Promise<DesktopSavedFile | null> {
  if (!isTauriShell()) {
    throw new Error('saveTextFileDesktop requires the Tauri desktop shell');
  }
  const { save } = await import('@tauri-apps/plugin-dialog');
  const { writeTextFile } = await import('@tauri-apps/plugin-fs');

  let path = opts.existingPath ?? null;
  if (!path || opts.forcePicker) {
    const picked = await save({
      defaultPath: path ?? opts.suggestedName,
      filters: opts.filters ?? [{ name: 'Apex project', extensions: ['json'] }],
    });
    if (picked == null) return null;
    path = picked;
  }

  await writeTextFile(path, text);
  return { path, name: pathBasename(path) };
}

/** Build dialog filters from HTML `accept`-style tokens (`.json`, `application/json`). */
export function filtersFromAccept(accept: string[]): DesktopFileFilter[] {
  const extensions = new Set<string>();
  for (const token of accept) {
    const t = token.trim().toLowerCase();
    if (!t || t.includes('/')) continue;
    const ext = t.startsWith('.') ? t.slice(1) : t;
    if (ext) extensions.add(ext);
  }
  if (extensions.size === 0) {
    return [{ name: 'Projects', extensions: ['json'] }];
  }
  return [
    {
      name: 'Supported files',
      extensions: [...extensions],
    },
  ];
}
