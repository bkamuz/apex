/* tslint:disable */
/* eslint-disable */

/**
 * Create a new level. Empty name → auto "Level N". Returns updated scene.
 */
export function createLevel(name: string, elevation: number): any;

/**
 * Create a wall from two points on the active level. Returns updated scene JSON.
 */
export function createWall(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, height: number, thickness: number): any;

/**
 * Delete all selected elements.
 */
export function deleteSelected(): any;

/**
 * Full scene buffers for the viewport.
 */
export function getScene(): any;

/**
 * Selected element details when exactly one is selected (otherwise null).
 */
export function getSelected(): any;

/**
 * Initialize panic hook and empty document with Level 0.
 */
export function initApp(): void;

/**
 * List all elements.
 */
export function listElements(): any;

/**
 * Pick by GPU pick id (1-based sequential). Replaces selection.
 */
export function pickById(pick_id: number): any;

/**
 * Replace selection with one element (or clear with empty string).
 */
export function selectElement(id: string): any;

/**
 * Activate a level as the current work plane.
 */
export function setActiveLevel(id: string): any;

/**
 * Change a level's elevation; walls on that level move with it.
 */
export function setLevelElevation(id: string, elevation: number): any;

/**
 * Update wall parameters by element id. Returns updated scene.
 */
export function setWallParams(id: string, height: number, thickness: number, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): any;

/**
 * Toggle selection by GPU pick id (Ctrl/Cmd+click).
 */
export function togglePickById(pick_id: number): any;

/**
 * Toggle one element in/out of the selection (Ctrl/Cmd multi-select).
 */
export function toggleSelectElement(id: string): any;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly createLevel: (a: number, b: number, c: number) => [number, number, number];
    readonly createWall: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number];
    readonly deleteSelected: () => [number, number, number];
    readonly getScene: () => [number, number, number];
    readonly getSelected: () => [number, number, number];
    readonly initApp: () => [number, number];
    readonly listElements: () => [number, number, number];
    readonly pickById: (a: number) => [number, number, number];
    readonly selectElement: (a: number, b: number) => [number, number, number];
    readonly setActiveLevel: (a: number, b: number) => [number, number, number];
    readonly setLevelElevation: (a: number, b: number, c: number) => [number, number, number];
    readonly setWallParams: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => [number, number, number];
    readonly togglePickById: (a: number) => [number, number, number];
    readonly toggleSelectElement: (a: number, b: number) => [number, number, number];
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
