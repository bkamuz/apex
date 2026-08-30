import { useEffect, useMemo, useState } from 'react';
import type {
  ExprDto,
  ParamKind,
  ParamSpecDto,
  ProfilePreviewDto,
  ProfileSpecDto,
  ProfileTypeDto,
} from '../types';
import { apexPreviewProfile } from '../wasm/apex';
import { formatExpr, parseExpr } from './exprText';

interface Props {
  initial: ProfileTypeDto;
  /** Original id, so Save as can require a new one. */
  originalId: string | null;
  onSave: (profile: ProfileTypeDto) => void;
  onClose: () => void;
}

type ShapeKind = 'rectangle' | 'circle' | 'polygon';

interface EditorParam extends ParamSpecDto {
  formulaText: string;
}

interface Draft {
  id: string;
  display_name: string;
  category: string;
  params: EditorParam[];
  shape: ShapeKind;
  widthText: string;
  heightText: string;
  radiusText: string;
  segments: number;
  points: { x: string; y: string }[];
}

const PARAM_KINDS: ParamKind[] = ['length', 'number', 'angle'];

function shapeOf(spec: ProfileSpecDto): ShapeKind {
  switch (spec.shape) {
    case 'rectangle':
    case 'circle':
    case 'polygon':
      return spec.shape;
    case 'named':
    case 'from_param':
      return 'rectangle';
    default: {
      const exhaustive: never = spec;
      return exhaustive;
    }
  }
}

function draftFrom(profile: ProfileTypeDto): Draft {
  const spec = profile.spec;
  const formulas = profile.formulas ?? {};
  return {
    id: profile.id,
    display_name: profile.display_name,
    category: profile.category,
    params: profile.params.map((item) => ({
      ...item,
      formulaText: formulas[item.id] ? formatExpr(formulas[item.id]) : '',
    })),
    shape: shapeOf(spec),
    widthText: spec.shape === 'rectangle' ? formatExpr(spec.width) : 'thickness',
    heightText: spec.shape === 'rectangle' ? formatExpr(spec.height) : 'height',
    radiusText: spec.shape === 'circle' ? formatExpr(spec.radius) : 'thickness / 2',
    segments: spec.shape === 'circle' ? (spec.segments ?? 24) : 24,
    points:
      spec.shape === 'polygon'
        ? spec.points.map(([x, y]) => ({ x: formatExpr(x), y: formatExpr(y) }))
        : [
            { x: '-thickness / 2', y: '-height / 2' },
            { x: 'thickness / 2', y: '-height / 2' },
            { x: 'thickness / 2', y: 'height / 2' },
            { x: '-thickness / 2', y: 'height / 2' },
          ],
  };
}

function parseOrThrow(label: string, text: string): ExprDto {
  try {
    return parseExpr(text);
  } catch (e) {
    throw new Error(`${label}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function buildProfile(draft: Draft): ProfileTypeDto {
  const params: ParamSpecDto[] = draft.params.map((param) => ({
    id: param.id.trim(),
    label: param.label.trim() || param.id.trim(),
    kind: param.kind,
    default: param.default,
    min: param.min,
    max: param.max,
    unit: param.kind === 'length' ? 'm' : param.kind === 'angle' ? 'rad' : param.unit,
    binding: param.binding === 'type' ? 'type' : 'instance',
  }));
  for (const param of params) {
    if (!param.id) throw new Error('every parameter needs an id');
  }
  const ids = new Set<string>();
  for (const param of params) {
    if (ids.has(param.id)) throw new Error(`duplicate parameter '${param.id}'`);
    ids.add(param.id);
  }

  const formulas: Record<string, ExprDto> = {};
  for (const param of draft.params) {
    const text = param.formulaText.trim();
    if (!text) continue;
    formulas[param.id.trim()] = parseOrThrow(`formula for ${param.id}`, text);
  }

  let spec: ProfileSpecDto;
  switch (draft.shape) {
    case 'rectangle':
      spec = {
        shape: 'rectangle',
        width: parseOrThrow('width', draft.widthText),
        height: parseOrThrow('height', draft.heightText),
      };
      break;
    case 'circle':
      spec = {
        shape: 'circle',
        radius: parseOrThrow('radius', draft.radiusText),
        segments: Math.max(3, Math.round(draft.segments) || 24),
      };
      break;
    case 'polygon':
      if (draft.points.length < 3) throw new Error('a polygon needs at least 3 points');
      spec = {
        shape: 'polygon',
        points: draft.points.map((point, i) => [
          parseOrThrow(`point ${i + 1} x`, point.x),
          parseOrThrow(`point ${i + 1} y`, point.y),
        ]),
      };
      break;
    default: {
      const exhaustive: never = draft.shape;
      return exhaustive;
    }
  }

  const type_values: ProfileTypeDto['type_values'] = {};
  for (const param of params) {
    if (param.binding === 'type') type_values[param.id] = param.default;
  }

  if (!draft.id.trim()) throw new Error('profile id is required');
  if (!draft.display_name.trim()) throw new Error('display name is required');

  return {
    id: draft.id.trim(),
    display_name: draft.display_name.trim(),
    category: draft.category.trim(),
    params,
    spec,
    type_values,
    formulas: Object.keys(formulas).length > 0 ? formulas : undefined,
  };
}

function boundsOf(preview: ProfilePreviewDto): { min: [number, number]; max: [number, number] } {
  const pts = preview.outer;
  if (pts.length === 0) return { min: [-1, -1], max: [1, 1] };
  let min: [number, number] = [pts[0][0], pts[0][1]];
  let max: [number, number] = [pts[0][0], pts[0][1]];
  for (const [x, y] of pts) {
    min = [Math.min(min[0], x), Math.min(min[1], y)];
    max = [Math.max(max[0], x), Math.max(max[1], y)];
  }
  return { min, max };
}

function polyline(points: [number, number][]): string {
  return points.map(([x, y]) => `${x},${-y}`).join(' ');
}

export function ProfileEditor({ initial, originalId, onSave, onClose }: Props) {
  const [draft, setDraft] = useState<Draft>(() => draftFrom(initial));
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ProfilePreviewDto | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const built = useMemo(() => {
    try {
      return { profile: buildProfile(draft), error: null as string | null };
    } catch (e) {
      return { profile: null, error: e instanceof Error ? e.message : String(e) };
    }
  }, [draft]);

  useEffect(() => {
    if (!built.profile) {
      setPreviewError(built.error);
      return;
    }
    try {
      setPreview(apexPreviewProfile(built.profile));
      setPreviewError(null);
    } catch (e) {
      setPreviewError(e instanceof Error ? e.message : String(e));
    }
  }, [built]);

  const updateParam = (index: number, patch: Partial<EditorParam>) => {
    setDraft((prev) => ({
      ...prev,
      params: prev.params.map((param, i) => (i === index ? { ...param, ...patch } : param)),
    }));
  };

  const addParam = () => {
    setDraft((prev) => ({
      ...prev,
      params: [
        ...prev.params,
        {
          id: `p${prev.params.length + 1}`,
          label: 'Parameter',
          kind: 'length',
          default: 0.2,
          min: Number.MIN_VALUE,
          unit: 'm',
          binding: 'instance',
          formulaText: '',
        },
      ],
    }));
  };

  const removeParam = (index: number) => {
    setDraft((prev) => ({ ...prev, params: prev.params.filter((_, i) => i !== index) }));
  };

  const save = (asNew: boolean) => {
    try {
      const profile = buildProfile(draft);
      if (asNew && originalId && profile.id === originalId) {
        throw new Error('change the id to save as a new profile');
      }
      onSave(profile);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const box = preview
    ? boundsOf(preview)
    : { min: [-1, -1] as [number, number], max: [1, 1] as [number, number] };
  const pad = Math.max(box.max[0] - box.min[0], box.max[1] - box.min[1], 0.2) * 0.2 + 0.05;
  const viewMinX = box.min[0] - pad;
  const viewMaxY = box.max[1] + pad;
  const viewW = box.max[0] - box.min[0] + pad * 2;
  const viewH = box.max[1] - box.min[1] + pad * 2;
  const viewBox = `${viewMinX} ${-viewMaxY} ${viewW} ${viewH}`;
  const cross = Math.max(viewW, viewH) * 0.04;
  const stroke = Math.max(viewW, viewH) * 0.008;

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="profile-editor"
        role="dialog"
        aria-label="Profile editor"
        data-testid="profile-editor"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="profile-editor-head">
          <strong>Profile type</strong>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="profile-editor-grid">
          <div className="profile-editor-form">
            <div className="field-row">
              <div className="field">
                <label>Id</label>
                <input
                  type="text"
                  value={draft.id}
                  onChange={(e) => setDraft((prev) => ({ ...prev, id: e.target.value }))}
                />
              </div>
              <div className="field">
                <label>Name</label>
                <input
                  type="text"
                  value={draft.display_name}
                  onChange={(e) => setDraft((prev) => ({ ...prev, display_name: e.target.value }))}
                />
              </div>
            </div>
            <div className="field">
              <label>Category</label>
              <input
                type="text"
                value={draft.category}
                onChange={(e) => setDraft((prev) => ({ ...prev, category: e.target.value }))}
              />
            </div>

            <div className="section-title">Parameters</div>
            {draft.params.map((param, index) => (
              <div key={index} className="profile-param-row">
                <input
                  type="text"
                  value={param.id}
                  aria-label="Parameter id"
                  onChange={(e) => updateParam(index, { id: e.target.value })}
                />
                <input
                  type="text"
                  value={param.label}
                  aria-label="Parameter label"
                  onChange={(e) => updateParam(index, { label: e.target.value })}
                />
                <select
                  value={param.kind}
                  aria-label="Parameter kind"
                  onChange={(e) => updateParam(index, { kind: e.target.value as ParamKind })}
                >
                  {PARAM_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {kind}
                    </option>
                  ))}
                </select>
                <input
                  type="number"
                  step={0.05}
                  value={Number(param.default)}
                  aria-label="Parameter default"
                  onChange={(e) => updateParam(index, { default: Number(e.target.value) })}
                />
                <select
                  value={param.binding === 'type' ? 'type' : 'instance'}
                  aria-label="Parameter binding"
                  onChange={(e) =>
                    updateParam(index, { binding: e.target.value === 'type' ? 'type' : 'instance' })
                  }
                >
                  <option value="type">Type</option>
                  <option value="instance">Instance</option>
                </select>
                <input
                  type="text"
                  placeholder="formula"
                  value={param.formulaText}
                  aria-label="Parameter formula"
                  onChange={(e) => updateParam(index, { formulaText: e.target.value })}
                />
                <button type="button" className="icon-btn" onClick={() => removeParam(index)}>
                  ×
                </button>
              </div>
            ))}
            <button type="button" onClick={addParam}>
              Add parameter
            </button>

            <div className="section-title">Shape</div>
            <div className="field">
              <label>Section</label>
              <select
                value={draft.shape}
                onChange={(e) =>
                  setDraft((prev) => ({ ...prev, shape: e.target.value as ShapeKind }))
                }
              >
                <option value="rectangle">Rectangle</option>
                <option value="circle">Circle</option>
                <option value="polygon">Polygon</option>
              </select>
            </div>
            {draft.shape === 'rectangle' ? (
              <div className="field-row">
                <div className="field">
                  <label>Width</label>
                  <input
                    type="text"
                    value={draft.widthText}
                    onChange={(e) => setDraft((prev) => ({ ...prev, widthText: e.target.value }))}
                  />
                </div>
                <div className="field">
                  <label>Height</label>
                  <input
                    type="text"
                    value={draft.heightText}
                    onChange={(e) => setDraft((prev) => ({ ...prev, heightText: e.target.value }))}
                  />
                </div>
              </div>
            ) : null}
            {draft.shape === 'circle' ? (
              <div className="field-row">
                <div className="field">
                  <label>Radius</label>
                  <input
                    type="text"
                    value={draft.radiusText}
                    onChange={(e) => setDraft((prev) => ({ ...prev, radiusText: e.target.value }))}
                  />
                </div>
                <div className="field">
                  <label>Segments</label>
                  <input
                    type="number"
                    min={3}
                    step={1}
                    value={draft.segments}
                    onChange={(e) =>
                      setDraft((prev) => ({ ...prev, segments: Number(e.target.value) }))
                    }
                  />
                </div>
              </div>
            ) : null}
            {draft.shape === 'polygon' ? (
              <div>
                {draft.points.map((point, index) => (
                  <div key={index} className="field-row">
                    <div className="field">
                      <label>X {index + 1}</label>
                      <input
                        type="text"
                        value={point.x}
                        onChange={(e) =>
                          setDraft((prev) => ({
                            ...prev,
                            points: prev.points.map((item, i) =>
                              i === index ? { ...item, x: e.target.value } : item,
                            ),
                          }))
                        }
                      />
                    </div>
                    <div className="field">
                      <label>Y {index + 1}</label>
                      <input
                        type="text"
                        value={point.y}
                        onChange={(e) =>
                          setDraft((prev) => ({
                            ...prev,
                            points: prev.points.map((item, i) =>
                              i === index ? { ...item, y: e.target.value } : item,
                            ),
                          }))
                        }
                      />
                    </div>
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() =>
                        setDraft((prev) => ({
                          ...prev,
                          points: prev.points.filter((_, i) => i !== index),
                        }))
                      }
                    >
                      ×
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() =>
                    setDraft((prev) => ({
                      ...prev,
                      points: [...prev.points, { x: '0', y: '0' }],
                    }))
                  }
                >
                  Add point
                </button>
              </div>
            ) : null}
          </div>

          <div className="profile-editor-preview">
            <svg viewBox={viewBox} preserveAspectRatio="xMidYMid meet" aria-label="Profile preview">
              {preview ? (
                <>
                  <polygon
                    points={polyline(preview.outer)}
                    fill="rgba(212, 137, 58, 0.25)"
                    stroke="#d4893a"
                    strokeWidth={stroke}
                  />
                  {preview.holes.map((hole, i) => (
                    <polygon
                      key={i}
                      points={polyline(hole)}
                      fill="rgba(18, 20, 26, 0.85)"
                      stroke="#9aa3b5"
                      strokeWidth={stroke * 0.75}
                    />
                  ))}
                </>
              ) : null}
              <line
                x1={-cross}
                y1={0}
                x2={cross}
                y2={0}
                stroke="#e8eaef"
                strokeWidth={stroke * 0.7}
              />
              <line
                x1={0}
                y1={-cross}
                x2={0}
                y2={cross}
                stroke="#e8eaef"
                strokeWidth={stroke * 0.7}
              />
            </svg>
            {previewError ? <div className="profile-preview-error">{previewError}</div> : null}
            <div className="empty" style={{ padding: '8px 0 0' }}>
              Origin is the cross. Type parameters are shared; instance parameters vary per
              element.
            </div>
          </div>
        </div>

        {error ? <div className="profile-editor-error">{error}</div> : null}
        <footer className="profile-editor-foot">
          <button type="button" onClick={() => save(false)}>
            Save
          </button>
          <button type="button" onClick={() => save(true)}>
            Save as new
          </button>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
        </footer>
      </div>
    </div>
  );
}
