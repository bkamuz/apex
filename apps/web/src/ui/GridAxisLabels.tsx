import { useEffect, useState } from 'react';
import { useI18n } from '../i18n';
import type { GridAxisDto, SpaceDto } from '../types';
import type { ViewportRenderer } from '../viewport/ViewportRenderer';
import { localizeDocumentName } from './sampleLabels';
import { separateSpaceLabels } from './spaceLabelLayout';

interface LabelPos {
  key: string;
  text: string;
  left: number;
  top: number;
  kind: 'grid' | 'space';
  selected?: boolean;
  /** Room width in CSS pixels; the tag wraps inside it. */
  maxWidth?: number;
  /** World XYZ for occlusion / Playwright probes. */
  world: [number, number, number];
}

interface Props {
  axes: GridAxisDto[];
  spaces?: SpaceDto[];
  renderer: ViewportRenderer | null;
  selectedIds?: string[];
}

/** Screen-space labels for grid bubbles and space centroids. */
export function GridAxisLabels({ axes, spaces = [], renderer, selectedIds = [] }: Props) {
  const { locale } = useI18n();
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
            world: [label.position[0], label.position[1], label.position[2]],
          });
        }
      }
      // Spaces are a plan concept (WebGL outlines only draw in plan) — keep
      // HTML labels in sync so they do not float through the 3D solid model.
      if (plan) {
        const roomTags: LabelPos[] = [];
        for (const space of spaces) {
          let minX = Infinity;
          let maxX = -Infinity;
          for (const anchor of space.anchors) {
            const corner = renderer.worldToClient(anchor);
            if (!corner) continue;
            if (corner[0] < minX) minX = corner[0];
            if (corner[0] > maxX) maxX = corner[0];
          }
          const maxWidth = Number.isFinite(minX) ? Math.max(92, maxX - minX - 8) : undefined;
          for (const label of space.labels ?? []) {
            const screen = renderer.worldToClient(label.position);
            if (!screen) continue;
            roomTags.push({
              key: `space:${space.id}:${label.text}:${label.position.join(',')}`,
              text: label.text,
              left: screen[0],
              top: screen[1],
              kind: 'space',
              maxWidth,
              world: [label.position[0], label.position[1], label.position[2]],
            });
          }
        }
        const layout = roomTags.map((label) => ({
          left: label.left,
          top: label.top,
          text: localizeDocumentName(label.text),
          maxWidth: label.maxWidth,
        }));
        separateSpaceLabels(layout);
        for (let i = 0; i < roomTags.length; i += 1) {
          roomTags[i].left = layout[i].left;
          roomTags[i].top = layout[i].top;
        }
        next.push(...roomTags);
      }
      setLabels(next);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [axes, spaces, renderer, selectedIds, locale]);

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
          data-world={label.world.join(',')}
          style={{
            left: label.left,
            top: label.top,
            maxWidth: label.maxWidth,
          }}
        >
          {localizeDocumentName(label.text)}
        </div>
      ))}
    </div>
  );
}
