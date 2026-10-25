import type { Vec3 } from '../viewport/ViewportRenderer';
import type { ComponentDto, PlacementKind, ReferenceKind } from '../types';
import type { ToolIcon } from './icons';
import type { TransformMode, TransformOriginal } from './transformTypes';

export type { ToolIcon, ToolIconName } from './icons';

/**
 * Services a tool may use. The app supplies a fresh context per event, so a
 * tool never holds a reference to React state.
 */
export interface ToolContext {
  /** Screen point to a world point on the active work plane, with Shift snapping. */
  resolvePoint(clientX: number, clientY: number, shift: boolean, anchor: Vec3 | null): Vec3 | null;
  /** Commit picks as a new element of `componentId`. */
  createElement(componentId: string, points: Vec3[], placementKind?: PlacementKind): void;
  /** Commit picks as a child of `parentId` (openings / host cuts). */
  createElementWithParent(
    componentId: string,
    points: Vec3[],
    parentId: string,
    placementKind?: PlacementKind,
  ): void;
  /** Category of an element, for host-cut eligibility checks. */
  elementCategory(id: string): string | null;
  /** Commit picks as a new document reference. */
  createReference(kind: ReferenceKind, points: Vec3[]): void;
  /** Commit picks as a new plan grid axis. */
  createGridAxis(points: Vec3[]): void;
  /** Commit picks as a new plan construction line. */
  createConstructionLine(points: Vec3[]): void;
  /** Commit picks as a new section-cut MVP. */
  createSectionCut(points: Vec3[]): void;
  /** Commit picks as a closed plan space (≥3 points). */
  createSpace(points: Vec3[]): void;
  /** Detect closed wall loops on the active level; refresh auto spaces. */
  detectRoomsFromWalls(): void;
  /** Add a level +3 m above the highest (same rise as LevelList). */
  createLevel(): void;
  /** Ghost geometry, built by the same recipe the committed element will use. */
  showPreview(componentId: string, points: Vec3[], placementKind?: PlacementKind): void;
  clearPreview(): void;
  /** Construction line through the picks made so far. */
  showPreviewLine(points: Vec3[] | null): void;
  showSnapMarker(point: Vec3 | null, shift: boolean): void;
  /** GPU pick id under the cursor, or null. */
  pick(clientX: number, clientY: number): number | null;
  /** Resolve a viewport click to element or datum selection. */
  selectAt(clientX: number, clientY: number, multi: boolean): void;
  /** Anchor index of the edit handle under the cursor, or null. */
  hitEditHandle(clientX: number, clientY: number): number | null;
  /** Anchors of the selected element, when exactly one is selected. */
  selectedAnchors(): Vec3[] | null;
  /** Live-update the selected element's placement while dragging. */
  previewAnchors(anchors: Vec3[]): void;
  commitAnchors(anchors: Vec3[]): void;
  /** Open a coalesced undo step for the current gesture (e.g. anchor drag). */
  beginUndoGroup(): void;
  /** Drop an open undo group without recording (cancelled gesture). */
  abortUndoGroup(): void;
  setError(message: string | null): void;
  /** Let the tool tell the app how far through its gesture it is. */
  setPending(points: Vec3[]): void;
  /** Suppress camera orbit on touch while a gesture is in flight. */
  setTouchOrbitEnabled(enabled: boolean): void;
  /** Current selection as transform targets (elements, ref, or grid axis). */
  getTransformSelection(): TransformOriginal[] | null;
  /** Ghost-only move preview from captured originals (does not mutate the document). */
  previewTransform(originals: TransformOriginal[], delta: Vec3): void;
  /** Commit a move or copy after base → target picks. */
  commitTransform(originals: TransformOriginal[], delta: Vec3, mode: TransformMode): void;
  /** Clear a cancelled move ghost (document was never mutated during preview). */
  restoreTransformOriginals(originals: TransformOriginal[]): void;
  /** Element id under the cursor, or null. Distinct from `pick`, which returns a GPU pick id. */
  pickElementId(clientX: number, clientY: number): string | null;
  /** Ids of the currently selected elements. */
  selectedElementIds(): string[];
  /** The parent of `id`, or null when it is a root. */
  elementParentId(id: string): string | null;
  /** A world point to highlight for `id` — its placement origin. */
  anchorOf(id: string): Vec3;
  /** Apply a scene returned by a core mutation. */
  applyScene(scene: unknown): void;
  /** Active saved view tab id, or null when a sheet or no view tab is open. */
  activeViewId(): string | null;
  /** Create a view-owned annotation on a saved view. */
  createViewAnnotation(viewId: string, kind: unknown): void;
}

/** Toolbar clusters: select, transform (move/copy/…), then create tools. */
export type ToolGroup = 'select' | 'transform' | 'create';

/**
 * Toolbar tab a tool may declare.
 *
 * Prefer a catalog entry from `ApexTabs` / `TOOL_TABS` (stable id + default
 * label). `label` may be omitted when `id` is in the catalog — the catalog
 * default is used. A custom id not in the catalog creates a new tab; supply a
 * label (otherwise the id is shown). First registration wins for the resolved
 * label when several tools share an id. Empty tabs are never shown.
 */
export interface ToolTab {
  id: string;
  label?: string;
}

/** Tab after catalog / fallback resolution (always has a display label). */
export interface ResolvedToolTab {
  id: string;
  label: string;
}

/** A drawable sub-mode of a create tool (e.g. wall line / arc / polyline). */
export interface ToolMode {
  id: string;
  label: string;
  placement: PlacementKind;
}

export interface PointerInfo {
  clientX: number;
  clientY: number;
  shift: boolean;
  multi: boolean;
}

export interface Tool {
  readonly id: string;
  readonly label: string;
  /** Toolbar cluster. Select and transform sit before create tools. */
  readonly group?: ToolGroup;
  /**
   * When set, the tool's button lives under this tab instead of the flat
   * create row. Prefer `ApexTabs.building` / `ApexTabs.basics` /
   * `ApexTabs.engineering` / `ApexTabs.spaces` (or another catalog
   * entry); a custom `{ id, label }` creates a new tab.
   * Select/transform tools usually omit it (always pinned).
   */
  readonly tab?: ToolTab;
  /**
   * Optional toolbar glyph. Prefer a catalog name (`ApexIcons.wall` /
   * `window.apex.icons.wall`). Pass `{ svg: string }` for a custom glyph.
   * Omit or use an unknown name → label-only (no broken image).
   */
  readonly icon?: ToolIcon;
  /** Letter hotkey shown in the button tooltip, when set. */
  readonly shortcut?: string;
  /** Component this tool places, for placement tools. */
  readonly componentId?: string;
  /** Sub-modes of this tool (e.g. wall line / arc / polyline). */
  readonly modes?: readonly ToolMode[];
  getMode?(): string;
  setMode?(id: string): void;
  /** Gesture currently used to interpret picks. */
  placementKind?(): PlacementKind;
  /** Status line shown while the tool is active. */
  hint(pendingCount: number): string;
  onClick?(e: PointerInfo, ctx: ToolContext): void;
  /** Return true to claim the gesture and suppress the following click. */
  onPointerDown?(e: PointerInfo, ctx: ToolContext): boolean;
  onPointerMove?(e: PointerInfo, ctx: ToolContext): void;
  onPointerUp?(e: PointerInfo, ctx: ToolContext): void;
  /** Escape, tool switch, or anything else that abandons the gesture. */
  cancel?(ctx: ToolContext): void;
  /**
   * Finish a variable-length gesture (polyline) on Enter / double-click.
   * Return true when the finish was handled (even if rejected for too few picks).
   */
  finishGesture?(picks: Vec3[], ctx: ToolContext): boolean;
  /** Adjust pick elevation for free-elevation path tools (MEP). */
  nudgeElevation?(delta: number): void;
}

/** How many picks a gesture needs; null means "until the user says stop". */
export function requiredPoints(kind: PlacementKind): number | null {
  switch (kind) {
    case 'point':
      return 1;
    case 'two_point':
      return 2;
    case 'three_point_arc':
      return 3;
    case 'polyline':
    case 'path':
      return null;
    case 'free':
      return 0;
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

export function toolIdForComponent(component: ComponentDto): string {
  return `place:${component.id}`;
}
