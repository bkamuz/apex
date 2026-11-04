import type { SystemPack } from './types';

/** localStorage key for the enabled system-pack id list (JSON string[]). */
export const PACK_STORAGE_KEY = 'apex.packs.enabled';

/** Pack ids with `defaultEnabled: true`. */
export function defaultEnabledPackIds(
  packs: readonly Pick<SystemPack, 'id' | 'defaultEnabled'>[],
): string[] {
  return packs.filter((pack) => pack.defaultEnabled).map((pack) => pack.id);
}

/**
 * Read enabled pack ids from storage. Missing / invalid → defaults.
 * Unknown ids are dropped; known packs omitted from a valid store stay off.
 */
export function loadEnabledPackIds(
  storage: Pick<Storage, 'getItem'> | undefined,
  packs: readonly Pick<SystemPack, 'id' | 'defaultEnabled'>[],
): string[] {
  const defaults = defaultEnabledPackIds(packs);
  if (!storage) return defaults;
  try {
    const raw = storage.getItem(PACK_STORAGE_KEY);
    if (raw == null || raw === '') return defaults;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return defaults;
    const known = new Set(packs.map((pack) => pack.id));
    return parsed.filter((id): id is string => typeof id === 'string' && known.has(id));
  } catch {
    return defaults;
  }
}

export function saveEnabledPackIds(
  storage: Pick<Storage, 'setItem'> | undefined,
  ids: readonly string[],
): void {
  try {
    storage?.setItem(PACK_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    /* storage unavailable */
  }
}

/** Plugins installPlugins would run for the given enabled pack ids. */
export function pluginsForEnabledPacks<P extends { id: string }>(
  alwaysOn: readonly P[],
  packs: readonly { id: string; plugins: readonly P[] }[],
  enabledPackIds: readonly string[],
): P[] {
  const enabled = new Set(enabledPackIds);
  return [
    ...alwaysOn,
    ...packs.filter((pack) => enabled.has(pack.id)).flatMap((pack) => [...pack.plugins]),
  ];
}
