import initWasm, {
  createElement,
  createElementWithParent,
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
  previewComponentDefinition,
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
  exportIfc,
  importProject,
  newProject,
  undo,
  redo,
  beginUndoGroup,
  abortUndoGroup,
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
  createConstructionLine,
  selectConstructionLine,
  getSelectedConstructionLine,
  setConstructionLinePlacement,
  updateConstructionLine,
  deleteSelectedConstructionLine,
  createSectionCut,
  selectSectionCut,
  getSelectedSectionCut,
  setSectionCutPlacement,
  updateSectionCut,
  deleteSelectedSectionCut,
  createSpace,
  detectRoomsFromWalls,
  joinPaths,
  selectSpace,
  getSelectedSpace,
  setSpacePlacement,
  updateSpace,
  deleteSelectedSpace,
  getSelectedElements,
  translateSelection,
  copySelection,
  createPlanView,
  createThreeDView,
  duplicateView,
  renameView,
  deleteView,
  updateViewSettings,
  saveViewState,
  createSheet,
  renameSheet,
  updateSheetLayout,
  deleteSheet,
  placeViewOnSheet,
  moveSheetViewport,
  removeSheetViewport,
  createViewAnnotation,
  updateViewAnnotation,
  deleteViewAnnotation,
  exportViewVector,
  exportViewDxf,
  exportSheetVector,
  exportSheetDxf,
  updateSheetViewportState,
  setSheetViewportCrop,
  resetSheetViewportCrop,
} from './pkg/apex_wasm.js';
import type {
  ComponentDto,
  ConstructionLineDto,
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
  SectionCutDto,
  SpaceDto,
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

export function apexPreviewComponentDefinition(
  definition: unknown,
  points: Vec3[],
  params?: Record<string, ParamValue>,
  placementKind?: PlacementKind,
): MeshDto {
  return previewComponentDefinition(
    JSON.stringify(definition),
    encodePoints(points),
    0,
    encodeParams(params),
    placementKind ?? '',
  ) as MeshDto;
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

export function apexCreateElementWithParent(
  componentId: string,
  points: Vec3[],
  parentId: string,
  params?: Record<string, ParamValue>,
  rotation = 0,
  placementKind?: PlacementKind,
): SceneDto {
  return asScene(
    createElementWithParent(
      componentId,
      encodePoints(points),
      rotation,
      encodeParams(params),
      placementKind ?? '',
      parentId,
    ),
  );
}

export function apexExportIfc(mapping?: Record<string, string>): string {
  return exportIfc(mapping ? JSON.stringify(mapping) : '');
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

export function apexAbortUndoGroup(): void {
  abortUndoGroup();
}

export function apexCreateReference(kind: ReferenceKind, points: Vec3[]): SceneDto {
  return asScene(createReference(kind, encodePoints(points), 0));
}

export function apexSelectReference(id: string | null): SceneDto {
  return asScene(selectReference(id ?? ''));
}

/** Clear plan annotation / reference selection (not element instances). */
export function apexClearDatumSelections(): SceneDto {
  apexSelectGridAxis(null);
  apexSelectConstructionLine(null);
  apexSelectSectionCut(null);
  apexSelectSpace(null);
  return apexSelectReference(null);
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

export function apexCreateConstructionLine(
  points: Vec3[],
  params?: Record<string, ParamValue>,
): SceneDto {
  return asScene(createConstructionLine(encodePoints(points), encodeParams(params), 0));
}

export function apexSelectConstructionLine(id: string | null): SceneDto {
  return asScene(selectConstructionLine(id ?? ''));
}

export function apexGetSelectedConstructionLine(): ConstructionLineDto | null {
  const value = getSelectedConstructionLine();
  if (value === null || value === undefined) return null;
  return value as ConstructionLineDto;
}

export function apexSetConstructionLinePlacement(
  id: string,
  points: Vec3[],
  rotation = 0,
  recordHistory = true,
): SceneDto {
  return asScene(setConstructionLinePlacement(id, encodePoints(points), rotation, recordHistory));
}

export function apexUpdateConstructionLine(
  id: string,
  params: Record<string, ParamValue>,
): SceneDto {
  return asScene(updateConstructionLine(id, encodeParams(params)));
}

export function apexDeleteSelectedConstructionLine(): SceneDto {
  return asScene(deleteSelectedConstructionLine());
}

export function apexCreateSectionCut(
  points: Vec3[],
  params?: Record<string, ParamValue>,
): SceneDto {
  return asScene(createSectionCut(encodePoints(points), encodeParams(params), 0));
}

export function apexSelectSectionCut(id: string | null): SceneDto {
  return asScene(selectSectionCut(id ?? ''));
}

export function apexGetSelectedSectionCut(): SectionCutDto | null {
  const value = getSelectedSectionCut();
  if (value === null || value === undefined) return null;
  return value as SectionCutDto;
}

export function apexSetSectionCutPlacement(
  id: string,
  points: Vec3[],
  rotation = 0,
  recordHistory = true,
): SceneDto {
  return asScene(setSectionCutPlacement(id, encodePoints(points), rotation, recordHistory));
}

export function apexUpdateSectionCut(id: string, params: Record<string, ParamValue>): SceneDto {
  return asScene(updateSectionCut(id, encodeParams(params)));
}

export function apexDeleteSelectedSectionCut(): SceneDto {
  return asScene(deleteSelectedSectionCut());
}

export function apexCreateSpace(points: Vec3[], params?: Record<string, ParamValue>): SceneDto {
  return asScene(createSpace(encodePoints(points), encodeParams(params), 0));
}

export function apexDetectRoomsFromWalls(): SceneDto {
  return asScene(detectRoomsFromWalls());
}

/** Recompute path joins for a joinable element (also runs automatically on place). */
export function apexJoinPaths(id: string): SceneDto {
  return asScene(joinPaths(id));
}

export function apexSelectSpace(id: string | null): SceneDto {
  return asScene(selectSpace(id ?? ''));
}

export function apexGetSelectedSpace(): SpaceDto | null {
  const value = getSelectedSpace();
  if (value === null || value === undefined) return null;
  return value as SpaceDto;
}

export function apexSetSpacePlacement(
  id: string,
  points: Vec3[],
  rotation = 0,
  recordHistory = true,
): SceneDto {
  return asScene(setSpacePlacement(id, encodePoints(points), rotation, recordHistory));
}

export function apexUpdateSpace(id: string, params: Record<string, ParamValue>): SceneDto {
  return asScene(updateSpace(id, encodeParams(params)));
}

export function apexDeleteSelectedSpace(): SceneDto {
  return asScene(deleteSelectedSpace());
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

export function apexCreatePlanView(levelId: string): SceneDto {
  return asScene(createPlanView(levelId));
}

export function apexCreateThreeDView(): SceneDto {
  return asScene(createThreeDView());
}

export function apexDuplicateView(id: string): SceneDto {
  return asScene(duplicateView(id));
}

export function apexRenameView(id: string, name: string): SceneDto {
  return asScene(renameView(id, name));
}

export function apexDeleteView(id: string): SceneDto {
  return asScene(deleteView(id));
}

export function apexUpdateViewSettings(id: string, settings: unknown): SceneDto {
  return asScene(updateViewSettings(id, JSON.stringify(settings)));
}

export function apexSaveViewState(id: string, kind: unknown): SceneDto {
  return asScene(saveViewState(id, JSON.stringify(kind)));
}

export function apexCreateSheet(number: string, name: string): SceneDto {
  return asScene(createSheet(number, name));
}

export function apexRenameSheet(id: string, number: string, name: string): SceneDto {
  return asScene(renameSheet(id, number, name));
}

export function apexUpdateSheetLayout(id: string, paper: string, orientation: string): SceneDto {
  return asScene(updateSheetLayout(id, paper, orientation));
}

export function apexDeleteSheet(id: string): SceneDto {
  return asScene(deleteSheet(id));
}

export function apexPlaceViewOnSheet(
  sheetId: string,
  viewId: string,
  centerXmm: number,
  centerYmm: number,
  widthMm: number,
  heightMm: number,
): SceneDto {
  return asScene(placeViewOnSheet(sheetId, viewId, centerXmm, centerYmm, widthMm, heightMm));
}

export function apexMoveSheetViewport(
  sheetId: string,
  viewportId: string,
  centerXmm: number,
  centerYmm: number,
): SceneDto {
  return asScene(moveSheetViewport(sheetId, viewportId, centerXmm, centerYmm));
}

export function apexRemoveSheetViewport(sheetId: string, viewportId: string): SceneDto {
  return asScene(removeSheetViewport(sheetId, viewportId));
}

export function apexCreateViewAnnotation(viewId: string, kind: unknown): SceneDto {
  return asScene(createViewAnnotation(viewId, JSON.stringify(kind)));
}

export function apexUpdateViewAnnotation(id: string, kind: unknown): SceneDto {
  return asScene(updateViewAnnotation(id, JSON.stringify(kind)));
}

export function apexDeleteViewAnnotation(id: string): SceneDto {
  return asScene(deleteViewAnnotation(id));
}

export function apexExportViewVector(viewId: string): string {
  return exportViewVector(viewId);
}

export function apexExportViewDxf(viewId: string): string {
  return exportViewDxf(viewId);
}

export function apexExportSheetVector(sheetId: string): string {
  return exportSheetVector(sheetId);
}

export function apexExportSheetDxf(sheetId: string): string {
  return exportSheetDxf(sheetId);
}

export function apexUpdateSheetViewportState(
  sheetId: string,
  viewportId: string,
  camera: unknown | null,
  lockNavigation: boolean,
): SceneDto {
  const cameraJson = camera ? JSON.stringify(camera) : '';
  return asScene(updateSheetViewportState(sheetId, viewportId, cameraJson, lockNavigation));
}

export function apexSetSheetViewportCrop(
  sheetId: string,
  viewportId: string,
  cropJson: string,
): SceneDto {
  return asScene(setSheetViewportCrop(sheetId, viewportId, cropJson));
}

export function apexResetSheetViewportCrop(sheetId: string, viewportId: string): SceneDto {
  return asScene(resetSheetViewportCrop(sheetId, viewportId));
}
