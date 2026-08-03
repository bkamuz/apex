import { useEffect, useState } from 'react';
import type { ElementDto } from '../types';

interface Props {
  selected: ElementDto | null;
  onUpdate: (patch: {
    height: number;
    thickness: number;
    start: [number, number, number];
    end: [number, number, number];
  }) => void;
  onDelete: () => void;
}

export function PropertiesPanel({ selected, onUpdate, onDelete }: Props) {
  const [height, setHeight] = useState(3);
  const [thickness, setThickness] = useState(0.2);

  useEffect(() => {
    if (!selected || selected.category !== 'wall') return;
    setHeight(selected.height ?? 3);
    setThickness(selected.thickness ?? 0.2);
  }, [selected]);

  if (!selected) {
    return <div className="empty">Select a wall to edit height and thickness.</div>;
  }

  if (selected.category !== 'wall' || !selected.start || !selected.end) {
    return (
      <div className="inspector-body">
        <div className="field">
          <label>Name</label>
          <div>{selected.name}</div>
        </div>
        <div className="field">
          <label>Category</label>
          <div>{selected.category}</div>
        </div>
      </div>
    );
  }

  const apply = () => {
    onUpdate({
      height,
      thickness,
      start: selected.start as [number, number, number],
      end: selected.end as [number, number, number],
    });
  };

  return (
    <div className="inspector-body">
      <div className="field">
        <label>Name</label>
        <div>{selected.name}</div>
      </div>
      <div className="field">
        <label>Length</label>
        <div>{(selected.length ?? 0).toFixed(3)} m</div>
      </div>
      <div className="field-row">
        <div className="field">
          <label>Height</label>
          <input
            type="number"
            min={0.1}
            step={0.1}
            value={Number(height.toFixed(3))}
            onChange={(e) => setHeight(Number(e.target.value))}
            onBlur={apply}
            onKeyDown={(e) => e.key === 'Enter' && apply()}
          />
        </div>
        <div className="field">
          <label>Thickness</label>
          <input
            type="number"
            min={0.05}
            step={0.05}
            value={Number(thickness.toFixed(3))}
            onChange={(e) => setThickness(Number(e.target.value))}
            onBlur={apply}
            onKeyDown={(e) => e.key === 'Enter' && apply()}
          />
        </div>
      </div>
      <button type="button" onClick={apply}>
        Apply
      </button>
      <button type="button" className="danger" onClick={onDelete}>
        Delete
      </button>
    </div>
  );
}
