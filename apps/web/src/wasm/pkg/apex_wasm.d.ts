/* tslint:disable */
/* eslint-disable */

/**
 * Place a component from the raw picks the user made.
 *
 * The component's own `PlacementKind` decides how the points are interpreted
 * unless `placement_kind` names a more specific gesture. A path component
 * (wall) uses that override so line, arc and polyline share one type.
 */
export function createElement(component_id: string, points_json: string, rotation: number, params_json: string, placement_kind: string): any;

export function createLevel(name: string, elevation: number): any;

/**
 * Delete every selected element.
 */
export function deleteSelected(): any;

/**
 * JSON snapshot of the document, profiles, and extra components.
 */
export function exportProject(): string;

export function getScene(): any;

/**
 * Details of the single selected element, or null.
 */
export function getSelected(): any;

/**
 * Replace the current project from a JSON snapshot.
 */
export function importProject(json: string): any;

/**
 * Initialize the panic hook and an empty project with Level 0.
 */
export function initApp(): void;

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

/**
 * Discard the current project and start a blank one with the built-in types.
 */
export function newProject(): any;

/**
 * Resolve a GPU pick id to an element and replace the selection.
 */
export function pickById(pick_id: number): any;

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
 * Install a component at runtime, from a module or the visual editor.
 */
export function registerComponent(definition_json: string): any;

/**
 * Install or replace a profile type. Dependent elements are rebuilt.
 */
export function registerProfile(definition_json: string): any;

export function selectElement(id: string): any;

export function setActiveLevel(id: string): any;

/**
 * Re-place an existing element from a fresh set of picks.
 *
 * The existing curve type is kept, so dragging an arc wall's handles does
 * not turn it into a polyline.
 */
export function setElementPlacement(id: string, points_json: string, rotation: number): any;

export function setLevelElevation(id: string, elevation: number): any;

export function togglePickById(pick_id: number): any;

export function toggleSelectElement(id: string): any;

/**
 * Patch an element's parameters. Omitted parameters keep their current value.
 */
export function updateElement(id: string, params_json: string): any;

/**
 * Patch type-level values on a profile and rebuild every element that uses it.
 */
export function updateProfileType(id: string, params_json: string): any;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly createElement: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number, number];
    readonly createLevel: (a: number, b: number, c: number) => [number, number, number];
    readonly deleteSelected: () => [number, number, number];
    readonly exportProject: () => [number, number, number, number];
    readonly getScene: () => [number, number, number];
    readonly getSelected: () => [number, number, number];
    readonly importProject: (a: number, b: number) => [number, number, number];
    readonly initApp: () => [number, number];
    readonly listComponents: () => [number, number, number];
    readonly listElements: () => [number, number, number];
    readonly listProfiles: (a: number, b: number) => [number, number, number];
    readonly newProject: () => [number, number, number];
    readonly pickById: (a: number) => [number, number, number];
    readonly previewElement: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number, number];
    readonly previewProfile: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly registerComponent: (a: number, b: number) => [number, number, number];
    readonly registerProfile: (a: number, b: number) => [number, number, number];
    readonly selectElement: (a: number, b: number) => [number, number, number];
    readonly setActiveLevel: (a: number, b: number) => [number, number, number];
    readonly setElementPlacement: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly setLevelElevation: (a: number, b: number, c: number) => [number, number, number];
    readonly togglePickById: (a: number) => [number, number, number];
    readonly toggleSelectElement: (a: number, b: number) => [number, number, number];
    readonly updateElement: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly updateProfileType: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
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
