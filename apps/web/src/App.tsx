import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  apexCreateElement,
  apexCreateLevel,
  apexDeleteSelected,
  apexGetScene,
  apexGetSelected,
  apexListComponents,
  apexListProfiles,
  apexPickById,
  apexPreviewElement,
  apexRegisterProfile,
  apexSelectElement,
  apexSetActiveLevel,
  apexSetElementPlacement,
  apexSetLevelElevation,
  apexTogglePickById,
  apexToggleSelectElement,
  apexUpdateElement,
  initApex,
} from './wasm/apex';
import {
  GRID_STEP,
  orthoConstrain,
  snapPointToGrid,
  ViewportRenderer,
  type ProjectionMode,
  type Vec3,
} from './viewport/ViewportRenderer';
import type {
  ComponentDto,
  ElementDto,
  ElementListDto,
  LevelDto,
  ParamValue,
  PlacementKind,
  ProfileTypeDto,
  SceneDto,
} from './types';
import { ElementTree } from './ui/ElementTree';
import { LevelList } from './ui/LevelList';
import { MobileMenuSheet, type MobileMenuTab } from './ui/MobileMenuSheet';
import { ProfileEditor } from './ui/ProfileEditor';
import { PropertiesPanel } from './ui/PropertiesPanel';
import { defaultNewProfile, defaultPlacementParams, nextProfileId } from './ui/profileModel';
import { useMediaQuery } from './hooks/useMediaQuery';
import { ToolRegistry } from './tools/registry';
import { finishOpenGesture } from './tools/placementTool';
import { requiredPoints, type PointerInfo, type ToolContext } from './tools/Tool';
import { extensions, installGlobalSdk } from './extensions/sdk';
import { installPlugins } from './plugins';

const DEFAULT_LEVEL_RISE = 3;

function makeToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  installPlugins(registry, []);
  return registry;
}

function toFloatArray(data: ArrayLike<number> | number[]): Float32Array {
  return data instanceof Float32Array ? data : new Float32Array(data);
}

function toUint32Array(data: ArrayLike<number> | number[]): Uint32Array {
  return data instanceof Uint32Array ? data : new Uint32Array(data);
}

function selectedPickIds(scene: SceneDto): number[] {
  const picks: number[] = [];
  for (const id of scene.selected_ids ?? []) {
    const hit = scene.elements.find((e) => e.id === id);
    if (hit) picks.push(hit.pick_id);
  }
  return picks;
}

function syncLevelPlanes(renderer: ViewportRenderer, scene: SceneDto): void {
  renderer.setLevelPlanes(
    (scene.levels ?? []).map((level) => ({
      id: level.id,
      elevation: level.elevation,
      active: level.id === scene.active_level_id,
    })),
  );
}

function pointerInfo(e: React.PointerEvent | React.MouseEvent): PointerInfo {
  return {
    clientX: e.clientX,
    clientY: e.clientY,
    shift: e.shiftKey,
    multi: e.ctrlKey || e.metaKey,
  };
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<ViewportRenderer | null>(null);
  const registryRef = useRef<ToolRegistry>(makeToolRegistry());
  const shiftHeldRef = useRef(false);
  const selectedRef = useRef<ElementDto | null>(null);
  const selectedCountRef = useRef(0);
  const activeElevationRef = useRef(0);
  const suppressClickRef = useRef(false);
  const draggingRef = useRef(false);
  const placementParamsRef = useRef<Record<string, ParamValue>>({});

  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [components, setComponents] = useState<ComponentDto[]>([]);
  const [profiles, setProfiles] = useState<ProfileTypeDto[]>([]);
  const [placementDraft, setPlacementDraft] = useState<Record<string, ParamValue>>({});
  const [profileEditor, setProfileEditor] = useState<{
    profile: ProfileTypeDto;
    originalId: string | null;
  } | null>(null);
  const [toolId, setToolId] = useState<string>(ToolRegistry.selectId);
  const placementToolIdRef = useRef(toolId);
  const [drawMode, setDrawMode] = useState<string | null>(null);
  const [projection, setProjection] = useState<ProjectionMode>('orthographic');
  const [scene, setScene] = useState<SceneDto | null>(null);
  const [selected, setSelected] = useState<ElementDto | null>(null);
  const [selectedLevelId, setSelectedLevelId] = useState<string | null>(null);
  const [pending, setPending] = useState<Vec3[]>([]);
  const [fps, setFps] = useState(0);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [mobileMenuTab, setMobileMenuTab] = useState<MobileMenuTab>('levels');
  const isMobile = useMediaQuery('(max-width: 900px)');

  selectedRef.current = selected;
  selectedCountRef.current = scene?.selected_ids?.length ?? 0;
  placementParamsRef.current = placementDraft;

  const tool = registryRef.current.get(toolId) ?? registryRef.current.get(ToolRegistry.selectId)!;
  const toolRef = useRef(tool);
  toolRef.current = tool;

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

  const selectedComponent = useMemo(() => {
    if (!selected) return null;
    return components.find((c) => c.id === selected.component_id) ?? null;
  }, [selected, components]);

  const syncEditGizmo = useCallback((el: ElementDto | null) => {
    rendererRef.current?.setEditGizmo(el?.anchors?.length ? el.anchors : null);
  }, []);

  const clearPreview = useCallback(() => {
    rendererRef.current?.setPreviewLine(null);
    rendererRef.current?.setGhostMesh(null);
  }, []);

  /** Pull installed components/profiles and let each plugin contribute its tool. */
  const syncCatalog = useCallback(() => {
    const installed = apexListComponents();
    installPlugins(registryRef.current, installed);
    setComponents(installed);
    setProfiles(apexListProfiles());
  }, []);

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
      if (!draggingRef.current) syncEditGizmo(sel);
    },
    [syncEditGizmo],
  );

  /** Screen point to a world point on the active work plane, with Shift snapping. */
  const resolvePoint = useCallback(
    (clientX: number, clientY: number, shift: boolean, anchor: Vec3 | null): Vec3 | null => {
      const renderer = rendererRef.current;
      if (!renderer) return null;
      const raw = renderer.screenToGround(clientX, clientY, activeElevationRef.current);
      if (!raw) return null;
      if (!shift && !shiftHeldRef.current) return raw;
      let point = snapPointToGrid(raw, GRID_STEP);
      if (anchor) point = snapPointToGrid(orthoConstrain(anchor, point), GRID_STEP);
      return point;
    },
    [],
  );

  /** Fresh services for the active tool; nothing is captured across events. */
  const toolContext = useCallback((): ToolContext => {
    const renderer = rendererRef.current!;
    return {
      resolvePoint: (x, y, shift, anchor) => resolvePoint(x, y, shift, anchor),

      createElement: (componentId, points, placementKind) => {
        try {
          applyScene(
            apexCreateElement(componentId, points, placementParamsRef.current, 0, placementKind),
          );
          setError(null);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      },

      showPreview: (componentId, points, placementKind) => {
        try {
          const mesh = apexPreviewElement(
            componentId,
            points,
            placementParamsRef.current,
            0,
            placementKind,
          );
          renderer.setGhostMesh({
            positions: toFloatArray(mesh.positions),
            normals: toFloatArray(mesh.normals),
            indices: toUint32Array(mesh.indices),
          });
        } catch {
          // A not-yet-valid gesture simply has no ghost.
          renderer.setGhostMesh(null);
        }
      },

      clearPreview: () => renderer.setGhostMesh(null),
      showPreviewLine: (points) => renderer.setPreviewLine(points),

      showSnapMarker: (point, shift) => {
        renderer.setSnapMarker(shift || shiftHeldRef.current ? point : null);
      },

      pick: (x, y) => renderer.pick(x, y),

      selectByPick: (pickId, multi) => {
        if (pickId == null) {
          if (!multi) applyScene(apexSelectElement(null));
        } else {
          applyScene(multi ? apexTogglePickById(pickId) : apexPickById(pickId));
        }
      },

      hitEditHandle: (x, y) => renderer.hitEditHandle(x, y),
      selectedAnchors: () =>
        selectedCountRef.current === 1 ? (selectedRef.current?.anchors ?? null) : null,

      previewAnchors: (anchors) => {
        draggingRef.current = true;
        renderer.setEditGizmo(anchors);
        const sel = selectedRef.current;
        if (!sel) return;
        try {
          // Live-update through the core so the solid follows the handle.
          const next = apexSetElementPlacement(sel.id, anchors);
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
        } catch {
          // Keep dragging even if one intermediate placement is invalid.
        }
      },

      commitAnchors: (anchors) => {
        draggingRef.current = false;
        const sel = selectedRef.current;
        if (!sel) return;
        try {
          applyScene(apexSetElementPlacement(sel.id, anchors));
          setError(null);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
          syncEditGizmo(sel);
        }
      },

      setError,
      setPending,
      setTouchOrbitEnabled: (enabled) => renderer.setTouchOrbitEnabled(enabled),
    };
  }, [applyScene, resolvePoint, syncEditGizmo]);

  const cancelGesture = useCallback(() => {
    if (!rendererRef.current) return;
    toolRef.current.cancel?.(toolContext());
    setPending([]);
    clearPreview();
    rendererRef.current.setSnapMarker(null);
  }, [clearPreview, toolContext]);

  const activateTool = useCallback(
    (id: string) => {
      cancelGesture();
      setToolId(id);
      const next = registryRef.current.get(id);
      setDrawMode(next?.getMode?.() ?? null);
      if (id === ToolRegistry.selectId) syncEditGizmo(selectedRef.current);
      else rendererRef.current?.setEditGizmo(null);
      const component = components.find((item) => item.id === next?.componentId);
      if (component) {
        const draft = defaultPlacementParams(component, profiles);
        placementParamsRef.current = draft;
        placementToolIdRef.current = id;
        setPlacementDraft(draft);
      } else {
        placementParamsRef.current = {};
        placementToolIdRef.current = id;
        setPlacementDraft({});
      }
    },
    [cancelGesture, components, profiles, syncEditGizmo],
  );

  const activateDrawMode = useCallback(
    (id: string) => {
      cancelGesture();
      toolRef.current.setMode?.(id);
      setDrawMode(toolRef.current.getMode?.() ?? id);
    },
    [cancelGesture],
  );

  useEffect(() => {
    const switched = placementToolIdRef.current !== toolId;
    placementToolIdRef.current = toolId;
    const component = components.find((item) => item.id === tool.componentId);
    if (!component) {
      placementParamsRef.current = {};
      setPlacementDraft({});
      return;
    }
    if (!switched && Object.keys(placementParamsRef.current).length > 0) return;
    const next = defaultPlacementParams(component, profiles);
    placementParamsRef.current = next;
    setPlacementDraft(next);
  }, [toolId, tool.componentId, components, profiles]);

  /** Escape: abandon the gesture, clear selection, fall back to Select. */
  const onEscape = useCallback(() => {
    cancelGesture();
    setToolId(ToolRegistry.selectId);
    const active = document.activeElement;
    if (
      active instanceof HTMLElement &&
      (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT')
    ) {
      active.blur();
    }
    try {
      applyScene(apexSelectElement(null));
    } catch {
      rendererRef.current?.setEditGizmo(null);
      setSelected(null);
    }
  }, [applyScene, cancelGesture]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.code === 'Escape') {
        e.preventDefault();
        if (profileEditor) {
          setProfileEditor(null);
          return;
        }
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
          applyScene(apexDeleteSelected());
        } catch {
          /* ignore */
        }
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Shift') {
        shiftHeldRef.current = false;
        rendererRef.current?.setSnapMarker(null);
      }
    };
    // Capture phase so Escape still wins when an input has focus.
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
    };
  }, [applyScene, onEscape, profileEditor]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await initApex();
        if (cancelled) return;
        const canvas = canvasRef.current;
        if (!canvas) return;
        rendererRef.current = new ViewportRenderer(canvas);

        // The toolbar is generated from whatever the core has installed.
        syncCatalog();
        installGlobalSdk();

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
  }, [applyScene, syncCatalog]);

  const closeMobileMenu = useCallback(() => setMobileMenuOpen(false), []);
  const openMobileMenu = useCallback((tab?: MobileMenuTab) => {
    if (tab) setMobileMenuTab(tab);
    setMobileMenuOpen(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    const id = window.setInterval(() => setFps(rendererRef.current?.getFps() ?? 0), 500);
    return () => window.clearInterval(id);
  }, [ready]);

  useEffect(() => {
    if (!isMobile) setMobileMenuOpen(false);
  }, [isMobile]);

  const setProjectionMode = useCallback((mode: ProjectionMode) => {
    setProjection(mode);
    rendererRef.current?.setProjection(mode);
  }, []);

  // A module can install a component at any time; the toolbar follows.
  useEffect(() => {
    if (!ready) return;
    return extensions.subscribe(() => {
      syncCatalog();
      applyScene(apexGetScene());
    });
  }, [ready, syncCatalog, applyScene]);

  const elements: ElementListDto[] = useMemo(() => scene?.elements ?? [], [scene]);

  const placementKindOf = (componentId: string): PlacementKind =>
    components.find((c) => c.id === componentId)?.placement ?? 'point';

  // -- canvas events: pure dispatch, no per-tool branching -------------------

  const onCanvasPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!ready || !rendererRef.current || e.button !== 0) return;
    const claimed = tool.onPointerDown?.(pointerInfo(e), toolContext()) ?? false;
    if (!claimed) return;
    suppressClickRef.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  const onCanvasPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!ready || !rendererRef.current) return;
    tool.onPointerMove?.(pointerInfo(e), toolContext());
  };

  const onCanvasPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!ready || !rendererRef.current) return;
    tool.onPointerUp?.(pointerInfo(e), toolContext());
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    if (suppressClickRef.current) {
      // Avoid the trailing click selecting or deselecting after a drag.
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
    }
  };

  const onCanvasPointerLeave = () => {
    rendererRef.current?.setSnapMarker(null);
  };

  const onCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!ready || !rendererRef.current) return;
    if (e.button !== 0) return;
    if (suppressClickRef.current) return;
    if (rendererRef.current.consumeCameraGesture()) return;
    tool.onClick?.(pointerInfo(e), toolContext());
  };

  const onCanvasDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!ready || !rendererRef.current) return;
    if (e.button !== 0) return;
    if (rendererRef.current.consumeCameraGesture()) return;
    e.preventDefault();

    // A variable-length gesture (polyline) ends on double-click.
    const kind =
      tool.placementKind?.() ??
      (tool.componentId ? placementKindOf(tool.componentId) : 'point');
    if (tool.componentId && requiredPoints(kind) === null) {
      if (finishOpenGesture(tool, pending, toolContext())) {
        setPending([]);
        return;
      }
    }

    const hit = rendererRef.current.hitLevelContour(e.clientX, e.clientY);
    if (!hit) return;
    suppressClickRef.current = true;
    window.setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);
    try {
      cancelGesture();
      applyScene(apexSetActiveLevel(hit));
      setSelectedLevelId(hit);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // -- sidebar / inspector ---------------------------------------------------

  const onSelectFromTree = (id: string, multi: boolean) => {
    activateTool(ToolRegistry.selectId);
    applyScene(multi ? apexToggleSelectElement(id) : apexSelectElement(id));
  };

  const onSelectLevel = (id: string) => {
    setSelectedLevelId(id);
    try {
      applyScene(apexSelectElement(null));
    } catch {
      setSelected(null);
    }
  };

  const onCreateLevel = () => {
    const maxElev = levels.reduce((m, l) => Math.max(m, l.elevation), Number.NEGATIVE_INFINITY);
    const elevation = levels.length === 0 ? 0 : maxElev + DEFAULT_LEVEL_RISE;
    try {
      const next = apexCreateLevel('', elevation);
      const createdId =
        next.levels.find((l) => !levels.some((prev) => prev.id === l.id))?.id ??
        next.levels[next.levels.length - 1]?.id ??
        null;
      // Clear the element selection so applyScene does not overwrite the new level id.
      applyScene(apexSelectElement(null));
      setSelectedLevelId(createdId);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onUpdateLevelElevation = (id: string, elevation: number) => {
    try {
      applyScene(apexSetLevelElevation(id, elevation));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onUpdateParams = (params: Record<string, ParamValue>) => {
    if (!selected) return;
    try {
      applyScene(apexUpdateElement(selected.id, params));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onPlacementChange = (params: Record<string, ParamValue>) => {
    placementParamsRef.current = params;
    setPlacementDraft(params);
  };

  const onEditType = (profileId: string) => {
    const profile = profiles.find((item) => item.id === profileId);
    if (!profile) return;
    setProfileEditor({ profile, originalId: profile.id });
  };

  const onNewProfile = (category: string) => {
    const id = nextProfileId(profiles, category);
    setProfileEditor({ profile: defaultNewProfile(category, id), originalId: null });
  };

  const onSaveProfile = (profile: ProfileTypeDto) => {
    const next = apexRegisterProfile(profile);
    applyScene(next);
    syncCatalog();
    if (tool.componentId) {
      const host = components.find((item) => item.id === tool.componentId);
      if (host && host.category === profile.category) {
        const draft = {
          ...placementParamsRef.current,
          profile: profile.id,
        };
        placementParamsRef.current = draft;
        setPlacementDraft(draft);
      }
    }
    setProfileEditor(null);
    setError(null);
  };

  const onDelete = () => applyScene(apexDeleteSelected());

  const selectedIds = scene?.selected_ids ?? [];
  const tools = useMemo(() => registryRef.current.list(), [components]);
  const placementComponent = tool.componentId
    ? (components.find((item) => item.id === tool.componentId) ?? null)
    : null;

  const inspector = (
    <PropertiesPanel
      selected={selected}
      selectedCount={selectedIds.length}
      component={selectedComponent}
      profiles={profiles}
      selectedLevel={selectedIds.length === 0 && !placementComponent ? selectedLevel : null}
      placement={
        placementComponent
          ? { component: placementComponent, params: placementDraft }
          : null
      }
      onUpdate={onUpdateParams}
      onPlacementChange={onPlacementChange}
      onEditType={onEditType}
      onNewProfile={onNewProfile}
      onUpdateLevelElevation={onUpdateLevelElevation}
      onDelete={onDelete}
    />
  );

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">APEX</div>
        <div className="tools">
          {tools.map((t, i) => {
            const prev = tools[i - 1];
            const sep = prev && (prev.group ?? 'create') !== (t.group ?? 'create');
            return (
              <Fragment key={t.id}>
                {sep ? <span className="tools-sep" aria-hidden="true" /> : null}
                <button
                  type="button"
                  className={toolId === t.id ? 'active' : ''}
                  onClick={() => activateTool(t.id)}
                >
                  {t.label}
                </button>
              </Fragment>
            );
          })}
          {tool.modes && tool.modes.length > 0 ? (
            <>
              <span className="tools-sep" aria-hidden="true" />
              {tool.modes.map((mode) => (
                <button
                  key={mode.id}
                  type="button"
                  className={`mode${drawMode === mode.id ? ' active' : ''}`}
                  onClick={() => activateDrawMode(mode.id)}
                >
                  {mode.label}
                </button>
              ))}
            </>
          ) : null}
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
          {tool.hint(pending.length)}
          {activeLevel ? ` · ${activeLevel.name}` : ''}
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
            properties={inspector}
          />
        ) : null}
      </div>

      {!isMobile ? (
        <aside className="inspector">
          <div className="panel-title">Properties</div>
          {inspector}
        </aside>
      ) : null}

      {profileEditor ? (
        <ProfileEditor
          initial={profileEditor.profile}
          originalId={profileEditor.originalId}
          onSave={onSaveProfile}
          onClose={() => setProfileEditor(null)}
        />
      ) : null}
    </div>
  );
}
