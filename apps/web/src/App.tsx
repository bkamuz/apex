import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  apexCreateLevel,
  apexCreateWall,
  apexDeleteSelected,
  apexGetScene,
  apexGetSelected,
  apexPickById,
  apexSelectElement,
  apexSetActiveLevel,
  apexSetLevelElevation,
  apexSetWallParams,
  apexTogglePickById,
  apexToggleSelectElement,
  initApex,
} from './wasm/apex';
import {
  GRID_STEP,
  orthoConstrain,
  snapPointToGrid,
  ViewportRenderer,
  type ProjectionMode,
} from './viewport/ViewportRenderer';
import { buildWallSolid } from './viewport/wallMesh';
import type { ElementDto, ElementListDto, LevelDto, SceneDto, ToolMode } from './types';
import { ElementTree } from './components/ElementTree';
import { LevelList } from './components/LevelList';
import { MobileMenuSheet, type MobileMenuTab } from './components/MobileMenuSheet';
import { PropertiesPanel } from './components/PropertiesPanel';
import { useMediaQuery } from './hooks/useMediaQuery';

const DEFAULT_HEIGHT = 3;
const DEFAULT_THICKNESS = 0.2;
const MIN_WALL_LENGTH = 0.1;
const DEFAULT_LEVEL_RISE = 3;

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

function syncLevelPlanes(renderer: ViewportRenderer, scene: SceneDto): void {
  const activeId = scene.active_level_id;
  renderer.setLevelPlanes(
    (scene.levels ?? []).map((level) => ({
      id: level.id,
      elevation: level.elevation,
      active: level.id === activeId,
    })),
  );
}

type HandleWhich = 'start' | 'end';

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<ViewportRenderer | null>(null);
  const wallStartRef = useRef<[number, number, number] | null>(null);
  const shiftHeldRef = useRef(false);
  const selectedRef = useRef<ElementDto | null>(null);
  const selectedCountRef = useRef(0);
  const activeElevationRef = useRef(0);
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
  const [selectedLevelId, setSelectedLevelId] = useState<string | null>(null);
  const [pendingStart, setPendingStart] = useState<[number, number, number] | null>(null);
  const [fps, setFps] = useState(0);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [mobileMenuTab, setMobileMenuTab] = useState<MobileMenuTab>('levels');
  const isMobile = useMediaQuery('(max-width: 900px)');

  selectedRef.current = selected;
  selectedCountRef.current = scene
    ? Array.isArray(scene.selected_ids)
      ? scene.selected_ids.length
      : scene.selected_id
        ? 1
        : 0
    : 0;

  const levels: LevelDto[] = useMemo(() => scene?.levels ?? [], [scene]);
  const activeLevel = useMemo(() => {
    if (!scene?.active_level_id) return levels[0] ?? null;
    return levels.find((l) => l.id === scene.active_level_id) ?? levels[0] ?? null;
  }, [scene, levels]);
  activeElevationRef.current = activeLevel?.elevation ?? 0;

  const selectedLevel = useMemo(() => {
    if (!selectedLevelId) return activeLevel;
    return levels.find((l) => l.id === selectedLevelId) ?? activeLevel;
  }, [selectedLevelId, levels, activeLevel]);

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

  const clearSnapMarker = useCallback(() => {
    rendererRef.current?.setSnapMarker(null);
  }, []);

  const showSnapMarker = useCallback((point: [number, number, number] | null, shiftHeld: boolean) => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    if (shiftHeld && point) renderer.setSnapMarker(point);
    else renderer.setSnapMarker(null);
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
        syncLevelPlanes(renderer, next);
      }
      const sel = apexGetSelected();
      setSelected(sel);
      if (sel) setSelectedLevelId(sel.level_id);
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
    clearSnapMarker();
    rendererRef.current?.setTouchOrbitEnabled(true);
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
    clearSnapMarker();
    syncEditGizmo(selectedRef.current);
  }, [cancelWall, clearSnapMarker, syncEditGizmo]);

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
          setSelectedLevelId(initial.active_level_id);
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

  const closeMobileMenu = useCallback(() => setMobileMenuOpen(false), []);

  const openMobileMenu = useCallback((tab?: MobileMenuTab) => {
    if (tab) setMobileMenuTab(tab);
    setMobileMenuOpen(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    const id = window.setInterval(() => {
      setFps(rendererRef.current?.getFps() ?? 0);
    }, 500);
    return () => window.clearInterval(id);
  }, [ready]);

  // Close mobile menu when the layout becomes desktop-width again.
  useEffect(() => {
    if (!isMobile) setMobileMenuOpen(false);
  }, [isMobile]);

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
    elevation: number,
    anchor: [number, number, number] | null = wallStartRef.current,
  ): [number, number, number] | null => {
    const raw = renderer.screenToGround(clientX, clientY, elevation);
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
    rendererRef.current.setTouchOrbitEnabled(false);
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
      const elev = sel.start?.[1] ?? activeElevationRef.current;
      const point = resolveGroundPoint(renderer, e.clientX, e.clientY, shift, elev, fixed);
      if (!point) {
        clearSnapMarker();
        return;
      }
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
          syncLevelPlanes(renderer, next);
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
      const point = resolveGroundPoint(
        renderer,
        e.clientX,
        e.clientY,
        shift,
        activeElevationRef.current,
        anchor,
      );
      if (!point) {
        clearSnapMarker();
        return;
      }
      showSnapMarker(point, shift);
      if (anchor) showPlacementPreview(anchor, point);
      return;
    }

    if (tool === 'select') {
      const point = resolveGroundPoint(
        renderer,
        e.clientX,
        e.clientY,
        shift,
        activeElevationRef.current,
        null,
      );
      showSnapMarker(point, shift);
    }
  };

  const onCanvasPointerLeave = () => {
    clearSnapMarker();
  };

  const onCanvasPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = handleDragRef.current;
    if (!drag) return;
    handleDragRef.current = null;
    rendererRef.current?.setTouchOrbitEnabled(!wallStartRef.current);
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
    if (rendererRef.current.consumeCameraGesture()) return;

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
        activeElevationRef.current,
      );
      if (!point) return;

      if (!wallStartRef.current) {
        wallStartRef.current = point;
        setPendingStart(point);
        renderer.setEditGizmo(null, null);
        renderer.setTouchOrbitEnabled(false);
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
      renderer.setTouchOrbitEnabled(true);
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

  const onCanvasDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!ready || !rendererRef.current) return;
    if (e.button !== 0) return;
    if (rendererRef.current.consumeCameraGesture()) return;
    e.preventDefault();
    const hit = rendererRef.current.hitLevelContour(e.clientX, e.clientY);
    if (!hit) return;
    suppressClickRef.current = true;
    window.setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);
    try {
      cancelWall();
      const next = apexSetActiveLevel(hit);
      setSelectedLevelId(hit);
      applyScene(next, false);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onSelectFromTree = (id: string, multi: boolean) => {
    goSelect();
    applyScene(multi ? apexToggleSelectElement(id) : apexSelectElement(id), false);
  };

  const onSelectLevel = (id: string) => {
    setSelectedLevelId(id);
    try {
      applyScene(apexSelectElement(null), false);
    } catch {
      setSelected(null);
    }
  };

  const onCreateLevel = () => {
    const maxElev = levels.reduce(
      (m, l) => Math.max(m, l.elevation),
      Number.NEGATIVE_INFINITY,
    );
    const elevation = levels.length === 0 ? 0 : maxElev + DEFAULT_LEVEL_RISE;
    try {
      const next = apexCreateLevel('', elevation);
      const createdId =
        next.levels.find((l) => !levels.some((prev) => prev.id === l.id))?.id ??
        next.levels[next.levels.length - 1]?.id ??
        null;
      // Clear wall selection so applyScene does not overwrite the new level id.
      const cleared = apexSelectElement(null);
      applyScene(cleared, false);
      setSelectedLevelId(createdId);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onUpdateLevelElevation = (id: string, elevation: number) => {
    try {
      const next = apexSetLevelElevation(id, elevation);
      applyScene(next, false);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
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
        <div className="brand">APEX</div>
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
              clearSnapMarker();
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
              ? `Click end on ${activeLevel?.name ?? 'level'} · Shift snap · Esc`
              : `Wall on ${activeLevel?.name ?? 'level'} · MMB pan · RMB orbit · wheel zoom`
            : 'MMB pan · RMB orbit · wheel zoom · 3-finger orbit · dbl-click level'}
        </div>
      </header>

      {!isMobile ? (
        <aside className="sidebar">
          <LevelList
            levels={levels}
            activeLevelId={scene?.active_level_id ?? null}
            selectedLevelId={selectedLevel?.id ?? null}
            onSelect={onSelectLevel}
            onCreate={onCreateLevel}
          />
          <div className="panel-title">Elements</div>
          <ElementTree
            elements={elements}
            selectedIds={selectedIds}
            onSelect={(id, multi) => onSelectFromTree(id, multi)}
          />
        </aside>
      ) : null}

      <div className="viewport-wrap">
        {!ready && !error && <div className="loading">Loading Apex core…</div>}
        {error && <div className="error-banner">{error}</div>}
        <canvas
          ref={canvasRef}
          onClick={onCanvasClick}
          onDoubleClick={onCanvasDoubleClick}
          onContextMenu={(e) => e.preventDefault()}
          onPointerDown={onCanvasPointerDown}
          onPointerMove={onCanvasPointerMove}
          onPointerUp={onCanvasPointerUp}
          onPointerCancel={onCanvasPointerUp}
          onPointerLeave={onCanvasPointerLeave}
        />
        {isMobile ? (
          <button
            type="button"
            className="mobile-menu-fab"
            onClick={() => openMobileMenu()}
            title="Open scene menu"
            aria-label="Open scene menu"
          >
            Menu
          </button>
        ) : null}
        <div className="viewport-badge">
          WebGL2 · {fps > 0 ? `${fps} fps` : '…'} · {activeLevel?.name ?? '—'} · v
          {scene?.version ?? 0}
        </div>
        {isMobile ? (
          <MobileMenuSheet
            open={mobileMenuOpen}
            tab={mobileMenuTab}
            onTabChange={setMobileMenuTab}
            onClose={closeMobileMenu}
            levels={
              <LevelList
                levels={levels}
                activeLevelId={scene?.active_level_id ?? null}
                selectedLevelId={selectedLevel?.id ?? null}
                onSelect={(id) => {
                  onSelectLevel(id);
                  closeMobileMenu();
                }}
                onCreate={onCreateLevel}
              />
            }
            elements={
              <ElementTree
                elements={elements}
                selectedIds={selectedIds}
                onSelect={(id, multi) => {
                  onSelectFromTree(id, multi);
                  if (!multi) closeMobileMenu();
                }}
              />
            }
            properties={
              <PropertiesPanel
                selected={selected}
                selectedCount={selectedCount}
                selectedLevel={selectedCount === 0 ? selectedLevel : null}
                onUpdate={onUpdateWall}
                onUpdateLevelElevation={onUpdateLevelElevation}
                onDelete={onDelete}
              />
            }
          />
        ) : null}
      </div>

      {!isMobile ? (
        <aside className="inspector">
          <div className="panel-title">Properties</div>
          <PropertiesPanel
            selected={selected}
            selectedCount={selectedCount}
            selectedLevel={selectedCount === 0 ? selectedLevel : null}
            onUpdate={onUpdateWall}
            onUpdateLevelElevation={onUpdateLevelElevation}
            onDelete={onDelete}
          />
        </aside>
      ) : null}
    </div>
  );
}
