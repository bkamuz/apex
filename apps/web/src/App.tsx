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

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<ViewportRenderer | null>(null);
  const wallStartRef = useRef<[number, number, number] | null>(null);
  const shiftHeldRef = useRef(false);

  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tool, setTool] = useState<ToolMode>('wall');
  const [scene, setScene] = useState<SceneDto | null>(null);
  const [selected, setSelected] = useState<ElementDto | null>(null);
  const [pendingStart, setPendingStart] = useState<[number, number, number] | null>(null);

  const applyScene = useCallback((next: SceneDto, fitCamera = false) => {
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
      renderer.setPreviewLine(null, null);
    }
    setSelected(apexGetSelected());
  }, []);

  const cancelWall = useCallback(() => {
    wallStartRef.current = null;
    setPendingStart(null);
    rendererRef.current?.setPreviewLine(null, null);
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancelWall();
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
  }, [cancelWall]);

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
  ): [number, number, number] | null => {
    const raw = renderer.screenToGround(clientX, clientY, 0);
    if (!raw) return null;
    if (!shiftHeld) return raw;
    // Shift: snap to grid; while placing the end point, also ortho-constrain.
    let point = snapPointToGrid(raw, GRID_STEP);
    if (wallStartRef.current) {
      point = snapPointToGrid(orthoConstrain(wallStartRef.current, point), GRID_STEP);
    }
    return point;
  };

  const onCanvasPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!ready || !rendererRef.current || tool !== 'wall' || !wallStartRef.current) return;
    const end = resolveGroundPoint(
      rendererRef.current,
      e.clientX,
      e.clientY,
      e.shiftKey || shiftHeldRef.current,
    );
    if (!end) return;
    rendererRef.current.setPreviewLine(wallStartRef.current, end);
  };

  const onCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!ready || !rendererRef.current) return;
    if (e.button !== 0) return;

    const renderer = rendererRef.current;

    if (tool === 'select') {
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
        renderer.setPreviewLine(point, point);
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
        // Keep the user's camera — do not refit after place.
        applyScene(next, false);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  };

  const onSelectFromTree = (id: string) => {
    setTool('select');
    cancelWall();
    applyScene(apexSelectElement(id), false);
  };

  const onUpdateWall = (patch: {
    height: number;
    thickness: number;
    start: [number, number, number];
    end: [number, number, number];
  }) => {
    if (!selected) return;
    const next = apexSetWallParams(
      selected.id,
      patch.height,
      patch.thickness,
      patch.start,
      patch.end,
    );
    applyScene(next, false);
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
            onClick={() => {
              cancelWall();
              setTool('select');
            }}
          >
            Select
          </button>
          <button
            type="button"
            className={tool === 'wall' ? 'active' : ''}
            onClick={() => setTool('wall')}
          >
            Wall
          </button>
        </div>
        <div className="hint">
          {tool === 'wall'
            ? pendingStart
              ? 'Click end · Shift snap+ortho · Esc cancel'
              : 'Click start · Shift snap to 1 m grid'
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
          onPointerMove={onCanvasPointerMove}
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
