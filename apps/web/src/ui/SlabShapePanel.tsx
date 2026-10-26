import { useEffect, useState } from 'react';
import type { SlabShapeDto, SlabShapeInfoDto } from '../types';

/** Element types whose top surface can be shaped (Revit "Modify Sub Elements"). */
export const SHAPEABLE_COMPONENTS = new Set(['apex.slab', 'apex.roof']);
/** The raw JSON param the panel edits; hidden from the generic fields. */
export const SHAPE_PARAM = 'shape';

interface Props {
  info: SlabShapeInfoDto | null;
  editing: boolean;
  /** Handle picked in the viewport (crease numbering), highlighted here. */
  activeHandle: number | null;
  onToggleEditing: () => void;
  onChange: (shape: SlabShapeDto) => void;
}

function cloneShape(shape: SlabShapeDto, vertices: number): SlabShapeDto {
  const z = Array.from({ length: vertices }, (_, i) => shape.z[i] ?? 0);
  return {
    z,
    points: shape.points.map((p) => [...p] as [number, number, number]),
    creases: shape.creases.map((c) => [...c] as [number, number]),
  };
}

function OffsetInput({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
  const [text, setText] = useState(String(Number(value.toFixed(4))));
  useEffect(() => setText(String(Number(value.toFixed(4)))), [value]);
  const commit = () => {
    const v = Number(text);
    if (Number.isFinite(v) && Math.abs(v - value) > 1e-9) onCommit(v);
  };
  return (
    <input
      type="number"
      step={0.05}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && commit()}
    />
  );
}

/** Inspector section: per-point Z offsets, interior points, creases, reset. */
export function SlabShapePanel({ info, editing, activeHandle, onToggleEditing, onChange }: Props) {
  const [creaseA, setCreaseA] = useState(0);
  const [creaseB, setCreaseB] = useState(1);
  if (!info) return null;
  const vertices = info.handles.filter((h) => h.kind === 'vertex').length;
  const base = () => cloneShape(info.shape, vertices);
  const label = (index: number) => {
    const h = info.handles.find((item) => item.crease_index === index);
    return h ? (h.kind === 'vertex' ? `V${h.index + 1}` : `P${h.index + 1}`) : `#${index}`;
  };
  const flat =
    info.shape.z.every((v) => Math.abs(v) < 1e-9) &&
    info.shape.points.length === 0 &&
    info.shape.creases.length === 0;
  const centroid = () => {
    const vs = info.handles.filter((h) => h.kind === 'vertex');
    const x = vs.reduce((s, h) => s + h.position[0], 0) / vs.length;
    const z = vs.reduce((s, h) => s + h.position[2], 0) / vs.length;
    return [x, z];
  };

  return (
    <div className="inspector-section" data-section="slab-shape">
      <div className="section-title">Shape (sub-elements)</div>
      <div className="parent-row">
        <button
          type="button"
          data-testid="slab-shape-edit"
          className={editing ? 'active' : undefined}
          onClick={onToggleEditing}
        >
          {editing ? 'Finish editing' : 'Edit shape'}
        </button>
        <button
          type="button"
          data-testid="slab-shape-reset"
          disabled={flat}
          onClick={() => onChange({ z: [], points: [], creases: [] })}
        >
          Reset shape
        </button>
      </div>
      <div className="empty" style={{ padding: 0, margin: '4px 0' }}>
        {editing
          ? 'Drag a point up/down in 3D, or type its offset. Thickness stays constant (vertical).'
          : `Thickness ${info.thickness.toFixed(3)} m, measured vertically.`}
      </div>
      {editing ? (
        <>
          {info.handles.map((h) => (
            <div
              className="field"
              key={`${h.kind}-${h.index}`}
              data-testid={`shape-handle-${h.crease_index}`}
              style={activeHandle === h.crease_index ? { outline: '1px solid var(--accent, #4af)' } : undefined}
            >
              <label>
                {label(h.crease_index)} Z offset
                {h.kind === 'point'
                  ? ` (${h.position[0].toFixed(2)}, ${h.position[2].toFixed(2)})`
                  : ''}
              </label>
              <div className="parent-row">
                <OffsetInput
                  value={h.offset}
                  onCommit={(v) => {
                    const next = base();
                    if (h.kind === 'vertex') next.z[h.index] = v;
                    else next.points[h.index][2] = v;
                    onChange(next);
                  }}
                />
                {h.kind === 'point' ? (
                  <button
                    type="button"
                    onClick={() => {
                      const next = base();
                      next.points.splice(h.index, 1);
                      const removed = h.crease_index;
                      next.creases = next.creases
                        .filter((c) => c[0] !== removed && c[1] !== removed)
                        .map((c) => c.map((i) => (i > removed ? i - 1 : i)) as [number, number]);
                      onChange(next);
                    }}
                  >
                    ✕
                  </button>
                ) : null}
              </div>
            </div>
          ))}
          <button
            type="button"
            data-testid="slab-shape-add-point"
            onClick={() => {
              const next = base();
              const [x, z] = centroid();
              next.points.push([x, z, 0]);
              onChange(next);
            }}
          >
            Add point (centre)
          </button>
          <div className="field">
            <label>Creases</label>
            {info.shape.creases.map((c, i) => (
              <div className="parent-row" key={`${c[0]}-${c[1]}-${i}`}>
                <span>
                  {label(c[0])} — {label(c[1])}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    const next = base();
                    next.creases.splice(i, 1);
                    onChange(next);
                  }}
                >
                  ✕
                </button>
              </div>
            ))}
            <div className="parent-row">
              {[creaseA, creaseB].map((value, which) => (
                <select
                  key={which}
                  value={value}
                  onChange={(e) => (which === 0 ? setCreaseA : setCreaseB)(Number(e.target.value))}
                >
                  {info.handles.map((h) => (
                    <option key={h.crease_index} value={h.crease_index}>
                      {label(h.crease_index)}
                    </option>
                  ))}
                </select>
              ))}
              <button
                type="button"
                data-testid="slab-shape-add-crease"
                disabled={creaseA === creaseB}
                onClick={() => {
                  const next = base();
                  next.creases.push([creaseA, creaseB]);
                  onChange(next);
                }}
              >
                Add crease
              </button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
