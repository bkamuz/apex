import type { Exporter } from './types';

type Listener = () => void;

/** Runtime registry of file exporters contributed by plugins. */
class ExporterRegistry {
  private exporters: Exporter[] = [];
  private listeners = new Set<Listener>();

  reset(): void {
    this.exporters = [];
    this.emit();
  }

  register(exporter: Exporter): void {
    this.exporters = [
      ...this.exporters.filter((item) => item.id !== exporter.id),
      exporter,
    ];
    this.emit();
  }

  list(): Exporter[] {
    return this.exporters;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export const exporterRegistry = new ExporterRegistry();
