import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ParamSpecDto,
  ProfilePreviewDto,
  ProfileTypeDto,
  SketchDimensionDto,
} from '../types';
import { apexPreviewProfile } from '../wasm/apex';
import {
  distToSegment,
  edgeLength,
  edgeMid,
  inferSketch,
  lengthParam,
  parallelEdges,
  placeholderPolygon,
  sketchPayload,
  snapSketch,
  suggestDimension,
} from './sketchModel';

interface Props {
  initial: ProfileTypeDto;
  originalId: string | null;
  onSave: (profile: ProfileTypeDto) => void;
  onClose: () => void;
}

type Mode = 'draw' | 'dimension';

function clientToWorld(
  svg: SVGSVGElement,
  clientX: number,
  clientY: number,
): [number, number] | null {
  const ctm = svg.getScreenCTM();
  if (!ctm) return null;
  const pt = svg.createSVGPoint();
  pt.x = clientX;
  pt.y = clientY;
  const mapped = pt.matrixTransform(ctm.inverse());
  return [mapped.x, -mapped.y];
}

function polyline(points: [number, number][]): string {
  return points.map(([x, y]) => `${x},${-y}`).join(' ');
}

function hitVertex(
  p: [number, number],
  vertices: [number, number][],
  tol: number,
): number | null {
  let best = -1;
  let bestD = tol;
  for (let i = 0; i < vertices.length; i++) {
    const d = Math.hypot(p[0] - vertices[i][0], p[1] - vertices[i][1]);
    if (d <= bestD) {
      bestD = d;
      best = i;
    }
  }
  return best >= 0 ? best : null;
}

function hitEdge(
  p: [number, number],
  vertices: [number, number][],
  closed: boolean,
  tol: number,
): number | null {
  const n = vertices.length;
  const count = closed ? n : Math.max(0, n - 1);
  let best = -1;
  let bestD = tol;
  for (let i = 0; i < count; i++) {
    const d = distToSegment(p, vertices[i], vertices[(i + 1) % n]);
    if (d <= bestD) {
      bestD = d;
      best = i;
    }
  }
  return best >= 0 ? best : null;
}

function typeValuesOf(params: ParamSpecDto[]): ProfileTypeDto['type_values'] {
  const out: ProfileTypeDto['type_values'] = {};
  for (const param of params) {
    if (param.binding === 'type') out[param.id] = param.default;
  }
  return out;
}

export function ProfileEditor({ initial, originalId, onSave, onClose }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<number | null>(null);
  const [id, setId] = useState(initial.id);
  const [displayName, setDisplayName] = useState(initial.display_name);
  const [category, setCategory] = useState(initial.category);
  const [vertices, setVertices] = useState<[number, number][]>([]);
  const [closed, setClosed] = useState(false);
  const [dimensions, setDimensions] = useState<SketchDimensionDto[]>([]);
  const [params, setParams] = useState<ParamSpecDto[]>(initial.params);
  const [mode, setMode] = useState<Mode>('draw');
  const [cursor, setCursor] = useState<[number, number] | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<number | null>(null);
  const [keepCircle, setKeepCircle] = useState(initial.spec.shape === 'circle' && !initial.sketch);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ProfilePreviewDto | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let seedPreview: ProfilePreviewDto | null = null;
    try {
      seedPreview = apexPreviewProfile(initial);
    } catch {
      seedPreview = null;
    }
    const inferred = inferSketch(initial, seedPreview);
    setVertices(inferred.vertices);
    setClosed(inferred.closed);
    setDimensions(inferred.dimensions);
    setParams(initial.params);
    setMode(inferred.closed ? 'dimension' : 'draw');
    setKeepCircle(initial.spec.shape === 'circle' && inferred.vertices.length < 3);
    setReady(true);
  }, [initial]);

  const built = useMemo(() => {
    if (!ready) return { profile: null as ProfileTypeDto | null, error: null as string | null };
    if (keepCircle) {
      return {
        profile: {
          ...initial,
          id: id.trim(),
          display_name: displayName.trim(),
          category: category.trim(),
          params,
          type_values: typeValuesOf(params),
        },
        error: null,
      };
    }
    if (!closed || vertices.length < 3) {
      return { profile: null, error: 'Draw a closed outline (click the first point to close).' };
    }
    const used = new Set(dimensions.map((dim) => dim.param));
    const kept = params.filter((param) => used.has(param.id));
    const ids = new Set<string>();
    for (const param of kept) {
      if (!param.id.trim()) return { profile: null, error: 'every parameter needs an id' };
      if (ids.has(param.id)) return { profile: null, error: `duplicate parameter '${param.id}'` };
      ids.add(param.id);
    }
    if (!id.trim()) return { profile: null, error: 'profile id is required' };
    if (!displayName.trim()) return { profile: null, error: 'display name is required' };
    return {
      profile: {
        id: id.trim(),
        display_name: displayName.trim(),
        category: category.trim(),
        params: kept,
        spec: placeholderPolygon(vertices),
        type_values: typeValuesOf(kept),
        sketch: sketchPayload(vertices, dimensions),
      },
      error: null,
    };
  }, [ready, keepCircle, closed, vertices, dimensions, params, id, displayName, category, initial]);

  useEffect(() => {
    if (!built.profile) {
      setPreviewError(built.error);
      setPreview(null);
      return;
    }
    try {
      setPreview(apexPreviewProfile(built.profile));
      setPreviewError(null);
    } catch (e) {
      setPreviewError(e instanceof Error ? e.message : String(e));
    }
  }, [built]);

  const worldPts = preview?.outer ?? vertices;
  const box = useMemo(() => {
    const pts: [number, number][] = [...worldPts, [0, 0]];
    if (cursor) pts.push(cursor);
    if (pts.length === 0) {
      return { min: [-1, -1] as [number, number], max: [1, 1] as [number, number] };
    }
    let min: [number, number] = [pts[0][0], pts[0][1]];
    let max: [number, number] = [pts[0][0], pts[0][1]];
    for (const [x, y] of pts) {
      min = [Math.min(min[0], x), Math.min(min[1], y)];
      max = [Math.max(max[0], x), Math.max(max[1], y)];
    }
    const span = Math.max(max[0] - min[0], max[1] - min[1], 0.4);
    const pad = span * 0.25 + 0.15;
    return {
      min: [min[0] - pad, min[1] - pad] as [number, number],
      max: [max[0] + pad, max[1] + pad] as [number, number],
    };
  }, [worldPts, cursor]);

  const viewW = box.max[0] - box.min[0];
  const viewH = box.max[1] - box.min[1];
  const viewBox = `${box.min[0]} ${-box.max[1]} ${viewW} ${viewH}`;
  const stroke = Math.max(viewW, viewH) * 0.006;
  const cross = Math.max(viewW, viewH) * 0.035;
  const closeTol = Math.max(0.06, Math.max(viewW, viewH) * 0.025);
  const hitTol = Math.max(0.04, Math.max(viewW, viewH) * 0.02);

  const gridStep = viewW > 4 ? 0.5 : 0.1;
  const gridXs: number[] = [];
  const gridYs: number[] = [];
  const gx0 = Math.floor(box.min[0] / gridStep) * gridStep;
  const gy0 = Math.floor(box.min[1] / gridStep) * gridStep;
  for (let x = gx0; x <= box.max[0] + 1e-9; x += gridStep) gridXs.push(x);
  for (let y = gy0; y <= box.max[1] + 1e-9; y += gridStep) gridYs.push(y);

  const readWorld = (e: React.PointerEvent | React.MouseEvent): [number, number] | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const raw = clientToWorld(svg, e.clientX, e.clientY);
    if (!raw) return null;
    if (e.altKey) return raw;
    return snapSketch(raw[0], raw[1]);
  };

  const closeOutline = (pts: [number, number][]) => {
    if (pts.length < 3) return;
    setVertices(pts);
    setClosed(true);
    setMode('dimension');
    setKeepCircle(false);
    setCursor(null);
  };

  const addVertex = (p: [number, number]) => {
    if (closed) return;
    if (vertices.length >= 3) {
      const first = vertices[0];
      if (Math.hypot(p[0] - first[0], p[1] - first[1]) <= closeTol) {
        closeOutline(vertices);
        return;
      }
    }
    setVertices((prev) => [...prev, p]);
    setKeepCircle(false);
  };

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    const p = readWorld(e);
    if (!p) return;
    e.preventDefault();

    if (mode === 'draw' && !closed) {
      addVertex(p);
      return;
    }

    const v = hitVertex(p, vertices, hitTol);
    if (v != null) {
      dragRef.current = v;
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }

    if (!closed) return;
    const edge = hitEdge(p, vertices, true, hitTol);
    setSelectedEdge(edge);
    if (edge != null) setMode('dimension');
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const p = readWorld(e);
    if (!p) return;
    if (dragRef.current != null) {
      const index = dragRef.current;
      setVertices((prev) => prev.map((pt, i) => (i === index ? p : pt)));
      return;
    }
    if (mode === 'draw' && !closed) setCursor(p);
  };

  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const onDoubleClick = (e: React.MouseEvent<SVGSVGElement>) => {
    e.preventDefault();
    if (!closed && vertices.length >= 3) closeOutline(vertices);
  };

  const addDimension = (edge: number, applyParallel: boolean) => {
    const len = edgeLength(vertices[edge], vertices[(edge + 1) % vertices.length]);
    const used = new Set(params.map((param) => param.id));
    const suggestion = suggestDimension(category, vertices, edge, used);
    const nextParam = lengthParam(
      suggestion.id,
      suggestion.label,
      Number(len.toFixed(4)),
      suggestion.binding,
    );
    const edges = applyParallel ? parallelEdges(vertices, edge) : [edge];
    setParams((prev) => [...prev.filter((param) => param.id !== nextParam.id), nextParam]);
    setDimensions((prev) => {
      const without = prev.filter((dim) => !edges.includes(dim.edge));
      return [...without, ...edges.map((i) => ({ edge: i, param: nextParam.id }))];
    });
  };

  const dimensionAll = () => {
    if (!closed || vertices.length < 3) return;
    const count = vertices.length;
    const seen = new Set<number>();
    let nextParams = [...params];
    let nextDims = [...dimensions];
    for (let i = 0; i < count; i++) {
      if (seen.has(i)) continue;
      const group = parallelEdges(vertices, i);
      for (const g of group) seen.add(g);
      const existing = nextDims.find((dim) => dim.edge === i);
      if (existing) {
        for (const g of group) {
          nextDims = nextDims.filter((dim) => dim.edge !== g);
          nextDims.push({ edge: g, param: existing.param });
        }
        continue;
      }
      const used = new Set(nextParams.map((param) => param.id));
      const suggestion = suggestDimension(category, vertices, i, used);
      const len = edgeLength(vertices[i], vertices[(i + 1) % count]);
      const nextParam = lengthParam(
        suggestion.id,
        suggestion.label,
        Number(len.toFixed(4)),
        suggestion.binding,
      );
      nextParams = [...nextParams.filter((param) => param.id !== nextParam.id), nextParam];
      for (const g of group) {
        nextDims = nextDims.filter((dim) => dim.edge !== g);
        nextDims.push({ edge: g, param: nextParam.id });
      }
    }
    setParams(nextParams);
    setDimensions(nextDims);
  };

  const updateParam = (paramId: string, patch: Partial<ParamSpecDto>) => {
    setParams((prev) =>
      prev.map((param) => (param.id === paramId ? { ...param, ...patch } : param)),
    );
  };

  const removeParam = (paramId: string) => {
    setParams((prev) => prev.filter((param) => param.id !== paramId));
    setDimensions((prev) => prev.filter((dim) => dim.param !== paramId));
  };

  const save = (asNew: boolean) => {
    try {
      if (!built.profile) throw new Error(built.error ?? 'cannot save');
      if (asNew && originalId && built.profile.id === originalId) {
        throw new Error('change the id to save as a new profile');
      }
      onSave(built.profile);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const clearOutline = () => {
    setVertices([]);
    setClosed(false);
    setDimensions([]);
    setParams([]);
    setSelectedEdge(null);
    setMode('draw');
    setKeepCircle(false);
    setCursor(null);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !closed && vertices.length >= 3) {
        e.preventDefault();
        closeOutline(vertices);
        return;
      }
      if (e.key === 'Backspace' && !closed && vertices.length > 0) {
        const active = document.activeElement;
        if (
          active instanceof HTMLElement &&
          (active.tagName === 'INPUT' ||
            active.tagName === 'TEXTAREA' ||
            active.tagName === 'SELECT')
        ) {
          return;
        }
        e.preventDefault();
        setVertices((prev) => prev.slice(0, -1));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closed, vertices]);

  const n = vertices.length;
  const selectedDim =
    selectedEdge != null ? dimensions.find((dim) => dim.edge === selectedEdge) : undefined;
  const selectedParam = selectedDim
    ? params.find((param) => param.id === selectedDim.param)
    : undefined;
  const drawn = preview?.outer ?? (closed ? vertices : []);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="profile-editor"
        role="dialog"
        aria-label="Profile sketch editor"
        data-testid="profile-editor"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="profile-editor-head">
          <strong>Draw profile</strong>
          <span className="profile-editor-hint">
            {keepCircle
              ? 'Round profile. Draw an outline to replace it, or edit the shared size.'
              : closed
                ? 'Click an edge to add a dimension — Shared type (all elements) or This element.'
                : 'Click to place corners. Click the first point (or Close outline) to finish.'}
          </span>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="profile-editor-grid">
          <div className="profile-editor-canvas">
            <div className="profile-editor-modes">
              <button
                type="button"
                className={mode === 'draw' && !closed ? 'active' : ''}
                onClick={() => {
                  setMode('draw');
                  if (closed) {
                    setClosed(false);
                    setKeepCircle(false);
                  }
                }}
              >
                Draw
              </button>
              <button
                type="button"
                className={mode === 'dimension' ? 'active' : ''}
                disabled={!closed}
                onClick={() => setMode('dimension')}
              >
                Dimension
              </button>
              <button
                type="button"
                disabled={vertices.length < 3 || closed}
                onClick={() => closeOutline(vertices)}
                data-testid="close-outline"
              >
                Close outline
              </button>
              <button
                type="button"
                disabled={!closed}
                onClick={dimensionAll}
                data-testid="dimension-all"
              >
                Dimension all edges
              </button>
              <button type="button" onClick={clearOutline}>
                Clear
              </button>
            </div>
            <svg
              ref={svgRef}
              viewBox={viewBox}
              preserveAspectRatio="xMidYMid meet"
              aria-label="Profile sketch"
              data-testid="profile-sketch"
              className="profile-sketch"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerLeave={() => setCursor(null)}
              onDoubleClick={onDoubleClick}
            >
              {gridXs.map((x) => (
                <line
                  key={`gx-${x}`}
                  x1={x}
                  y1={-box.max[1]}
                  x2={x}
                  y2={-box.min[1]}
                  stroke={Math.abs(x) < 1e-6 ? '#3a4154' : '#1c2230'}
                  strokeWidth={stroke * 0.35}
                />
              ))}
              {gridYs.map((y) => (
                <line
                  key={`gy-${y}`}
                  x1={box.min[0]}
                  y1={-y}
                  x2={box.max[0]}
                  y2={-y}
                  stroke={Math.abs(y) < 1e-6 ? '#3a4154' : '#1c2230'}
                  strokeWidth={stroke * 0.35}
                />
              ))}
              <line
                x1={-cross}
                y1={0}
                x2={cross}
                y2={0}
                stroke="#e8eaef"
                strokeWidth={stroke * 0.8}
              />
              <line
                x1={0}
                y1={-cross}
                x2={0}
                y2={cross}
                stroke="#e8eaef"
                strokeWidth={stroke * 0.8}
              />
              {keepCircle && preview ? (
                <polygon
                  points={polyline(preview.outer)}
                  fill="rgba(212, 137, 58, 0.18)"
                  stroke="#d4893a"
                  strokeWidth={stroke}
                />
              ) : null}
              {drawn.length >= 2 ? (
                closed ? (
                  <polygon
                    points={polyline(drawn)}
                    fill="rgba(212, 137, 58, 0.22)"
                    stroke="#d4893a"
                    strokeWidth={stroke}
                  />
                ) : (
                  <polyline
                    points={polyline(vertices)}
                    fill="none"
                    stroke="#d4893a"
                    strokeWidth={stroke}
                  />
                )
              ) : null}
              {!closed && cursor && vertices.length > 0 ? (
                <line
                  x1={vertices[vertices.length - 1][0]}
                  y1={-vertices[vertices.length - 1][1]}
                  x2={cursor[0]}
                  y2={-cursor[1]}
                  stroke="#d4893a"
                  strokeWidth={stroke * 0.7}
                  strokeDasharray={`${stroke * 2} ${stroke * 2}`}
                />
              ) : null}
              {closed
                ? Array.from({ length: n }, (_, i) => {
                    const a = vertices[i];
                    const b = vertices[(i + 1) % n];
                    const selected = selectedEdge === i;
                    return (
                      <line
                        key={`e-${i}`}
                        x1={a[0]}
                        y1={-a[1]}
                        x2={b[0]}
                        y2={-b[1]}
                        stroke={selected ? '#f3d2a8' : 'transparent'}
                        strokeWidth={stroke * (selected ? 2.4 : 3)}
                      />
                    );
                  })
                : null}
              {dimensions.map((dim) => {
                const a = vertices[dim.edge];
                const b = vertices[(dim.edge + 1) % n];
                if (!a || !b) return null;
                const mid = edgeMid(a, b);
                const param = params.find((item) => item.id === dim.param);
                const binding = param?.binding === 'type' ? 'type' : 'instance';
                return (
                  <text
                    key={`d-${dim.edge}-${dim.param}`}
                    x={mid[0]}
                    y={-mid[1]}
                    fill={binding === 'type' ? '#f3d2a8' : '#9ec5ff'}
                    fontSize={Math.max(viewW, viewH) * 0.035}
                    textAnchor="middle"
                    dominantBaseline="middle"
                  >
                    {param?.label ?? dim.param} {Number(param?.default ?? 0).toFixed(2)}
                  </text>
                );
              })}
              {vertices.map(([x, y], i) => (
                <circle
                  key={`v-${i}`}
                  cx={x}
                  cy={-y}
                  r={i === 0 && !closed ? stroke * 2.2 : stroke * 1.4}
                  fill={i === 0 && !closed ? '#f3d2a8' : '#e8eaef'}
                  stroke="#12141a"
                  strokeWidth={stroke * 0.3}
                />
              ))}
            </svg>
            {previewError && closed ? (
              <div className="profile-preview-error">{previewError}</div>
            ) : null}
          </div>

          <div className="profile-editor-form">
            <div className="field">
              <label>Id</label>
              <input type="text" value={id} onChange={(e) => setId(e.target.value)} />
            </div>
            <div className="field">
              <label>Name</label>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </div>
            <div className="field">
              <label>Category</label>
              <input type="text" value={category} onChange={(e) => setCategory(e.target.value)} />
            </div>

            <div className="section-title">Dimensions</div>
            {params.length === 0 ? (
              <div className="empty" style={{ padding: 0 }}>
                {closed
                  ? 'Click an edge, or Dimension all edges.'
                  : 'Close the outline, then assign sizes to edges.'}
              </div>
            ) : (
              params.map((param) => (
                <div key={param.id} className="profile-dim-row">
                  <input
                    type="text"
                    value={param.label}
                    aria-label={`${param.id} label`}
                    onChange={(e) => updateParam(param.id, { label: e.target.value })}
                  />
                  <input
                    type="number"
                    step={0.05}
                    value={Number(param.default)}
                    aria-label={`${param.id} default`}
                    data-testid={`param-default-${param.id}`}
                    onChange={(e) => updateParam(param.id, { default: Number(e.target.value) })}
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
                    <option value="instance">This element</option>
                  </select>
                  <button type="button" className="icon-btn" onClick={() => removeParam(param.id)}>
                    ×
                  </button>
                </div>
              ))
            )}

            {closed && selectedEdge != null && !selectedParam ? (
              <button
                type="button"
                data-testid="add-dimension"
                onClick={() => addDimension(selectedEdge, true)}
              >
                Add dimension to edge {selectedEdge + 1}
              </button>
            ) : null}

            <div className="empty" style={{ padding: '8px 0 0' }}>
              Shared type values apply to every element of this profile. This element values vary
              per instance. Origin is the cross. Alt: no snap.
            </div>
          </div>
        </div>

        {error ? <div className="profile-editor-error">{error}</div> : null}
        <footer className="profile-editor-foot">
          <button type="button" onClick={() => save(false)} data-testid="save-profile">
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
