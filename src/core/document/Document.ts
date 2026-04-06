import type {
  DocumentChangeEvent,
  DocumentChangeType,
  ElementId,
  ElementKind,
  ElementRecord,
} from './types';

export class Document {
  private elements = new Map<ElementId, ElementRecord>();
  private byCategory = new Map<string, Set<ElementId>>();
  private byLevel = new Map<string, Set<ElementId>>();
  private byExpressId = new Map<number, ElementId>();
  private listeners = new Set<(e: DocumentChangeEvent) => void>();
  private version = 0;

  getVersion(): number {
    return this.version;
  }

  subscribe(listener: (e: DocumentChangeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(type: DocumentChangeType, ids: ElementId[]): void {
    this.version += 1;
    const ev: DocumentChangeEvent = { type, ids };
    this.listeners.forEach((fn) => fn(ev));
  }

  private removeFromIndexes(id: ElementId, rec: ElementRecord): void {
    const catSet = this.byCategory.get(rec.category);
    if (catSet) {
      catSet.delete(id);
      if (catSet.size === 0) this.byCategory.delete(rec.category);
    }
    if (rec.levelId !== null) {
      const lvlSet = this.byLevel.get(rec.levelId);
      if (lvlSet) {
        lvlSet.delete(id);
        if (lvlSet.size === 0) this.byLevel.delete(rec.levelId);
      }
    }
    if (rec.kind === 'ifc' && rec.expressId !== undefined) {
      const mapped = this.byExpressId.get(rec.expressId);
      if (mapped === id) this.byExpressId.delete(rec.expressId);
    }
  }

  private addToIndexes(id: ElementId, rec: ElementRecord): void {
    if (!this.byCategory.has(rec.category)) {
      this.byCategory.set(rec.category, new Set());
    }
    this.byCategory.get(rec.category)!.add(id);

    if (rec.levelId !== null) {
      if (!this.byLevel.has(rec.levelId)) {
        this.byLevel.set(rec.levelId, new Set());
      }
      this.byLevel.get(rec.levelId)!.add(id);
    }

    if (rec.kind === 'ifc' && rec.expressId !== undefined) {
      this.byExpressId.set(rec.expressId, id);
    }
  }

  get(id: ElementId): ElementRecord | undefined {
    return this.elements.get(id);
  }

  getAll(): ElementRecord[] {
    return [...this.elements.values()];
  }

  getByCategory(category: string): ElementRecord[] {
    const ids = this.byCategory.get(category);
    if (!ids) return [];
    return [...ids].map((id) => this.elements.get(id)!).filter(Boolean);
  }

  getByLevel(levelId: string): ElementRecord[] {
    const ids = this.byLevel.get(levelId);
    if (!ids) return [];
    return [...ids].map((id) => this.elements.get(id)!).filter(Boolean);
  }

  getIdsByKind(kind: ElementKind): ElementId[] {
    return this.getAll()
      .filter((r) => r.kind === kind)
      .map((r) => r.id);
  }

  getIdByExpressId(expressId: number): ElementId | undefined {
    return this.byExpressId.get(expressId);
  }

  upsert(record: ElementRecord): void {
    const existing = this.elements.get(record.id);
    if (existing) {
      this.removeFromIndexes(record.id, existing);
    }
    this.elements.set(record.id, record);
    this.addToIndexes(record.id, record);
    this.notify('upsert', [record.id]);
  }

  remove(id: ElementId): boolean {
    const rec = this.elements.get(id);
    if (!rec) return false;
    this.removeFromIndexes(id, rec);
    this.elements.delete(id);
    this.notify('remove', [id]);
    return true;
  }

  removeByKind(kind: ElementKind): ElementId[] {
    const ids = this.getIdsByKind(kind);
    for (const id of ids) {
      const rec = this.elements.get(id);
      if (rec) {
        this.removeFromIndexes(id, rec);
        this.elements.delete(id);
      }
    }
    if (ids.length > 0) this.notify('remove', ids);
    return ids;
  }

  clear(): void {
    const ids = [...this.elements.keys()];
    this.elements.clear();
    this.byCategory.clear();
    this.byLevel.clear();
    this.byExpressId.clear();
    if (ids.length > 0) this.notify('clear', ids);
  }
}

export function createDocument(): Document {
  return new Document();
}
