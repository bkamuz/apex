import { useEffect, useState } from 'react';
import type { SceneDto } from '../types';
import type { ViewportRenderer } from '../viewport/ViewportRenderer';

interface LabelPos {
  key: string;
  text: string;
  left: number;
  top: number;
}

interface Props {
  scene: SceneDto;
  viewId: string;
  renderer: ViewportRenderer | null;
}

/** Dimension / text labels for a saved view on a sheet viewport canvas. */
export function SheetViewAnnotationLabels({ scene, viewId, renderer }: Props) {
  const [labels, setLabels] = useState<LabelPos[]>([]);

  useEffect(() => {
    if (!renderer) {
      setLabels([]);
      return;
    }
    let frame = 0;
    const tick = () => {
      const next: LabelPos[] = [];
      for (const ann of scene.view_annotations ?? []) {
        if (ann.view_id !== viewId) continue;
        for (const label of ann.labels ?? []) {
          const screen = renderer.worldToClient(label.position);
          if (!screen) continue;
          next.push({
            key: `${ann.id}:${label.text}:${label.position.join(',')}`,
            text: label.text,
            left: screen[0],
            top: screen[1],
          });
        }
      }
      setLabels(next);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [scene, viewId, renderer]);

  if (labels.length === 0) return null;

  return (
    <div className="sheet-view-annotation-labels" aria-hidden="true">
      {labels.map((label) => (
        <div
          key={label.key}
          className="sheet-view-annotation-label"
          style={{ left: label.left, top: label.top }}
        >
          {label.text}
        </div>
      ))}
    </div>
  );
}
