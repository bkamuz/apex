import initWasm, {
  createElement,
  createLevel,
  deleteSelected,
  getScene,
  getSelected,
  initApp,
  listComponents,
  listElements,
  listProfiles,
  pickById,
  previewElement,
  previewProfile,
  registerComponent,
  registerProfile,
  selectElement,
  setActiveLevel,
  setElementPlacement,
  setLevelElevation,
  togglePickById,
  toggleSelectElement,
  updateElement,
  updateProfileType,
} from './pkg/apex_wasm.js';
import type {
  ComponentDto,
  ElementDto,
  MeshDto,
  ParamValue,
  PlacementKind,
  ProfilePreviewDto,
  ProfileTypeDto,
  SceneDto,
  Vec3,
} from '../types';

let ready = false;

export async function initApex(): Promise<void> {
  if (ready) return;
  await initWasm();
  initApp();
  ready = true;
}

function asScene(value: unknown): SceneDto {
  return value as SceneDto;
}

/** Points and params cross the boundary as JSON, so any component shape fits. */
function encodePoints(points: Vec3[]): string {
  return JSON.stringify(points);
}

function encodeParams(params: Record<string, ParamValue> | undefined): string {
  return params && Object.keys(params).length > 0 ? JSON.stringify(params) : '';
}

export function apexListComponents(): ComponentDto[] {
  return listComponents() as ComponentDto[];
}

export function apexRegisterComponent(definition: unknown): SceneDto {
  return asScene(registerComponent(JSON.stringify(definition)));
}

export function apexListProfiles(category = ''): ProfileTypeDto[] {
  return listProfiles(category) as ProfileTypeDto[];
}

export function apexRegisterProfile(definition: ProfileTypeDto): SceneDto {
  return asScene(registerProfile(JSON.stringify(definition)));
}

export function apexUpdateProfileType(
  id: string,
  params: Record<string, ParamValue>,
): SceneDto {
  return asScene(updateProfileType(id, encodeParams(params)));
}

export function apexPreviewProfile(
  profile: ProfileTypeDto | unknown,
  params?: Record<string, ParamValue>,
): ProfilePreviewDto {
  return previewProfile(JSON.stringify(profile), encodeParams(params)) as ProfilePreviewDto;
}

export function apexCreateElement(
  componentId: string,
  points: Vec3[],
  params?: Record<string, ParamValue>,
  rotation = 0,
  placementKind?: PlacementKind,
): SceneDto {
  return asScene(
    createElement(
      componentId,
      encodePoints(points),
      rotation,
      encodeParams(params),
      placementKind ?? '',
    ),
  );
}

export function apexUpdateElement(
  id: string,
  params: Record<string, ParamValue>,
): SceneDto {
  return asScene(updateElement(id, encodeParams(params)));
}

export function apexSetElementPlacement(id: string, points: Vec3[], rotation = 0): SceneDto {
  return asScene(setElementPlacement(id, encodePoints(points), rotation));
}

export function apexPreviewElement(
  componentId: string,
  points: Vec3[],
  params?: Record<string, ParamValue>,
  rotation = 0,
  placementKind?: PlacementKind,
): MeshDto {
  return previewElement(
    componentId,
    encodePoints(points),
    rotation,
    encodeParams(params),
    placementKind ?? '',
  ) as MeshDto;
}

export function apexCreateLevel(name: string, elevation: number): SceneDto {
  return asScene(createLevel(name, elevation));
}

export function apexSetActiveLevel(id: string): SceneDto {
  return asScene(setActiveLevel(id));
}

export function apexSetLevelElevation(id: string, elevation: number): SceneDto {
  return asScene(setLevelElevation(id, elevation));
}

export function apexSelectElement(id: string | null): SceneDto {
  return asScene(selectElement(id ?? ''));
}

export function apexToggleSelectElement(id: string): SceneDto {
  return asScene(toggleSelectElement(id));
}

export function apexPickById(pickId: number): SceneDto {
  return asScene(pickById(pickId));
}

export function apexTogglePickById(pickId: number): SceneDto {
  return asScene(togglePickById(pickId));
}

export function apexGetScene(): SceneDto {
  return asScene(getScene());
}

export function apexGetSelected(): ElementDto | null {
  const value = getSelected();
  if (value === null || value === undefined) return null;
  return value as ElementDto;
}

export function apexListElements(): ElementDto[] {
  return listElements() as ElementDto[];
}

export function apexDeleteSelected(): SceneDto {
  return asScene(deleteSelected());
}
