import type { ElementRecord } from '../core/document';
import type { ElementDto, ElementsSnapshotDto, GeometryRefDto } from '../../shared/dto';

function geometryToDto(geometry: ElementRecord['geometry']): GeometryRefDto {
  if (geometry.kind === 'ifc') {
    return { kind: 'ifc', expressId: geometry.expressId };
  }
  return { kind: 'native', objectUuid: geometry.objectUuid };
}

export function elementRecordToDto(record: ElementRecord): ElementDto {
  return {
    id: record.id,
    kind: record.kind,
    category: record.category,
    name: record.name,
    levelId: record.levelId,
    expressId: record.expressId,
    parameters: record.parameters,
    geometry: geometryToDto(record.geometry),
  };
}

export function snapshotFromDocument(
  projectId: string,
  elements: ElementRecord[]
): ElementsSnapshotDto {
  return {
    projectId,
    updatedAt: new Date().toISOString(),
    elements: elements.map(elementRecordToDto),
  };
}
