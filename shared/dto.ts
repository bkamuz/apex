/**
 * JSON-сериализуемые DTO для REST и синхронизации с сервером.
 * Должны совпадать по смыслу с ElementRecord в core/document.
 */

export type ElementKindDto = 'ifc' | 'native';

export type GeometryRefDto =
  | { kind: 'ifc'; expressId: number }
  | { kind: 'native'; objectUuid: string };

export interface ElementDto {
  id: string;
  kind: ElementKindDto;
  category: string;
  name: string;
  levelId: string | null;
  expressId?: number;
  parameters: Record<string, unknown>;
  geometry: GeometryRefDto;
}

export interface ElementsSnapshotDto {
  projectId: string;
  updatedAt: string;
  elements: ElementDto[];
}

export interface ApiErrorDto {
  error: string;
  code?: string;
  details?: Record<string, unknown>;
}
