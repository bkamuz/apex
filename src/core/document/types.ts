export type ElementId = string;

export type ElementKind = 'ifc' | 'native';

export interface IfcGeometryRef {
  kind: 'ifc';
  expressId: number;
}

export interface NativeGeometryRef {
  kind: 'native';
  objectUuid: string;
}

export type GeometryRef = IfcGeometryRef | NativeGeometryRef;

export interface ElementRecord {
  id: ElementId;
  kind: ElementKind;
  category: string;
  name: string;
  levelId: string | null;
  expressId?: number;
  parameters: Record<string, unknown>;
  geometry: GeometryRef;
}

export type DocumentChangeType = 'upsert' | 'remove' | 'clear';

export interface DocumentChangeEvent {
  type: DocumentChangeType;
  ids: ElementId[];
}

export function createElementId(): ElementId {
  return `el-${crypto.randomUUID()}`;
}
