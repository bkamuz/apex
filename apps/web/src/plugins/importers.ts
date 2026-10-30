import { assertDescribed } from '../descriptor';
import type { Importer } from './types';

type Listener = () => void;

/** Runtime registry of file importers contributed by plugins. */
class ImporterRegistry {
  private importers: Importer[] = [];
  private listeners = new Set<Listener>();

  reset(): void {
    this.importers = [];
    this.emit();
  }

  register(importer: Importer): void {
    assertDescribed('importer', importer.id, importer);
    this.importers = [
      ...this.importers.filter((item) => item.id !== importer.id),
      importer,
    ];
    this.emit();
  }

  list(): Importer[] {
    return this.importers;
  }

  /** Match a filename (e.g. `model.ifc`) to a registered importer. */
  findForFile(filename: string): Importer | undefined {
    const lower = filename.toLowerCase();
    return this.importers.find((importer) =>
      importer.extensions.some((ext) => lower.endsWith(ext.toLowerCase())),
    );
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export const importerRegistry = new ImporterRegistry();
