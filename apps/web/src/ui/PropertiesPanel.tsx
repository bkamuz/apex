import { useEffect, useState } from 'react';
import type { ComponentDto, ElementDto, LevelDto, ParamSpecDto, ParamValue } from '../types';

interface Props {
  selected: ElementDto | null;
  /** Total selection size (0, 1, or many). */
  selectedCount: number;
  /** Definition of the selected element's component, which supplies the schema. */
  component: ComponentDto | null;
  selectedLevel: LevelDto | null;
  onUpdate: (params: Record<string, ParamValue>) => void;
  onUpdateLevelElevation: (id: string, elevation: number) => void;
  onDelete: () => void;
}

function stepFor(spec: ParamSpecDto): number {
  return spec.kind === 'angle' ? 0.05 : 0.05;
}

function optionLabel(kind: ParamSpecDto['kind'], option: string): string {
  if (kind !== 'profile') return option;
  switch (option) {
    case 'apex.rect':
    case 'apex.wall.rect':
      return 'Rectangle';
    case 'apex.round':
    case 'apex.wall.round':
      return 'Round';
    default: {
      const leaf = option.includes('.') ? option.slice(option.lastIndexOf('.') + 1) : option;
      return leaf.charAt(0).toUpperCase() + leaf.slice(1);
    }
  }
}

/** One control per parameter, chosen from the declared kind. */
function ParamField({
  spec,
  value,
  onChange,
  onCommit,
}: {
  spec: ParamSpecDto;
  value: ParamValue;
  onChange: (value: ParamValue) => void;
  /** Immediate commit, used when the new value is known in this event (select/checkbox). */
  onCommit: (value?: ParamValue) => void;
}) {
  const label = spec.unit ? `${spec.label} (${spec.unit})` : spec.label;

  switch (spec.kind) {
    case 'bool':
      return (
        <div className="field">
          <label>{label}</label>
          <input
            type="checkbox"
            checked={Boolean(value)}
            onChange={(e) => onCommit(e.target.checked)}
          />
        </div>
      );

    case 'choice':
    case 'profile':
      return (
        <div className="field">
          <label>{label}</label>
          <select value={String(value ?? '')} onChange={(e) => onCommit(e.target.value)}>
            {(spec.options ?? []).map((option) => (
              <option key={option} value={option}>
                {optionLabel(spec.kind, option)}
              </option>
            ))}
          </select>
        </div>
      );

    case 'text':
      return (
        <div className="field">
          <label>{label}</label>
          <input
            type="text"
            value={String(value ?? '')}
            onChange={(e) => onChange(e.target.value)}
            onBlur={() => onCommit()}
            onKeyDown={(e) => e.key === 'Enter' && onCommit()}
          />
        </div>
      );

    case 'length':
    case 'angle':
    case 'number':
      return (
        <div className="field">
          <label>{label}</label>
          <input
            type="number"
            min={spec.min}
            max={spec.max}
            step={stepFor(spec)}
            value={Number(Number(value ?? 0).toFixed(4))}
            onChange={(e) => onChange(Number(e.target.value))}
            onBlur={() => onCommit()}
            onKeyDown={(e) => e.key === 'Enter' && onCommit()}
          />
        </div>
      );

    default: {
      const exhaustive: never = spec.kind;
      void exhaustive;
      return null;
    }
  }
}

export function PropertiesPanel({
  selected,
  selectedCount,
  component,
  selectedLevel,
  onUpdate,
  onUpdateLevelElevation,
  onDelete,
}: Props) {
  const [draft, setDraft] = useState<Record<string, ParamValue>>({});
  const [elevation, setElevation] = useState(0);

  // Reset the draft whenever a different element (or version) arrives.
  useEffect(() => {
    setDraft(selected ? { ...selected.params } : {});
  }, [selected]);

  useEffect(() => {
    if (!selectedLevel) return;
    setElevation(selectedLevel.elevation);
  }, [selectedLevel]);

  if (selectedCount > 1) {
    return (
      <div className="inspector-body">
        <div className="empty">{selectedCount} elements selected</div>
        <button type="button" className="danger" onClick={onDelete}>
          Delete selected
        </button>
      </div>
    );
  }

  if (selectedCount === 1 && selected) {
    const specs = component?.params ?? [];
    const apply = (patch: Record<string, ParamValue> = {}) => {
      const next = { ...draft, ...patch };
      setDraft(next);
      onUpdate(next);
    };

    return (
      <div className="inspector-body">
        <div className="field">
          <label>Name</label>
          <div>{selected.name}</div>
        </div>
        <div className="field">
          <label>Type</label>
          <div>{component?.display_name ?? selected.component_id}</div>
        </div>
        {selected.length != null ? (
          <div className="field">
            <label>Length</label>
            <div>{selected.length.toFixed(3)} m</div>
          </div>
        ) : null}

        {specs.map((spec) => (
          <ParamField
            key={spec.id}
            spec={spec}
            value={draft[spec.id] ?? spec.default}
            onChange={(value) => setDraft((prev) => ({ ...prev, [spec.id]: value }))}
            onCommit={(value) => apply(value === undefined ? {} : { [spec.id]: value })}
          />
        ))}

        {specs.length > 0 ? (
          <button type="button" onClick={() => apply()}>
            Apply
          </button>
        ) : null}
        <button type="button" className="danger" onClick={onDelete}>
          Delete
        </button>
      </div>
    );
  }

  if (selectedLevel) {
    const applyLevel = () => onUpdateLevelElevation(selectedLevel.id, elevation);
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
          Double-click the level plane (or its contour) in the viewport to activate it.
        </div>
      </div>
    );
  }

  return (
    <div className="empty">
      Select an element or a level. Double-click a level contour to activate its work plane.
    </div>
  );
}
