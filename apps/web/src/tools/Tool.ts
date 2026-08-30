import type { Vec3 } from '../viewport/ViewportRenderer';
import type { ComponentDto, PlacementKind } from '../types';

/**
 * Services a tool may use. The app supplies a fresh context per event, so a
 * tool never holds a reference to React state.
 */
export interface ToolContext {
  /** Screen point to a world point on the active work plane, with Shift snapping. */
  resolvePoint(clientX: number, clientY: number, shift: boolean, anchor: Vec3 | null): Vec3 | null;
  /** Commit picks as a new element of `componentId`. */
  createElement(componentId: string, points: Vec3[]): void;
  /** Ghost geometry, built by the same recipe the committed element will use. */
  showPreview(componentId: string, points: Vec3[]): void;
  clearPreview(): void;
  /** Construction line through the picks made so far. */
  showPreviewLine(points: Vec3[] | null): void;
  showSnapMarker(point: Vec3 | null, shift: boolean): void;
  /** GPU pick id under the cursor, or null. */
  pick(clientX: number, clientY: number): number | null;
  selectByPick(pickId: number | null, multi: boolean): void;
  /** Anchor index of the edit handle under the cursor, or null. */
  hitEditHandle(clientX: number, clientY: number): number | null;
  /** Anchors of the selected element, when exactly one is selected. */
  selectedAnchors(): Vec3[] | null;
  /** Live-update the selected element's placement while dragging. */
  previewAnchors(anchors: Vec3[]): void;
  commitAnchors(anchors: Vec3[]): void;
  setError(message: string | null): void;
  /** Let the tool tell the app how far through its gesture it is. */
  setPending(points: Vec3[]): void;
  /** Suppress camera orbit on touch while a gesture is in flight. */
  setTouchOrbitEnabled(enabled: boolean): void;
}

export type ToolGroup = 'select' | 'create';

export interface PointerInfo {
  clientX: number;
  clientY: number;
  shift: boolean;
  multi: boolean;
}

export interface Tool {
  readonly id: string;
  readonly label: string;
  /** Toolbar cluster. Select sits apart from the create tools. */
  readonly group?: ToolGroup;
  /** Component this tool places, for placement tools. */
  readonly componentId?: string;
  /** Status line shown while the tool is active. */
  hint(pendingCount: number): string;
  onClick?(e: PointerInfo, ctx: ToolContext): void;
  /** Return true to claim the gesture and suppress the following click. */
  onPointerDown?(e: PointerInfo, ctx: ToolContext): boolean;
  onPointerMove?(e: PointerInfo, ctx: ToolContext): void;
  onPointerUp?(e: PointerInfo, ctx: ToolContext): void;
  /** Escape, tool switch, or anything else that abandons the gesture. */
  cancel?(ctx: ToolContext): void;
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
