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

export function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
