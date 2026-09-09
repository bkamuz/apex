import { useEffect, useState } from 'react';
import type { GridAxisDto } from '../types';
import type { ViewportRenderer } from '../viewport/ViewportRenderer';

interface LabelPos {
  key: string;
  text: string;
  left: number;
  top: number;
}

interface Props {
  axes: GridAxisDto[];
  renderer: ViewportRenderer | null;
}

/** Screen-space labels for grid axis bubbles (simple text until a full 2D annotation system exists). */
export function GridAxisLabels({ axes, renderer }: Props) {
  const [labels, setLabels] = useState<LabelPos[]>([]);

  useEffect(() => {
    if (!renderer) {
      setLabels([]);
      return;
    }
    let frame = 0;
    const tick = () => {
      const next: LabelPos[] = [];
      for (const axis of axes) {
        for (const label of axis.labels ?? []) {
          const screen = renderer.worldToClient(label.position);
          if (!screen) continue;
          next.push({
            key: `${axis.id}:${label.text}:${label.position.join(',')}`,
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
  }, [axes, renderer]);

  if (labels.length === 0) return null;

  return (
    <div className="grid-axis-labels" aria-hidden="true">
      {labels.map((label) => (
        <div
          key={label.key}
          className="grid-axis-label"
          style={{ left: label.left, top: label.top }}
        >
          {label.text}
        </div>
      ))}
    </div>
  );
}
