import { systemPacks } from './catalog';
import {
  defaultEnabledPackIds,
  loadEnabledPackIds,
  saveEnabledPackIds,
} from './packPrefs';

type PackListener = (enabledIds: readonly string[]) => void;

const listeners = new Set<PackListener>();

function browserStorage(): Storage | undefined {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : undefined;
  } catch {
    return undefined;
  }
}

/** Current enabled pack ids (from localStorage or defaults). */
export function getEnabledPackIds(): string[] {
  return loadEnabledPackIds(browserStorage(), systemPacks);
}

/** Enable or disable one pack; persist and notify subscribers. */
export function setPackEnabled(packId: string, enabled: boolean): void {
  const known = systemPacks.some((pack) => pack.id === packId);
  if (!known) return;
  const current = new Set(getEnabledPackIds());
  if (enabled) current.add(packId);
  else current.delete(packId);
  // Keep catalog order for stable Settings / install iteration.
  const next = systemPacks.map((pack) => pack.id).filter((id) => current.has(id));
  saveEnabledPackIds(browserStorage(), next);
  for (const listener of listeners) listener(next);
}

export function isPackEnabled(packId: string): boolean {
  return getEnabledPackIds().includes(packId);
}

export function subscribePackPrefs(listener: PackListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function resetPackPrefsForTests(): void {
  listeners.clear();
  saveEnabledPackIds(browserStorage(), defaultEnabledPackIds(systemPacks));
}
