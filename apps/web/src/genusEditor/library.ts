/**
 * Personal genus library («Моя библиотека» / My library).
 *
 * Stored in the browser's IndexedDB database `apex.genusLibrary`, object
 * store `genera`, one record per genus id. The database is origin-scoped, so
 * every project opened in this browser profile (and the desktop shell's
 * webview, which is the same origin) sees the same library. It is not part
 * of the project file and is not synced to other machines.
 */
import { genusFile, type ApexGenusFile, type ApexGenusSpecies } from './apexgenus.ts';
import type { GenusDraft } from './model.ts';

export const GENUS_LIBRARY_DB = 'apex.genusLibrary';
export const GENUS_LIBRARY_STORE = 'genera';

export interface LibraryRecord {
  id: string;
  name: string;
  /** ISO-8601 timestamp. */
  savedAt: string;
  file: ApexGenusFile;
}

export interface LibraryStore {
  list(): Promise<LibraryRecord[]>;
  put(record: LibraryRecord): Promise<void>;
  delete(id: string): Promise<void>;
}

const listeners = new Set<() => void>();

export function subscribeGenusLibrary(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emitLibrary(): void {
  for (const listener of listeners) listener();
}

export function memoryLibraryStore(): LibraryStore {
  const rows = new Map<string, LibraryRecord>();
  return {
    async list() {
      return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    },
    async put(record) {
      rows.set(record.id, record);
    },
    async delete(id) {
      rows.delete(id);
    },
  };
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(GENUS_LIBRARY_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(GENUS_LIBRARY_STORE)) db.createObjectStore(GENUS_LIBRARY_STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
}

export function indexedDbLibraryStore(): LibraryStore {
  return {
    async list() {
      const db = await openDb();
      try {
        const rows = await request(db.transaction(GENUS_LIBRARY_STORE, 'readonly').objectStore(GENUS_LIBRARY_STORE).getAll() as IDBRequest<LibraryRecord[]>);
        return rows.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
      } finally {
        db.close();
      }
    },
    async put(record) {
      const db = await openDb();
      try {
        await request(db.transaction(GENUS_LIBRARY_STORE, 'readwrite').objectStore(GENUS_LIBRARY_STORE).put(record));
      } finally {
        db.close();
      }
    },
    async delete(id) {
      const db = await openDb();
      try {
        await request(db.transaction(GENUS_LIBRARY_STORE, 'readwrite').objectStore(GENUS_LIBRARY_STORE).delete(id));
      } finally {
        db.close();
      }
    },
  };
}

let singleton: LibraryStore | null = null;

export function genusLibrary(): LibraryStore {
  if (!singleton) singleton = indexedDbLibraryStore();
  return singleton;
}

/** Test hook: swap the store the editor and the browser share. */
export function setGenusLibraryForTests(store: LibraryStore | null): void {
  singleton = store;
}

export async function saveGenusToLibrary(
  draft: GenusDraft,
  species: readonly ApexGenusSpecies[],
  store: LibraryStore = genusLibrary(),
  savedAt: string = new Date().toISOString(),
): Promise<LibraryRecord> {
  const file = genusFile(draft, species);
  const record: LibraryRecord = { id: file.genus.id, name: file.genus.name, savedAt, file };
  await store.put(record);
  emitLibrary();
  return record;
}

export async function deleteGenusFromLibrary(id: string, store: LibraryStore = genusLibrary()): Promise<void> {
  await store.delete(id);
  emitLibrary();
}
