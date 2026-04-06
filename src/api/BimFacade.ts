import * as THREE from 'three';
import type * as OBC from '@thatopen/components';
import type { Document, DocumentChangeEvent } from '../core/document';
import { replaceIfcElementsInDocument } from '../data/ifc';
import {
  applyNativeLevelVisibility,
  registerNativeMesh,
  unregisterNativeMesh,
  type RegisterNativeMeshOptions,
} from '../data/scene';
import type { ElementDto } from '../../shared/dto';
import { elementRecordToDto, snapshotFromDocument } from './elementMappers';

export interface BimRuntimeContext {
  scene: THREE.Scene | null;
  camera: THREE.Camera | null;
  components: OBC.Components | null;
}

/**
 * Фасад над Document и сценой: use-case API для UI и плагинов.
 */
export class BimFacade {
  readonly document: Document;

  constructor(document: Document) {
    this.document = document;
  }

  private runtime: BimRuntimeContext = {
    scene: null,
    camera: null,
    components: null,
  };

  setRuntime(partial: Partial<BimRuntimeContext>): void {
    this.runtime = { ...this.runtime, ...partial };
  }

  getRuntime(): Readonly<BimRuntimeContext> {
    return this.runtime;
  }

  clearRuntime(): void {
    this.runtime = { scene: null, camera: null, components: null };
  }

  listElements(): ElementDto[] {
    return this.document.getAll().map(elementRecordToDto);
  }

  getElement(id: string): ElementDto | undefined {
    const r = this.document.get(id);
    return r ? elementRecordToDto(r) : undefined;
  }

  getSnapshot(projectId: string) {
    return snapshotFromDocument(projectId, this.document.getAll());
  }

  subscribe(listener: (event: DocumentChangeEvent) => void): () => void {
    return this.document.subscribe(listener);
  }

  getVersion(): number {
    return this.document.getVersion();
  }

  replaceIfcFromProperties(
    properties: Record<string, Record<string, unknown>> | undefined
  ): void {
    replaceIfcElementsInDocument(this.document, properties);
  }

  applyLevelFilter(activeLevelId: string | null): void {
    const scene = this.runtime.scene;
    if (!scene) return;
    applyNativeLevelVisibility(scene, this.document, activeLevelId);
  }

  registerNativeMesh(mesh: THREE.Mesh, opts: RegisterNativeMeshOptions): string {
    return registerNativeMesh(this.document, mesh, opts);
  }

  unregisterNativeMesh(mesh: THREE.Mesh): void {
    unregisterNativeMesh(this.document, mesh);
  }

  removeIfcElements(): void {
    this.document.removeByKind('ifc');
  }

  clearDocument(): void {
    this.document.clear();
  }
}
