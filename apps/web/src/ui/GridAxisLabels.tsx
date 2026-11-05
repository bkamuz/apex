import { useEffect, useState } from 'react';
import type { GridAxisDto, SpaceDto } from '../types';
import type { ViewportRenderer } from '../viewport/ViewportRenderer';

interface LabelPos {
  key: string;
  text: string;
  left: number;
  top: number;
  kind: 'grid' | 'space';
  selected?: boolean;
}

interface Props {
  axes: GridAxisDto[];
  spaces?: SpaceDto[];
  renderer: ViewportRenderer | null;
  selectedIds?: string[];
}

/** Screen-space labels for grid bubbles and space centroids. */
export function GridAxisLabels({ axes, spaces = [], renderer, selectedIds = [] }: Props) {
  const [labels, setLabels] = useState<LabelPos[]>([]);

  useEffect(() => {
    if (!renderer) {
      setLabels([]);
      return;
    }
    let frame = 0;
    const tick = () => {
      const next: LabelPos[] = [];
      const plan = renderer.getViewNavigation() === 'plan';
      // One depth bake for all heads this frame (3D only).
      if (!plan) renderer.beginOverlayOcclusion();

      for (const axis of axes) {
        for (const label of axis.labels ?? []) {
          // In 3D, hide heads whose world point sits behind opaque solids.
          if (!plan && renderer.isWorldOccluded(label.position)) continue;
          const screen = renderer.worldToClient(label.position);
          if (!screen) continue;
          next.push({
            key: `${axis.id}:${label.text}:${label.position.join(',')}`,
            text: label.text,
            left: screen[0],
            top: screen[1],
            kind: 'grid',
            selected: selectedIds.includes(axis.id),
          });
        }
      }
      // Spaces are a plan concept (WebGL outlines only draw in plan) — keep
      // HTML labels in sync so they do not float through the 3D solid model.
      if (plan) {
        for (const space of spaces) {
          for (const label of space.labels ?? []) {
            const screen = renderer.worldToClient(label.position);
            if (!screen) continue;
            next.push({
              key: `space:${space.id}:${label.text}:${label.position.join(',')}`,
              text: label.text,
              left: screen[0],
              top: screen[1],
              kind: 'space',
            });
          }
        }
      }
      setLabels(next);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [axes, spaces, renderer, selectedIds]);

  if (labels.length === 0) return null;

  return (
    <div className="grid-axis-labels" aria-hidden="true">
      {labels.map((label) => (
        <div
          key={label.key}
          className={
            label.kind === 'space'
              ? 'space-label'
              : `grid-axis-label${label.selected ? ' is-selected' : ''}`
          }
          style={{ left: label.left, top: label.top }}
        >
          {label.text}
        </div>
      ))}
    </div>
  );
}
