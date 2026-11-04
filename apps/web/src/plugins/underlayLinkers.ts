import { assertDescribed } from '../descriptor';
import type { UnderlayLinker } from './types';

type Listener = () => void;

/** Runtime registry of additive underlay linkers (not replace-project Open). */
class UnderlayLinkerRegistry {
  private linkers: UnderlayLinker[] = [];
  private listeners = new Set<Listener>();

  reset(): void {
    this.linkers = [];
    this.emit();
  }

  register(linker: UnderlayLinker): void {
    assertDescribed('underlayLinker', linker.id, linker);
    this.linkers = [
      ...this.linkers.filter((item) => item.id !== linker.id),
      linker,
    ];
    this.emit();
  }

  list(): UnderlayLinker[] {
    return this.linkers;
  }

  /** First linker that accepts this filename extension (including the dot). */
  findByExtension(ext: string): UnderlayLinker | undefined {
    const lower = ext.toLowerCase();
    return this.linkers.find((linker) =>
      linker.extensions.some((e) => e.toLowerCase() === lower),
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

export const underlayLinkerRegistry = new UnderlayLinkerRegistry();
