import { useEffect, useState } from 'react';
import type { ElementDto, LevelDto } from '../types';

interface Props {
  selected: ElementDto | null;
  /** Total selection size (0, 1, or many). */
  selectedCount: number;
  selectedLevel: LevelDto | null;
  onUpdate: (patch: {
    height: number;
    thickness: number;
    start: [number, number, number];
    end: [number, number, number];
  }) => void;
  onUpdateLevelElevation: (id: string, elevation: number) => void;
  onDelete: () => void;
}

export function PropertiesPanel({
  selected,
  selectedCount,
  selectedLevel,
  onUpdate,
  onUpdateLevelElevation,
  onDelete,
}: Props) {
  const [height, setHeight] = useState(3);
  const [thickness, setThickness] = useState(0.2);
  const [elevation, setElevation] = useState(0);

  useEffect(() => {
    if (!selected || selected.category !== 'wall') return;
    setHeight(selected.height ?? 3);
    setThickness(selected.thickness ?? 0.2);
  }, [selected]);

  useEffect(() => {
    if (!selectedLevel) return;
    setElevation(selectedLevel.elevation);
  }, [selectedLevel]);

  if (selectedCount > 1) {
    return (
      <div className="inspector-body">
        <div className="empty">{selectedCount} walls selected</div>
        <button type="button" className="danger" onClick={onDelete}>
          Delete selected
        </button>
      </div>
    );
  }

  if (selectedCount === 1 && selected?.category === 'wall' && selected.start && selected.end) {
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

  if (selectedLevel) {
    const applyLevel = () => {
      onUpdateLevelElevation(selectedLevel.id, elevation);
    };
    return (
      <div className="inspector-body">
        <div className="field">
          <label>Level</label>
          <div>{selectedLevel.name}</div>
        </div>
        <div className="field">
          <label>Elevation</label>
          <input
            type="number"
            step={0.1}
            value={Number(elevation.toFixed(3))}
            onChange={(e) => setElevation(Number(e.target.value))}
            onBlur={applyLevel}
            onKeyDown={(e) => e.key === 'Enter' && applyLevel()}
          />
        </div>
        <button type="button" onClick={applyLevel}>
          Apply elevation
        </button>
        <div className="empty" style={{ padding: 0 }}>
          Double-click the level contour in the viewport to make it the active work plane.
        </div>
      </div>
    );
  }

  if (selected) {
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

  return (
    <div className="empty">
      Select a wall or a level. Double-click a level contour to activate its work plane.
    </div>
  );
}
