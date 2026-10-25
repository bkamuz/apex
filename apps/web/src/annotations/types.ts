import type { ViewAnnotationDto, ViewAnnotationKindDto } from '../types';
import type { Tool } from '../tools/Tool';
import type { ViewportRenderer } from '../viewport/ViewportRenderer';

/** Stable id matching `ViewAnnotationKindDto.kind` (e.g. `linear_dimension`). */
export type AnnotationKindId = ViewAnnotationKindDto['kind'];

/**
 * Extension hooks for a view-owned annotation kind.
 * Geometry and persistence stay in apex-core; the shell uses these for tools and picking.
 */
export interface AnnotationKindRegistration {
  /** Matches the core `ViewAnnotationKind` tag (`linear_dimension`, `text_note`, …). */
  kind: AnnotationKindId;
  /** Toolbar tool(s) that create this annotation on a saved view. */
  tools: Tool[];
  /** Optional label in browser / inspector lists. */
  displayName?: string;
  /** Round-trip for module-defined kinds (built-ins use core JSON as-is). */
  serialize?(kind: ViewAnnotationKindDto): unknown;
  deserialize?(payload: unknown): ViewAnnotationKindDto;
  /** Screen-space hit test for selecting an annotation (plan views). */
  hitTest?(
    annotation: ViewAnnotationDto,
    clientX: number,
    clientY: number,
    renderer: ViewportRenderer,
  ): boolean;
}
