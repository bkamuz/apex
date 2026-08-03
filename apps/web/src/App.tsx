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
import { ViewportRenderer } from './viewport/ViewportRenderer';
import type { ElementDto, ElementListDto, SceneDto, ToolMode } from './types';
import { ElementTree } from './components/ElementTree';
import { PropertiesPanel } from './components/PropertiesPanel';

const DEFAULT_HEIGHT = 3;
const DEFAULT_THICKNESS = 0.2;

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

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<ViewportRenderer | null>(null);
  const wallStartRef = useRef<[number, number, number] | null>(null);

  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tool, setTool] = useState<ToolMode>('wall');
  const [scene, setScene] = useState<SceneDto | null>(null);
  const [selected, setSelected] = useState<ElementDto | null>(null);
  const [pendingStart, setPendingStart] = useState<[number, number, number] | null>(null);

  const applyScene = useCallback(async (next: SceneDto) => {
    setScene(next);
    const renderer = rendererRef.current;
    if (renderer) {
      renderer.setScene({
        positions: toFloatArray(next.positions),
        normals: toFloatArray(next.normals),
        indices: toUint32Array(next.indices),
        pickIds: next.pick_ids,
        selectedPickId: selectedPickId(next),
      });
    }
    const sel = await apexGetSelected();
    setSelected(sel);
  }, []);

  const cancelWall = useCallback(() => {
    wallStartRef.current = null;
    setPendingStart(null);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancelWall();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
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
        const initial = await apexGetScene();
        if (!cancelled) {
          await applyScene(initial);
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

  const onCanvasClick = async (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!ready || !rendererRef.current) return;
    if (e.button !== 0 || e.shiftKey) return;

    const renderer = rendererRef.current;

    if (tool === 'select') {
      const pick = renderer.pick(e.clientX, e.clientY);
      if (pick == null) {
        await applyScene(await apexSelectElement(null));
      } else {
        await applyScene(await apexPickById(pick));
      }
      return;
    }

    if (tool === 'wall') {
      const point = renderer.screenToGround(e.clientX, e.clientY, 0);
      if (!point) return;

      if (!wallStartRef.current) {
        wallStartRef.current = point;
        setPendingStart(point);
        return;
      }

      const start = wallStartRef.current;
      const end = point;
      wallStartRef.current = null;
      setPendingStart(null);

      try {
        const next = await apexCreateWall(
          start[0],
          start[1],
          start[2],
          end[0],
          end[1],
          end[2],
          DEFAULT_HEIGHT,
          DEFAULT_THICKNESS,
        );
        await applyScene(next);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  };

  const onSelectFromTree = async (id: string) => {
    setTool('select');
    await applyScene(await apexSelectElement(id));
  };

  const onUpdateWall = async (patch: {
    height: number;
    thickness: number;
    start: [number, number, number];
    end: [number, number, number];
  }) => {
    if (!selected) return;
    const next = await apexSetWallParams(
      selected.id,
      patch.height,
      patch.thickness,
      patch.start,
      patch.end,
    );
    await applyScene(next);
  };

  const onDelete = async () => {
    await applyScene(await apexDeleteSelected());
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          APEX <span>BIM</span>
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
              ? 'Click end point · Esc cancel'
              : 'Click start point on grid'
            : 'Click to select · Drag RMB orbit · Shift pan · Wheel zoom'}
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
        <canvas ref={canvasRef} onClick={onCanvasClick} />
        <div className="viewport-badge">
          WebGL2 · Rust/WASM · v{scene?.version ?? 0}
        </div>
      </div>

      <aside className="inspector">
        <div className="panel-title">Properties</div>
        <PropertiesPanel selected={selected} onUpdate={onUpdateWall} onDelete={onDelete} />
      </aside>
    </div>
  );
}
