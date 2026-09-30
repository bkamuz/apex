import initWasm, {
  createElement,
  createLevel,
  deleteSelected,
  getScene,
  getSelected,
  initApp,
  setElementParent,
  childrenOf,
  descendantsOf,
  effectiveLevelOf,
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
  exportProject,
  importProject,
  newProject,
  undo,
  redo,
  beginUndoGroup,
  createReference,
  selectReference,
  getSelectedReference,
  setReferencePlacement,
  deleteSelectedReference,
  createGridAxis,
  selectGridAxis,
  getSelectedGridAxis,
  setGridAxisPlacement,
  updateGridAxis,
  deleteSelectedGridAxis,
  getSelectedElements,
  translateSelection,
  copySelection,
} from './pkg/apex_wasm.js';
import type {
  ComponentDto,
  ElementDto,
  MeshDto,
  ParamValue,
  PlacementKind,
  ProfilePreviewDto,
  ProfileTypeDto,
  GridAxisDto,
  ReferenceDto,
  ReferenceKind,
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

export function apexSetElementPlacement(
  id: string,
  points: Vec3[],
  rotation = 0,
  recordHistory = true,
): SceneDto {
  return asScene(setElementPlacement(id, encodePoints(points), rotation, recordHistory));
}

/**
 * Attach an element to a parent, or pass `null` to detach.
 *
 * The child takes the parent's level and follows it when moved. Returns the
 * scene; ids whose level changed are already reflected in it.
 */
export function apexSetElementParent(id: string, parentId: string | null): SceneDto {
  return asScene(setElementParent(id, parentId ?? undefined));
}

/** Direct children of an element. */
export function apexChildrenOf(id: string): string[] {
  return childrenOf(id) as string[];
}

/** Every descendant, breadth first. Nesting is unbounded. */
export function apexDescendantsOf(id: string): string[] {
  return descendantsOf(id) as string[];
}

/** The level an element actually sits on, following parent inheritance. */
export function apexEffectiveLevelOf(id: string): string | undefined {
  return effectiveLevelOf(id);
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

export function apexExportProject(): string {
  return exportProject();
}

export function apexImportProject(json: string): SceneDto {
  return asScene(importProject(json));
}

export function apexNewProject(): SceneDto {
  return asScene(newProject());
}

export function apexUndo(): SceneDto {
  return asScene(undo());
}

export function apexRedo(): SceneDto {
  return asScene(redo());
}

export function apexBeginUndoGroup(): void {
  beginUndoGroup();
}

export function apexCreateReference(kind: ReferenceKind, points: Vec3[]): SceneDto {
  return asScene(createReference(kind, encodePoints(points), 0));
}

export function apexSelectReference(id: string | null): SceneDto {
  return asScene(selectReference(id ?? ''));
}

export function apexGetSelectedReference(): ReferenceDto | null {
  const value = getSelectedReference();
  if (value === null || value === undefined) return null;
  return value as ReferenceDto;
}

export function apexSetReferencePlacement(
  id: string,
  points: Vec3[],
  rotation = 0,
  recordHistory = true,
): SceneDto {
  return asScene(setReferencePlacement(id, encodePoints(points), rotation, recordHistory));
}

export function apexDeleteSelectedReference(): SceneDto {
  return asScene(deleteSelectedReference());
}

export function apexCreateGridAxis(points: Vec3[], params?: Record<string, ParamValue>): SceneDto {
  return asScene(createGridAxis(encodePoints(points), encodeParams(params), 0));
}

export function apexSelectGridAxis(id: string | null): SceneDto {
  return asScene(selectGridAxis(id ?? ''));
}

export function apexGetSelectedGridAxis(): GridAxisDto | null {
  const value = getSelectedGridAxis();
  if (value === null || value === undefined) return null;
  return value as GridAxisDto;
}

export function apexSetGridAxisPlacement(
  id: string,
  points: Vec3[],
  rotation = 0,
  recordHistory = true,
): SceneDto {
  return asScene(setGridAxisPlacement(id, encodePoints(points), rotation, recordHistory));
}

export function apexUpdateGridAxis(id: string, params: Record<string, ParamValue>): SceneDto {
  return asScene(updateGridAxis(id, encodeParams(params)));
}

export function apexDeleteSelectedGridAxis(): SceneDto {
  return asScene(deleteSelectedGridAxis());
}

export function apexGetSelectedElements(): ElementDto[] {
  return getSelectedElements() as ElementDto[];
}

function encodeDelta(delta: Vec3): string {
  return JSON.stringify(delta);
}

export function apexTranslateSelection(delta: Vec3, recordHistory = true): SceneDto {
  return asScene(translateSelection(encodeDelta(delta), recordHistory));
}

export function apexCopySelection(delta: Vec3): SceneDto {
  return asScene(copySelection(encodeDelta(delta)));
}
