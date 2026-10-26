import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ComponentDto,
  GeometryRecipeDto,
  ParamKind,
  ParamSpecDto,
  ParamValue,
  PlacementKind,
  ProfileSpecDto,
} from '../types';
import { ViewportRenderer } from '../viewport/ViewportRenderer';
import { apexPreviewComponentDefinition } from '../wasm/apex';
import {
  defaultPreviewParams,
  defaultPreviewPoints,
  inferTemplate,
  syncTemplateRecipe,
  validateComponentDraft,
  type ComponentTemplate,
} from './componentModel';

interface Props {
  initial: ComponentDto;
  originalId: string | null;
  profiles: { id: string; display_name: string; category: string }[];
  onSave: (component: ComponentDto) => void;
  onClose: () => void;
}

const PLACEMENTS: PlacementKind[] = [
  'point',
  'two_point',
  'three_point_arc',
  'polyline',
  'path',
  'free',
];

const PROFILE_SHAPES: ProfileSpecDto['shape'][] = [
  'rectangle',
  'circle',
  'hollow_rectangle',
  'hollow_circle',
];

function newParam(kind: ParamKind, id: string): ParamSpecDto {
  const base = { id, label: id, kind, default: kind === 'bool' ? false : kind === 'text' ? '' : 1 };
  if (kind === 'length') return { ...base, label: 'Length', default: 1, unit: 'm' };
  return base;
}

function toFloatArray(data: ArrayLike<number> | number[]): Float32Array {
  return data instanceof Float32Array ? data : new Float32Array(data);
}

function toUint32Array(data: ArrayLike<number> | number[]): Uint32Array {
  return data instanceof Uint32Array ? data : new Uint32Array(data);
}

export function ComponentEditor({ initial, originalId, profiles, onSave, onClose }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<ViewportRenderer | null>(null);
  const [draft, setDraft] = useState<ComponentDto>(initial);
  const [template, setTemplate] = useState<ComponentTemplate | 'custom'>(() => inferTemplate(initial));
  const [showJson, setShowJson] = useState(false);
  const [jsonText, setJsonText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(initial);
    setTemplate(inferTemplate(initial));
    setShowJson(false);
    setError(null);
  }, [initial]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = new ViewportRenderer(canvas);
    rendererRef.current = renderer;
    return () => {
      rendererRef.current = null;
      renderer.dispose();
    };
  }, []);

  const previewParams = useMemo(() => defaultPreviewParams(draft), [draft]);
  const previewPoints = useMemo(
    () => defaultPreviewPoints(draft.placement),
    [draft.placement],
  );

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || showJson) return;
    const validation = validateComponentDraft(draft);
    if (validation) {
      setPreviewError(validation);
      renderer.setScene({
        positions: new Float32Array(),
        normals: new Float32Array(),
        indices: new Uint32Array(),
        pickIds: new Float64Array(),
        edgePositions: new Float32Array(),
        selectedPickIds: [],
      });
      return;
    }
    try {
      const mesh = apexPreviewComponentDefinition(
        draft,
        previewPoints,
        previewParams,
        draft.placement === 'path' ? 'two_point' : draft.placement,
      );
      setPreviewError(null);
      renderer.setScene({
        positions: toFloatArray(mesh.positions),
        normals: toFloatArray(mesh.normals),
        indices: toUint32Array(mesh.indices),
        pickIds: new Float64Array(mesh.positions.length / 3).fill(-1),
        edgePositions: mesh.edge_positions ? toFloatArray(mesh.edge_positions) : new Float32Array(),
        selectedPickIds: [],
        fitCamera: true,
      });
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : String(err));
    }
  }, [draft, previewParams, previewPoints, showJson]);

  const updateParam = (id: string, patch: Partial<ParamSpecDto>) => {
    setDraft((prev) => {
      const params = prev.params.map((spec) => (spec.id === id ? { ...spec, ...patch } : spec));
      const next = { ...prev, params };
      if (template !== 'custom') {
        next.recipe = syncTemplateRecipe(template, params, prev.recipe);
      }
      return next;
    });
  };

  const addParam = () => {
    const id = `param_${draft.params.length + 1}`;
    setDraft((prev) => {
      const params = [...prev.params, newParam('length', id)];
      const next = { ...prev, params };
      if (template !== 'custom') next.recipe = syncTemplateRecipe(template, params, prev.recipe);
      return next;
    });
  };

  const removeParam = (id: string) => {
    setDraft((prev) => {
      const params = prev.params.filter((spec) => spec.id !== id);
      const next = { ...prev, params };
      if (template !== 'custom') next.recipe = syncTemplateRecipe(template, params, prev.recipe);
      return next;
    });
  };

  const setProfileShape = (shape: ProfileSpecDto['shape']) => {
    setTemplate('custom');
    setDraft((prev) => {
      const recipe = prev.recipe;
      if (recipe.op !== 'extrude' && recipe.op !== 'sweep') return prev;
      const profile =
        shape === 'rectangle'
          ? {
              shape: 'rectangle' as const,
              width: { op: 'param' as const, id: 'width' },
              height: { op: 'param' as const, id: 'depth' },
            }
          : shape === 'circle'
            ? {
                shape: 'circle' as const,
                radius: { op: 'param' as const, id: 'radius' },
                segments: 24,
              }
            : shape === 'hollow_rectangle'
              ? {
                  shape: 'hollow_rectangle' as const,
                  width: { op: 'param' as const, id: 'width' },
                  height: { op: 'param' as const, id: 'depth' },
                  wall: { op: 'param' as const, id: 'wall' },
                }
              : {
                  shape: 'hollow_circle' as const,
                  radius: { op: 'param' as const, id: 'radius' },
                  wall: { op: 'param' as const, id: 'wall' },
                  segments: 24,
                };
      return { ...prev, recipe: { ...recipe, profile } };
    });
  };

  const applyTemplate = (nextTemplate: ComponentTemplate) => {
    setTemplate(nextTemplate);
    setDraft((prev) => {
      const base =
        nextTemplate === 'beam'
          ? {
              ...prev,
              placement: 'two_point' as PlacementKind,
              category: prev.category || 'beam',
              joinable: true,
            }
          : {
              ...prev,
              placement: 'point' as PlacementKind,
              category: prev.category || 'custom',
              joinable: false,
            };
      const params =
        nextTemplate === 'beam'
          ? [
              { id: 'width', label: 'Width', kind: 'length' as ParamKind, default: 0.2, binding: 'type' as const },
              { id: 'depth', label: 'Depth', kind: 'length' as ParamKind, default: 0.4, binding: 'type' as const },
            ]
          : [
              { id: 'width', label: 'Width', kind: 'length' as ParamKind, default: 0.5, binding: 'type' as const },
              { id: 'depth', label: 'Depth', kind: 'length' as ParamKind, default: 0.5, binding: 'type' as const },
              { id: 'height', label: 'Height', kind: 'length' as ParamKind, default: 1.0 },
            ];
      return {
        ...base,
        params,
        recipe: syncTemplateRecipe(nextTemplate, params, prev.recipe),
      };
    });
  };

  const save = (asNew: boolean) => {
    let component = draft;
    if (showJson) {
      try {
        component = JSON.parse(jsonText) as ComponentDto;
      } catch {
        setError('JSON is not valid.');
        return;
      }
    }
    component = {
      ...component,
      id: component.id.trim(),
      display_name: component.display_name.trim(),
      category: component.category.trim(),
      source: 'visual',
    };
    // Descriptors are mandatory in core; default the purpose when left blank.
    const purpose =
      component.descriptor?.purpose?.trim() ||
      `${component.display_name.trim() || component.id.trim()}: user-authored ${component.placement} element.`;
    component = { ...component, descriptor: { ...component.descriptor, purpose } };
    const validation = validateComponentDraft(component);
    if (validation) {
      setError(validation);
      return;
    }
    if (asNew || (originalId && originalId !== component.id)) {
      component = { ...component, id: component.id || `${originalId}.copy` };
    }
    try {
      apexPreviewComponentDefinition(
        component,
        defaultPreviewPoints(component.placement),
        defaultPreviewParams(component),
        component.placement === 'path' ? 'two_point' : component.placement,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    onSave(component);
  };

  const recipeOp = draft.recipe.op;
  const profileShape =
    draft.recipe.op === 'extrude' || draft.recipe.op === 'sweep'
      ? draft.recipe.profile.shape
      : null;

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="profile-editor component-editor"
        role="dialog"
        aria-label="Component editor"
        data-testid="component-editor"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="profile-editor-head">
          <strong>Component editor</strong>
          <span className="profile-editor-hint">
            Author a component type (params + geometry recipe). Preview uses sample placement picks.
          </span>
          <label className="component-editor-json-toggle">
            <input
              type="checkbox"
              checked={showJson}
              onChange={(e) => {
                setShowJson(e.target.checked);
                if (e.target.checked) setJsonText(JSON.stringify(draft, null, 2));
              }}
            />
            JSON
          </label>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </header>

        {showJson ? (
          <div className="component-editor-json">
            <textarea
              value={jsonText}
              onChange={(e) => setJsonText(e.target.value)}
              spellCheck={false}
              data-testid="component-json"
            />
          </div>
        ) : (
          <div className="profile-editor-grid">
            <div className="profile-editor-canvas">
              <div className="profile-editor-modes">
                <button
                  type="button"
                  className={template === 'box' ? 'active' : ''}
                  onClick={() => applyTemplate('box')}
                  data-testid="template-box"
                >
                  Box (extrude)
                </button>
                <button
                  type="button"
                  className={template === 'beam' ? 'active' : ''}
                  onClick={() => applyTemplate('beam')}
                  data-testid="template-beam"
                >
                  Beam (sweep)
                </button>
                <button
                  type="button"
                  className={template === 'custom' ? 'active' : ''}
                  disabled={template === 'custom'}
                >
                  Custom
                </button>
              </div>
              <canvas ref={canvasRef} className="component-preview-canvas" data-testid="component-preview" />
              {previewError ? <div className="profile-editor-error">{previewError}</div> : null}
            </div>

            <div className="profile-editor-form">
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
              <div className="field">
                <label>Category</label>
                <input
                  type="text"
                  value={draft.category}
                  onChange={(e) => setDraft((prev) => ({ ...prev, category: e.target.value }))}
                />
              </div>
              <div className="field">
                <label>Purpose</label>
                <textarea
                  data-testid="component-purpose"
                  rows={2}
                  placeholder="What it models and when to use it (shown to agents)"
                  value={draft.descriptor?.purpose ?? ''}
                  onChange={(e) =>
                    setDraft((prev) => ({ ...prev, descriptor: { ...prev.descriptor, purpose: e.target.value } }))
                  }
                />
              </div>

              <div className="section-title">Placement</div>
              <div className="field">
                <label>Gesture</label>
                <select
                  value={draft.placement}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      placement: e.target.value as PlacementKind,
                    }))
                  }
                >
                  {PLACEMENTS.map((kind) => (
                    <option key={kind} value={kind}>
                      {kind}
                    </option>
                  ))}
                </select>
              </div>
              <label className="component-flag">
                <input
                  type="checkbox"
                  checked={draft.placement_options?.closed ?? false}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      placement_options: {
                        ...prev.placement_options,
                        closed: e.target.checked,
                        min_points: e.target.checked ? 3 : prev.placement_options?.min_points,
                      },
                    }))
                  }
                />
                Closed boundary (slab-like)
              </label>
              <label className="component-flag">
                <input
                  type="checkbox"
                  checked={draft.placement_options?.seat_on_level !== false}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      placement_options: {
                        ...prev.placement_options,
                        seat_on_level: e.target.checked,
                      },
                    }))
                  }
                />
                Seat on level
              </label>
              <label className="component-flag">
                <input
                  type="checkbox"
                  checked={draft.joinable ?? false}
                  onChange={(e) => setDraft((prev) => ({ ...prev, joinable: e.target.checked }))}
                />
                Joinable paths
              </label>

              <div className="section-title">Parameters</div>
              {draft.params.map((param) => (
                <div key={param.id} className="profile-dim-row">
                  <input
                    type="text"
                    value={param.label}
                    aria-label={`${param.id} label`}
                    onChange={(e) => updateParam(param.id, { label: e.target.value })}
                  />
                  <select
                    value={param.kind}
                    aria-label={`${param.id} kind`}
                    onChange={(e) => updateParam(param.id, { kind: e.target.value as ParamKind })}
                  >
                    <option value="length">length</option>
                    <option value="number">number</option>
                    <option value="angle">angle</option>
                    <option value="bool">bool</option>
                    <option value="text">text</option>
                    <option value="profile">profile</option>
                  </select>
                  <input
                    type={param.kind === 'bool' ? 'checkbox' : param.kind === 'text' ? 'text' : 'number'}
                    step={0.05}
                    checked={param.kind === 'bool' ? Boolean(param.default) : undefined}
                    value={
                      param.kind === 'bool'
                        ? undefined
                        : param.kind === 'text'
                          ? String(param.default)
                          : Number(param.default)
                    }
                    aria-label={`${param.id} default`}
                    data-testid={`component-param-default-${param.id}`}
                    onChange={(e) => {
                      const value: ParamValue =
                        param.kind === 'bool'
                          ? e.target.checked
                          : param.kind === 'text'
                            ? e.target.value
                            : Number(e.target.value);
                      updateParam(param.id, { default: value });
                    }}
                  />
                  <select
                    value={param.binding === 'type' ? 'type' : 'instance'}
                    aria-label={`${param.id} binding`}
                    onChange={(e) =>
                      updateParam(param.id, {
                        binding: e.target.value === 'type' ? 'type' : 'instance',
                      })
                    }
                  >
                    <option value="type">Shared type</option>
                    <option value="instance">Per instance</option>
                  </select>
                  <button type="button" className="icon-btn" onClick={() => removeParam(param.id)}>
                    ×
                  </button>
                </div>
              ))}
              <button type="button" onClick={addParam} data-testid="add-component-param">
                Add parameter
              </button>

              <div className="section-title">Geometry</div>
              <div className="field">
                <label>Operation</label>
                <select
                  value={recipeOp}
                  disabled={template !== 'custom'}
                  onChange={(e) => {
                    const op = e.target.value as GeometryRecipeDto['op'];
                    setTemplate('custom');
                    if (op === 'sweep') {
                      setDraft((prev) => ({
                        ...prev,
                        recipe: {
                          op: 'sweep',
                          profile: {
                            shape: 'rectangle',
                            width: { op: 'param', id: 'width' },
                            height: { op: 'param', id: 'depth' },
                          },
                          justification: 'base_center',
                        },
                      }));
                    } else if (op === 'extrude') {
                      setDraft((prev) => ({
                        ...prev,
                        recipe: {
                          op: 'extrude',
                          profile: {
                            shape: 'rectangle',
                            width: { op: 'param', id: 'width' },
                            height: { op: 'param', id: 'depth' },
                          },
                          frame: { from: 'work_plane' },
                          height: { op: 'param', id: 'height' },
                        },
                      }));
                    }
                  }}
                >
                  <option value="extrude">Extrude</option>
                  <option value="sweep">Sweep</option>
                  <option value="group">Group</option>
                  <option value="custom">Custom builder</option>
                </select>
              </div>
              {(recipeOp === 'extrude' || recipeOp === 'sweep') && profileShape ? (
                <div className="field">
                  <label>Profile</label>
                  <select
                    value={profileShape}
                    onChange={(e) => setProfileShape(e.target.value as ProfileSpecDto['shape'])}
                  >
                    {PROFILE_SHAPES.map((shape) => (
                      <option key={shape} value={shape}>
                        {shape}
                      </option>
                    ))}
                    <option value="named">named library profile</option>
                    <option value="from_param">from profile param</option>
                  </select>
                </div>
              ) : null}
              {recipeOp === 'custom' ? (
                <div className="empty">Custom builders are module-only — use JSON for advanced edits.</div>
              ) : null}
              {recipeOp === 'group' ? (
                <div className="empty">Group recipes — use JSON advanced view to edit steps.</div>
              ) : null}

              {profiles.length > 0 ? (
                <div className="empty" style={{ paddingTop: 8 }}>
                  {profiles.length} profile type(s) in project for named / param profiles.
                </div>
              ) : null}
            </div>
          </div>
        )}

        {error ? <div className="profile-editor-error">{error}</div> : null}
        <footer className="profile-editor-foot">
          <button type="button" onClick={() => save(false)} data-testid="save-component">
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
