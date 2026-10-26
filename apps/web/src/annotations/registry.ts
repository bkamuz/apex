import { assertDescribed } from '../descriptor';
import type { Tool } from '../tools/Tool';
import type { AnnotationKindRegistration, AnnotationKindId } from './types';

type Listener = () => void;

class AnnotationKindRegistry {
  private kinds = new Map<AnnotationKindId, AnnotationKindRegistration>();
  private listeners = new Set<Listener>();

  register(registration: AnnotationKindRegistration): void {
    assertDescribed('annotation kind', registration.kind, registration);
    for (const tool of registration.tools) assertDescribed('tool', tool.id, tool);
    this.kinds.set(registration.kind, registration);
    this.emit();
  }

  get(kind: AnnotationKindId): AnnotationKindRegistration | undefined {
    return this.kinds.get(kind);
  }

  all(): AnnotationKindRegistration[] {
    return [...this.kinds.values()];
  }

  tools(): Tool[] {
    const out: Tool[] = [];
    for (const reg of this.kinds.values()) {
      out.push(...reg.tools);
    }
    return out;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export const annotationKinds = new AnnotationKindRegistry();
