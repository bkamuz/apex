export const PROJECT_STORAGE_KEY = 'apex.project';

export function loadStoredProject(): string | null {
  try {
    return localStorage.getItem(PROJECT_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function storeProject(json: string): void {
  try {
    localStorage.setItem(PROJECT_STORAGE_KEY, json);
  } catch {
    /* quota / private mode */
  }
}

export function clearStoredProject(): void {
  try {
    localStorage.removeItem(PROJECT_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

export const DEFAULT_PROJECT_FILENAME = 'apex-project.json';

/** Ensure a project download name ends with `.json`. */
export function normalizeProjectFilename(name: string): string {
  const trimmed = name.trim() || DEFAULT_PROJECT_FILENAME;
  return /\.json$/i.test(trimmed) ? trimmed : `${trimmed}.json`;
}

export function downloadText(
  filename: string,
  text: string,
  mime = 'application/json',
): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
