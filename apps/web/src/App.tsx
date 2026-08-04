import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  apexCreateWall,
  apexDeleteSelected,
  apexGetScene,
  apexGetSelected,
  apexPickById,
  apexSelectElement,
  apexSetWallParams,
  initApex,
} from './wasm/apex';
import {
  GRID_STEP,
  orthoConstrain,
  snapPointToGrid,
  ViewportRenderer,
} from './viewport/ViewportRenderer';
import { buildWallSolid } from './viewport/wallMesh';
import type { ElementDto, ElementListDto, SceneDto, ToolMode } from './types';
import { ElementTree } from './components/ElementTree';
import { PropertiesPanel } from './components/PropertiesPanel';

const DEFAULT_HEIGHT = 3;
const DEFAULT_THICKNESS = 0.2;
const MIN_WALL_LENGTH = 0.1;

function toFloatArray(data: ArrayLike<number> | number[]): Float32Array {
  return data instanceof Float32Array ? data : new Float32Array(data);
}

function toUint32Array(data: ArrayLike<number> | number[]): Uint32Array {
  return data instanceof Uint32Array ? data : new Uint32Array(data);
}

function selectedPickId(scene: SceneDto): number | null {
  if (!scene.selected_id) return null;
  const hit = scene.elements.find((e) => e.id === scene.selected_id);
  return hit ? hit.pick_id : null;
}

function planLength(a: [number, number, number], b: [number, number, number]): number {
  const dx = b[0] - a[0];
  const dz = b[2] - a[2];
  return Math.hypot(dx, dz);
}

type HandleWhich = 'start' | 'end';

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<ViewportRenderer | null>(null);
  const wallStartRef = useRef<[number, number, number] | null>(null);
  const shiftHeldRef = useRef(false);
  const selectedRef = useRef<ElementDto | null>(null);
  const handleDragRef = useRef<{
    which: HandleWhich;
    start: [number, number, number];
    end: [number, number, number];
    moved: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);

  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tool, setTool] = useState<ToolMode>('wall');
  const [scene, setScene] = useState<SceneDto | null>(null);
  const [selected, setSelected] = useState<ElementDto | null>(null);
  const [pendingStart, setPendingStart] = useState<[number, number, number] | null>(null);

  selectedRef.current = selected;

  const syncEditGizmo = useCallback((el: ElementDto | null) => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    if (el?.category === 'wall' && el.start && el.end) {
      renderer.setEditGizmo(el.start, el.end);
    } else {
      renderer.setEditGizmo(null, null);
    }
  }, []);

  const clearPlacementPreview = useCallback(() => {
    rendererRef.current?.setPreviewLine(null, null);
    rendererRef.current?.setGhostWall(null);
  }, []);

  const showPlacementPreview = useCallback(
    (
      start: [number, number, number],
      end: [number, number, number],
      height = DEFAULT_HEIGHT,
      thickness = DEFAULT_THICKNESS,
    ) => {
      const renderer = rendererRef.current;
      if (!renderer) return;
      renderer.setPreviewLine(start, end);
      if (planLength(start, end) < MIN_WALL_LENGTH) {
        renderer.setGhostWall(null);
        return;
      }
      renderer.setGhostWall(buildWallSolid(start, end, height, thickness));
    },
    [],
  );

  const applyScene = useCallback(
    (next: SceneDto, fitCamera = false) => {
      setScene(next);
      const renderer = rendererRef.current;
      if (renderer) {
        renderer.setScene({
          positions: toFloatArray(next.positions),
          normals: toFloatArray(next.normals),
          indices: toUint32Array(next.indices),
          pickIds: next.pick_ids,
          edgePositions: next.edge_positions ? toFloatArray(next.edge_positions) : [],
          selectedPickId: selectedPickId(next),
          fitCamera,
        });
      }
      const sel = apexGetSelected();
      setSelected(sel);
      if (!wallStartRef.current) {
        clearPlacementPreview();
        syncEditGizmo(sel);
      }
    },
    [clearPlacementPreview, syncEditGizmo],
  );

  const cancelWall = useCallback(() => {
    wallStartRef.current = null;
    setPendingStart(null);
    clearPlacementPreview();
    syncEditGizmo(selectedRef.current);
  }, [clearPlacementPreview, syncEditGizmo]);

  const goSelect = useCallback(() => {
    cancelWall();
    setTool('select');
  }, [cancelWall]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        goSelect();
      }
      if (e.key === 'Shift') shiftHeldRef.current = true;
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Shift') shiftHeldRef.current = false;
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [goSelect]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await initApex();
        if (cancelled) return;
        const canvas = canvasRef.current;
        if (!canvas) return;
        rendererRef.current = new ViewportRenderer(canvas);
        const initial = apexGetScene();
        if (!cancelled) {
          applyScene(initial, false);
          setReady(true);
        }
      } catch (e) {
        console.error(e);
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
      rendererRef.current?.dispose();
      rendererRef.current = null;
    };
  }, [applyScene]);

  const elements: ElementListDto[] = useMemo(() => scene?.elements ?? [], [scene]);

  const resolveGroundPoint = (
    renderer: ViewportRenderer,
    clientX: number,
    clientY: number,
    shiftHeld: boolean,
    anchor: [number, number, number] | null = wallStartRef.current,
  ): [number, number, number] | null => {
    const raw = renderer.screenToGround(clientX, clientY, 0);
    if (!raw) return null;
    if (!shiftHeld) return raw;
    let point = snapPointToGrid(raw, GRID_STEP);
    if (anchor) {
      point = snapPointToGrid(orthoConstrain(anchor, point), GRID_STEP);
    }
    return point;
  };

  const commitWallEndpoints = useCallback(
    (
      id: string,
      height: number,
      thickness: number,
      start: [number, number, number],
      end: [number, number, number],
    ) => {
      if (planLength(start, end) < MIN_WALL_LENGTH) return;
      try {
        const next = apexSetWallParams(id, height, thickness, start, end);
        applyScene(next, false);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [applyScene],
  );

  const onCanvasPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!ready || !rendererRef.current || e.button !== 0) return;
    if (tool !== 'select') return;
    const sel = selectedRef.current;
    if (!sel?.start || !sel.end || sel.category !== 'wall') return;

    const hit = rendererRef.current.hitEditHandle(e.clientX, e.clientY);
    if (!hit) return;

    handleDragRef.current = {
      which: hit,
      start: [...sel.start] as [number, number, number],
      end: [...sel.end] as [number, number, number],
      moved: false,
    };
    suppressClickRef.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  const onCanvasPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!ready || !rendererRef.current) return;
    const renderer = rendererRef.current;
    const shift = e.shiftKey || shiftHeldRef.current;

    const drag = handleDragRef.current;
    if (drag && selectedRef.current) {
      const sel = selectedRef.current;
      const fixed = drag.which === 'start' ? drag.end : drag.start;
      const point = resolveGroundPoint(renderer, e.clientX, e.clientY, shift, fixed);
      if (!point) return;
      drag.moved = true;
      const start = drag.which === 'start' ? point : drag.start;
      const end = drag.which === 'end' ? point : drag.end;
      drag.start = start;
      drag.end = end;
      renderer.setEditGizmo(start, end);
      // Live-update solid via WASM so the wall follows the handle.
      if (planLength(start, end) >= MIN_WALL_LENGTH) {
        try {
          const next = apexSetWallParams(
            sel.id,
            sel.height ?? DEFAULT_HEIGHT,
            sel.thickness ?? DEFAULT_THICKNESS,
            start,
            end,
          );
          renderer.setScene({
            positions: toFloatArray(next.positions),
            normals: toFloatArray(next.normals),
            indices: toUint32Array(next.indices),
            pickIds: next.pick_ids,
            edgePositions: next.edge_positions ? toFloatArray(next.edge_positions) : [],
            selectedPickId: selectedPickId(next),
            fitCamera: false,
          });
          setScene(next);
          const updated = apexGetSelected();
          setSelected(updated);
        } catch {
          /* keep dragging even if a frame fails */
        }
      }
      return;
    }

    if (tool !== 'wall' || !wallStartRef.current) return;
    const end = resolveGroundPoint(renderer, e.clientX, e.clientY, shift);
    if (!end) return;
    showPlacementPreview(wallStartRef.current, end);
  };

  const onCanvasPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = handleDragRef.current;
    if (!drag) return;
    handleDragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    const sel = selectedRef.current;
    if (sel && drag.moved) {
      commitWallEndpoints(
        sel.id,
        sel.height ?? DEFAULT_HEIGHT,
        sel.thickness ?? DEFAULT_THICKNESS,
        drag.start,
        drag.end,
      );
    } else {
      syncEditGizmo(sel);
    }
    // Avoid the trailing click selecting/deselecting after a handle drag.
    window.setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);
  };

  const onCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!ready || !rendererRef.current) return;
    if (e.button !== 0) return;
    if (suppressClickRef.current || handleDragRef.current) return;

    const renderer = rendererRef.current;

    if (tool === 'select') {
      // Prefer handle hit — click on handle alone should not deselect.
      if (renderer.hitEditHandle(e.clientX, e.clientY)) return;
      const pick = renderer.pick(e.clientX, e.clientY);
      if (pick == null) {
        applyScene(apexSelectElement(null), false);
      } else {
        applyScene(apexPickById(pick), false);
      }
      return;
    }

    if (tool === 'wall') {
      const point = resolveGroundPoint(
        renderer,
        e.clientX,
        e.clientY,
        e.shiftKey || shiftHeldRef.current,
      );
      if (!point) return;

      if (!wallStartRef.current) {
        wallStartRef.current = point;
        setPendingStart(point);
        renderer.setEditGizmo(null, null);
        showPlacementPreview(point, point);
        return;
      }

      const start = wallStartRef.current;
      const end = point;
      if (planLength(start, end) < MIN_WALL_LENGTH) {
        setError(`Wall too short (min ${MIN_WALL_LENGTH} m). Click farther apart.`);
        return;
      }

      wallStartRef.current = null;
      setPendingStart(null);
      setError(null);
      clearPlacementPreview();

      try {
        const next = apexCreateWall(
          start[0],
          start[1],
          start[2],
          end[0],
          end[1],
          end[2],
          DEFAULT_HEIGHT,
          DEFAULT_THICKNESS,
        );
        applyScene(next, false);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  };

  const onSelectFromTree = (id: string) => {
    goSelect();
    applyScene(apexSelectElement(id), false);
  };

  const onUpdateWall = (patch: {
    height: number;
    thickness: number;
    start: [number, number, number];
    end: [number, number, number];
  }) => {
    if (!selected) return;
    commitWallEndpoints(selected.id, patch.height, patch.thickness, patch.start, patch.end);
  };

  const onDelete = () => {
    applyScene(apexDeleteSelected(), false);
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          APEX <span>BIT</span>
        </div>
        <div className="tools">
          <button
            type="button"
            className={tool === 'select' ? 'active' : ''}
            onClick={() => goSelect()}
          >
            Select
          </button>
          <button
            type="button"
            className={tool === 'wall' ? 'active' : ''}
            onClick={() => {
              cancelWall();
              setTool('wall');
            }}
          >
            Wall
          </button>
        </div>
        <div className="hint">
          {tool === 'wall'
            ? pendingStart
              ? 'Click end · Shift snap+ortho · Esc → Select'
              : 'Click start · Shift snap to 1 m grid · Esc → Select'
            : selected?.category === 'wall'
              ? 'Drag orange endpoints · Shift snap+ortho · RMB orbit'
              : 'Click select · RMB orbit · Alt+RMB pan · Wheel zoom'}
        </div>
      </header>

      <aside className="sidebar">
        <div className="panel-title">Elements</div>
        <ElementTree
          elements={elements}
          selectedId={scene?.selected_id ?? null}
          onSelect={onSelectFromTree}
        />
      </aside>

      <div className="viewport-wrap">
        {!ready && !error && <div className="loading">Loading Apex core…</div>}
        {error && <div className="error-banner">{error}</div>}
        <canvas
          ref={canvasRef}
          onClick={onCanvasClick}
          onPointerDown={onCanvasPointerDown}
          onPointerMove={onCanvasPointerMove}
          onPointerUp={onCanvasPointerUp}
          onPointerCancel={onCanvasPointerUp}
        />
        <div className="viewport-badge">WebGL2 · Rust/WASM · v{scene?.version ?? 0}</div>
      </div>

      <aside className="inspector">
        <div className="panel-title">Properties</div>
        <PropertiesPanel selected={selected} onUpdate={onUpdateWall} onDelete={onDelete} />
      </aside>
    </div>
  );
}
