/* tslint:disable */
/* eslint-disable */

/**
 * Drop an open undo group without recording (cancelled gesture).
 */
export function abortUndoGroup(): void;

/**
 * Results from the worker: `[{ key, points?, tris? }]` (no points = failed).
 * Returns the updated scene.
 */
export function applyKernelResults(results: any): any;

/**
 * Open a coalesced undo group (e.g. at the start of an anchor drag).
 */
export function beginUndoGroup(): void;

export function canRedo(): boolean;

export function canUndo(): boolean;

/**
 * Direct children of an element.
 */
export function childrenOf(id: string): any;

/**
 * Duplicate the current selection, offsetting copies by a world-space vector.
 */
export function copySelection(delta_json: string): any;

export function createConstructionLine(points_json: string, params_json: string, rotation: number): any;

/**
 * Place a component from the raw picks the user made.
 *
 * The component's own `PlacementKind` decides how the points are interpreted
 * unless `placement_kind` names a more specific gesture. A path component
 * (wall) uses that override so line, arc and polyline share one type.
 */
export function createElement(component_id: string, points_json: string, rotation: number, params_json: string, placement_kind: string): any;

/**
 * Place a component and attach it to a parent in one undo step (openings).
 */
export function createElementWithParent(component_id: string, points_json: string, rotation: number, params_json: string, placement_kind: string, parent_id: string): any;

export function createGridAxis(points_json: string, params_json: string, rotation: number): any;

export function createLevel(name: string, elevation: number): any;

export function createPlanView(level_id_str: string): any;

export function createReference(kind: string, points_json: string, rotation: number): any;

export function createSectionCut(points_json: string, params_json: string, rotation: number): any;

export function createSheet(number: string, name: string): any;

export function createSheetWithLayout(number: string, name: string, paper: string, orientation: string, custom_width_mm: number, custom_height_mm: number): any;

export function createSpace(points_json: string, params_json: string, rotation: number): any;

export function createThreeDView(): any;

export function createViewAnnotation(view_id_str: string, kind_json: string): any;

/**
 * Delete every selected element.
 */
export function deleteSelected(): any;

export function deleteSelectedConstructionLine(): any;

export function deleteSelectedGridAxis(): any;

export function deleteSelectedReference(): any;

export function deleteSelectedSectionCut(): any;

export function deleteSelectedSpace(): any;

export function deleteSheet(id: string): any;

export function deleteView(id: string): any;

export function deleteViewAnnotation(id: string): any;

/**
 * Every descendant of an element, breadth first.
 */
export function descendantsOf(id: string): any;

/**
 * Full machine-readable API: conventions, components, commands, queries,
 * annotation kinds — every entry with its descriptor.
 */
export function describeApi(): string;

/**
 * Detect enclosed rooms from walls on the active level; refresh auto spaces.
 */
export function detectRoomsFromWalls(): any;

export function duplicateView(id: string): any;

/**
 * The level an element actually sits on, following parent inheritance.
 */
export function effectiveLevelOf(id: string): string | undefined;

/**
 * Run one serialized `Command` (`{"op": ...}`) as a single undo step.
 * Returns the JSON result; errors are readable strings.
 */
export function executeCommand(command_json: string): string;

/**
 * IFC4 STEP export. `mapping_json` is an optional `{ componentId: IfcEntity }` object.
 */
export function exportIfc(mapping_json: string): string;

/**
 * JSON snapshot of the document, profiles, and extra components.
 */
export function exportProject(): string;

export function exportSheetDxf(sheet_id_str: string): string;

export function exportSheetVector(sheet_id_str: string): string;

export function exportViewDxf(view_id_str: string): string;

export function exportViewVector(view_id_str: string): string;

export function getScene(): any;

/**
 * Details of the single selected element, or null.
 */
export function getSelected(): any;

export function getSelectedConstructionLine(): any;

/**
 * Every currently selected element, with full placement detail.
 */
export function getSelectedElements(): any;

export function getSelectedGridAxis(): any;

export function getSelectedReference(): any;

export function getSelectedSectionCut(): any;

export function getSelectedSpace(): any;

/**
 * Replace the current project by importing an IFC STEP file (tessellated MVP).
 *
 * Returns the usual scene object plus an `ifc_import` summary
 * `{ levels, products, skipped_no_mesh, warnings }` for the status line.
 */
export function importIfc(text: string): any;

/**
 * Replace the current project from pre-tessellated IFC meshes (Apex Y-up metres).
 *
 * `payload_json` matches [`apex_ifc::MeshImportPayload`]:
 * `{ levels: [{name, elevation}], products: [{name, ifc_type, origin, positions, indices, level_index?}] }`.
 * Used by the IFC-Lite / web-ifc PluginHost Open path.
 */
export function importIfcMeshes(payload_json: string): any;

/**
 * Replace the current project from a JSON snapshot.
 */
export function importProject(json: string): any;

/**
 * Initialize the panic hook and an empty project with Level 0.
 */
export function initApp(): void;

/**
 * Recompute path joins for a joinable element (corners / T-junctions).
 *
 * Auto-join already runs on place for `joinable` components; plugins call this
 * after a placement edit. One undo step.
 */
export function joinPaths(id: string): any;

/**
 * Placement snap targets (ends / mids / T-vertices) for joinable peers of
 * `component_id` on the active level. Universal — no wall/beam branches.
 */
export function joinableSnapTargets(component_id: string): any;

/**
 * `{ kernel, pending }` for the status line.
 */
export function kernelStatus(): any;

/**
 * Every installed component. The UI builds its toolbar and inspector from this.
 */
export function listComponents(): any;

/**
 * Every element in the document.
 */
export function listElements(): any;

/**
 * Installed profile types. Empty `category` returns the whole library.
 */
export function listProfiles(category: string): any;

export function moveSheetViewport(sheet_id: string, viewport_id: string, center_x_mm: number, center_y_mm: number): any;

/**
 * Discard the current project and start a blank one with the built-in types.
 */
export function newProject(): any;

/**
 * Resolve a GPU pick id to an element and replace the selection.
 */
export function pickById(pick_id: number): any;

export function placeViewOnSheet(sheet_id: string, view_id: string, center_x_mm: number, center_y_mm: number, width_mm: number, height_mm: number): any;

/**
 * Mesh preview for a component definition before it is registered (visual editor).
 */
export function previewComponentDefinition(definition_json: string, points_json: string, rotation: number, params_json: string, placement_kind: string): any;

/**
 * Geometry for a placement that has not been committed yet.
 *
 * The preview and the real element come from the same recipe, so a ghost can
 * never drift from what actually gets placed. `placement_kind` is the same
 * optional override `createElement` takes.
 */
export function previewElement(component_id: string, points_json: string, rotation: number, params_json: string, placement_kind: string): any;

/**
 * Evaluate a profile spec (or a full `ProfileType`) to a 2D outline for the editor.
 */
export function previewProfile(profile_json: string, params_json: string): any;

/**
 * Ghost mesh for Move preview: selection translated + connected joinable peers
 * stretched. Does not mutate the document.
 */
export function previewStretchTranslate(delta_json: string): any;

export function redo(): any;

/**
 * Install a component at runtime, from a module or the visual editor.
 */
export function registerComponent(definition_json: string): any;

/**
 * Register a plugin geometry generator for opening genera
 * (`opening.generator` in a component). A descriptor is mandatory.
 */
export function registerOpeningGenerator(id: string, descriptor_json: string, generate: Function): any;

/**
 * Install or replace a profile type. Dependent elements are rebuilt.
 */
export function registerProfile(definition_json: string): any;

export function removeSheetViewport(sheet_id: string, viewport_id: string): any;

export function renameSheet(id: string, number: string, name: string): any;

export function renameSpace(id: string, name: string): any;

export function renameView(id: string, name: string): any;

export function resetSheetViewportCrop(sheet_id: string, viewport_id: string): any;

/**
 * Run one serialized read-only `Query` (`{"op": ...}`).
 * `export_ifc` is handled here because core cannot depend on apex-ifc.
 */
export function runQuery(query_json: string): string;

/**
 * Persist camera / plan parameters from the shell into a saved view.
 */
export function saveViewState(id: string, kind_json: string): any;

export function selectConstructionLine(id: string): any;

export function selectElement(id: string): any;

export function selectGridAxis(id: string): any;

export function selectReference(id: string): any;

export function selectSectionCut(id: string): any;

export function selectSpace(id: string): any;

export function setActiveLevel(id: string): any;

export function setConstructionLinePlacement(id: string, points_json: string, rotation: number, record_history: boolean): any;

/**
 * Attach an element to a parent, or detach it by passing `null`.
 *
 * The child takes the parent's level and follows it when moved. One undo step.
 * Returns the ids whose level changed, so the UI can refresh them.
 */
export function setElementParent(id: string, parent_id?: string | null): any;

/**
 * Re-place an existing element from a fresh set of picks.
 *
 * The existing curve type is kept, so dragging an arc wall's handles does
 * not turn it into a polyline. Pass `record_history: false` for live drag
 * previews; the final commit should use the default `true`.
 */
export function setElementPlacement(id: string, points_json: string, rotation: number, record_history: boolean): any;

/**
 * Select the boolean kernel for wall openings: "mesh" (default) or "smlib".
 * With "smlib" the host cuts become jobs (see `takeKernelJobs`); until their
 * results arrive the mesh result is shown.
 */
export function setGeometryKernel(name: string): any;

export function setGridAxisPlacement(id: string, points_json: string, rotation: number, record_history: boolean): any;

export function setLevelElevation(id: string, elevation: number): any;

export function setReferencePlacement(id: string, points_json: string, rotation: number, record_history: boolean): any;

export function setSectionCutPlacement(id: string, points_json: string, rotation: number, record_history: boolean): any;

export function setSheetViewportCrop(sheet_id: string, viewport_id: string, crop_json: string): any;

export function setSheetViewportScale(sheet_id: string, viewport_id: string, scale_denominator: number): any;

/**
 * Replace a slab's shape (`{z, points, creases}`); one undo step.
 */
export function setSlabShape(id: string, shape_json: string): any;

export function setSpacePlacement(id: string, points_json: string, rotation: number, record_history: boolean): any;

/**
 * A slab's editable shape (`{shape, handles, creases, thickness}`), or
 * `null` when the element has none.
 */
export function slabShapeInfo(id: string): any;

/**
 * Queued kernel jobs (removed from the queue).
 */
export function takeKernelJobs(): any;

export function togglePickById(pick_id: number): any;

export function toggleSelectElement(id: string): any;

/**
 * Move the current selection by a world-space offset.
 */
export function translateSelection(delta_json: string, record_history: boolean): any;

export function undo(): any;

export function updateConstructionLine(id: string, params_json: string): any;

/**
 * Patch an element's parameters. Omitted parameters keep their current value.
 */
export function updateElement(id: string, params_json: string): any;

export function updateGridAxis(id: string, params_json: string): any;

/**
 * Patch type-level values on a profile and rebuild every element that uses it.
 */
export function updateProfileType(id: string, params_json: string): any;

export function updateSectionCut(id: string, params_json: string): any;

export function updateSheetLayout(id: string, paper: string, orientation: string, custom_width_mm: number, custom_height_mm: number): any;

export function updateSheetViewportState(sheet_id_str: string, viewport_id_str: string, camera_json: string, lock_navigation: boolean): any;

export function updateSpace(id: string, params_json: string): any;

export function updateViewAnnotation(id: string, kind_json: string): any;

export function updateViewSettings(id: string, settings_json: string): any;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly abortUndoGroup: () => [number, number];
    readonly applyKernelResults: (a: any) => [number, number, number];
    readonly beginUndoGroup: () => [number, number];
    readonly canRedo: () => [number, number, number];
    readonly canUndo: () => [number, number, number];
    readonly childrenOf: (a: number, b: number) => [number, number, number];
    readonly copySelection: (a: number, b: number) => [number, number, number];
    readonly createConstructionLine: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly createElement: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number, number];
    readonly createElementWithParent: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => [number, number, number];
    readonly createGridAxis: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly createLevel: (a: number, b: number, c: number) => [number, number, number];
    readonly createPlanView: (a: number, b: number) => [number, number, number];
    readonly createReference: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly createSectionCut: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly createSheet: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly createSheetWithLayout: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => [number, number, number];
    readonly createSpace: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly createThreeDView: () => [number, number, number];
    readonly createViewAnnotation: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly deleteSelected: () => [number, number, number];
    readonly deleteSelectedConstructionLine: () => [number, number, number];
    readonly deleteSelectedGridAxis: () => [number, number, number];
    readonly deleteSelectedReference: () => [number, number, number];
    readonly deleteSelectedSectionCut: () => [number, number, number];
    readonly deleteSelectedSpace: () => [number, number, number];
    readonly deleteSheet: (a: number, b: number) => [number, number, number];
    readonly deleteView: (a: number, b: number) => [number, number, number];
    readonly deleteViewAnnotation: (a: number, b: number) => [number, number, number];
    readonly descendantsOf: (a: number, b: number) => [number, number, number];
    readonly describeApi: () => [number, number, number, number];
    readonly detectRoomsFromWalls: () => [number, number, number];
    readonly duplicateView: (a: number, b: number) => [number, number, number];
    readonly effectiveLevelOf: (a: number, b: number) => [number, number, number, number];
    readonly executeCommand: (a: number, b: number) => [number, number, number, number];
    readonly exportIfc: (a: number, b: number) => [number, number, number, number];
    readonly exportProject: () => [number, number, number, number];
    readonly exportSheetDxf: (a: number, b: number) => [number, number, number, number];
    readonly exportSheetVector: (a: number, b: number) => [number, number, number, number];
    readonly exportViewDxf: (a: number, b: number) => [number, number, number, number];
    readonly exportViewVector: (a: number, b: number) => [number, number, number, number];
    readonly getScene: () => [number, number, number];
    readonly getSelected: () => [number, number, number];
    readonly getSelectedConstructionLine: () => [number, number, number];
    readonly getSelectedElements: () => [number, number, number];
    readonly getSelectedGridAxis: () => [number, number, number];
    readonly getSelectedReference: () => [number, number, number];
    readonly getSelectedSectionCut: () => [number, number, number];
    readonly getSelectedSpace: () => [number, number, number];
    readonly importIfc: (a: number, b: number) => [number, number, number];
    readonly importIfcMeshes: (a: number, b: number) => [number, number, number];
    readonly importProject: (a: number, b: number) => [number, number, number];
    readonly initApp: () => [number, number];
    readonly joinPaths: (a: number, b: number) => [number, number, number];
    readonly joinableSnapTargets: (a: number, b: number) => [number, number, number];
    readonly kernelStatus: () => [number, number, number];
    readonly listComponents: () => [number, number, number];
    readonly listElements: () => [number, number, number];
    readonly listProfiles: (a: number, b: number) => [number, number, number];
    readonly moveSheetViewport: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly newProject: () => [number, number, number];
    readonly pickById: (a: number) => [number, number, number];
    readonly placeViewOnSheet: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number];
    readonly previewComponentDefinition: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number, number];
    readonly previewElement: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number, number];
    readonly previewProfile: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly previewStretchTranslate: (a: number, b: number) => [number, number, number];
    readonly redo: () => [number, number, number];
    readonly registerComponent: (a: number, b: number) => [number, number, number];
    readonly registerOpeningGenerator: (a: number, b: number, c: number, d: number, e: any) => [number, number, number];
    readonly registerProfile: (a: number, b: number) => [number, number, number];
    readonly removeSheetViewport: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly renameSheet: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly renameSpace: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly renameView: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly resetSheetViewportCrop: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly runQuery: (a: number, b: number) => [number, number, number, number];
    readonly saveViewState: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly selectConstructionLine: (a: number, b: number) => [number, number, number];
    readonly selectElement: (a: number, b: number) => [number, number, number];
    readonly selectGridAxis: (a: number, b: number) => [number, number, number];
    readonly selectReference: (a: number, b: number) => [number, number, number];
    readonly selectSectionCut: (a: number, b: number) => [number, number, number];
    readonly selectSpace: (a: number, b: number) => [number, number, number];
    readonly setActiveLevel: (a: number, b: number) => [number, number, number];
    readonly setConstructionLinePlacement: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly setElementParent: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly setElementPlacement: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly setGeometryKernel: (a: number, b: number) => [number, number, number];
    readonly setGridAxisPlacement: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly setLevelElevation: (a: number, b: number, c: number) => [number, number, number];
    readonly setReferencePlacement: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly setSectionCutPlacement: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly setSheetViewportCrop: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly setSheetViewportScale: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly setSlabShape: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly setSpacePlacement: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly slabShapeInfo: (a: number, b: number) => [number, number, number];
    readonly takeKernelJobs: () => [number, number, number];
    readonly togglePickById: (a: number) => [number, number, number];
    readonly toggleSelectElement: (a: number, b: number) => [number, number, number];
    readonly translateSelection: (a: number, b: number, c: number) => [number, number, number];
    readonly undo: () => [number, number, number];
    readonly updateConstructionLine: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly updateElement: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly updateGridAxis: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly updateProfileType: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly updateSectionCut: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly updateSheetLayout: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number];
    readonly updateSheetViewportState: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number];
    readonly updateSpace: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly updateViewAnnotation: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly updateViewSettings: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
