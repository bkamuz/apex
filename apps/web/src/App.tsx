import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  apexCreateWall,
  apexDeleteSelected,
  apexGetScene,
  apexGetSelected,
  apexPickById,
  apexSelectElement,
  apexSetWallParams,
  apexTogglePickById,
  apexToggleSelectElement,
  initApex,
} from './wasm/apex';
import {
  orthoConstrain,
  snapPointToGrid,
  ViewportRenderer,
  type ProjectionMode,
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

function selectedPickIds(scene: SceneDto): number[] {
  const ids = scene.selected_ids ?? (scene.selected_id ? [scene.selected_id] : []);
  const picks: number[] = [];
  for (const id of ids) {
    const hit = scene.elements.find((e) => e.id === id);
    if (hit) picks.push(hit.pick_id);
  }
  return picks;
}

function selectedIdList(scene: SceneDto): string[] {
  if (Array.isArray(scene.selected_ids)) return scene.selected_ids;
  return scene.selected_id ? [scene.selected_id] : [];
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
  const selectedCountRef = useRef(0);
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
  const [projection, setProjection] = useState<ProjectionMode>('orthographic');
  const [scene, setScene] = useState<SceneDto | null>(null);
  const [selected, setSelected] = useState<ElementDto | null>(null);
  const [pendingStart, setPendingStart] = useState<[number, number, number] | null>(null);
  const [fps, setFps] = useState(0);

  selectedRef.current = selected;
  selectedCountRef.current = scene
    ? (Array.isArray(scene.selected_ids)
        ? scene.selected_ids.length
        : scene.selected_id
          ? 1
          : 0)
    : 0;

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
          selectedPickIds: selectedPickIds(next),
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

  const clearSnapMarker = useCallback(() => {
    rendererRef.current?.setSnapMarker(null);
  }, []);

  const showSnapMarker = useCallback(
    (point: [number, number, number] | null, shiftHeld: boolean) => {
      const renderer = rendererRef.current;
      if (!renderer) return;
      if (shiftHeld && point) renderer.setSnapMarker(point);
      else renderer.setSnapMarker(null);
    },
    [],
  );

  const cancelWall = useCallback(() => {
    wallStartRef.current = null;
    setPendingStart(null);
    clearPlacementPreview();
    clearSnapMarker();
  }, [clearPlacementPreview, clearSnapMarker]);

  /** Escape: cancel placement, clear selection, switch to Select. */
  const onEscape = useCallback(() => {
    cancelWall();
    setTool('select');
    const active = document.activeElement;
    if (
      active instanceof HTMLElement &&
      (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT')
    ) {
      active.blur();
    }
    try {
      applyScene(apexSelectElement(null), false);
    } catch {
      rendererRef.current?.setEditGizmo(null, null);
      setSelected(null);
    }
  }, [applyScene, cancelWall]);

  const goSelect = useCallback(() => {
    cancelWall();
    setTool('select');
    syncEditGizmo(selectedRef.current);
  }, [cancelWall, syncEditGizmo]);

  useEffect(() => {
    const isEscape = (e: KeyboardEvent) => e.key === 'Escape' || e.code === 'Escape';
    const onKeyDown = (e: KeyboardEvent) => {
      if (isEscape(e)) {
        e.preventDefault();
        onEscape();
        return;
      }
      if (e.key === 'Shift') shiftHeldRef.current = true;
      const active = document.activeElement;
      const typing =
        active instanceof HTMLElement &&
        (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT');
      if (!typing && (e.key === 'Delete' || e.key === 'Backspace') && selectedCountRef.current > 0) {
        e.preventDefault();
        try {
          applyScene(apexDeleteSelected(), false);
        } catch {
          /* ignore */
        }
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Shift') {
        shiftHeldRef.current = false;
        clearSnapMarker();
      }
    };
    // Capture phase so Escape still wins when an input has focus.
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
    };
  }, [applyScene, clearSnapMarker, onEscape]);

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

  useEffect(() => {
    if (!ready) return;
    const id = window.setInterval(() => {
      setFps(rendererRef.current?.getFps() ?? 0);
    }, 500);
    return () => window.clearInterval(id);
  }, [ready]);

  const setProjectionMode = useCallback((mode: ProjectionMode) => {
    setProjection(mode);
    rendererRef.current?.setProjection(mode);
  }, []);

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
    // Match the on-screen adaptive grid (coarser when zoomed out / looking far).
    const step = renderer.getGridStep();
    let point = snapPointToGrid(raw, step);
    if (anchor) {
      point = snapPointToGrid(orthoConstrain(anchor, point), step);
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
      showSnapMarker(point, shift);
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
            selectedPickIds: selectedPickIds(next),
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

    if (tool === 'wall') {
      const anchor = wallStartRef.current;
      const point = resolveGroundPoint(renderer, e.clientX, e.clientY, shift, anchor);
      if (!point) {
        showSnapMarker(null, false);
        return;
      }
      showSnapMarker(point, shift);
      if (anchor) showPlacementPreview(anchor, point);
      return;
    }

    // Select tool: still show snap ring while Shift-moving over the ground.
    if (shift) {
      const point = resolveGroundPoint(renderer, e.clientX, e.clientY, true);
      showSnapMarker(point, !!point);
    } else {
      showSnapMarker(null, false);
    }
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
      const multi = e.ctrlKey || e.metaKey;
      const pick = renderer.pick(e.clientX, e.clientY);
      if (pick == null) {
        if (!multi) applyScene(apexSelectElement(null), false);
      } else if (multi) {
        applyScene(apexTogglePickById(pick), false);
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

  const onSelectFromTree = (id: string, multi: boolean) => {
    goSelect();
    applyScene(multi ? apexToggleSelectElement(id) : apexSelectElement(id), false);
  };

  const selectedIds = scene ? selectedIdList(scene) : [];
  const selectedCount = selectedIds.length;

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
          APEX
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
          <span className="tools-sep" aria-hidden="true" />
          <button
            type="button"
            className={projection === 'orthographic' ? 'active' : ''}
            onClick={() => setProjectionMode('orthographic')}
            title="Parallel (axonometric) projection"
          >
            Ortho
          </button>
          <button
            type="button"
            className={projection === 'perspective' ? 'active' : ''}
            onClick={() => setProjectionMode('perspective')}
            title="Perspective projection"
          >
            Persp
          </button>
        </div>
        <div className="hint">
          {tool === 'wall'
            ? pendingStart
              ? 'Click end · Shift snap+ortho · Esc clears'
              : 'Click start · Shift snap to grid · Esc clears'
            : selectedCount > 1
              ? `${selectedCount} selected · Ctrl+click toggle · Del · Esc clears`
              : selected?.category === 'wall'
                ? 'Drag endpoints · Ctrl+click multi · Esc clears'
                : 'Click select · Ctrl+click multi · RMB orbit · MMB pan'}
        </div>
      </header>

      <aside className="sidebar">
        <div className="panel-title">Elements</div>
        <ElementTree
          elements={elements}
          selectedIds={selectedIds}
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
        <div className="viewport-badge">
          WebGL2 · {fps > 0 ? `${fps} fps` : '…'} · v{scene?.version ?? 0}
        </div>
      </div>

      <aside className="inspector">
        <div className="panel-title">Properties</div>
        <PropertiesPanel
          selected={selected}
          selectedCount={selectedCount}
          onUpdate={onUpdateWall}
          onDelete={onDelete}
        />
      </aside>
    </div>
  );
}
