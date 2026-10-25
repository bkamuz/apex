import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  apexAbortUndoGroup,
  apexBeginUndoGroup,
  apexClearDatumSelections,
  apexCopySelection,
  apexCreateElement,
  apexCreateElementWithParent,
  apexSetElementParent,
  apexCreateLevel,
  apexCreateConstructionLine,
  apexCreateGridAxis,
  apexCreateReference,
  apexCreateSectionCut,
  apexCreateSpace,
  apexDetectRoomsFromWalls,
  apexDeleteSelected,
  apexDeleteSelectedConstructionLine,
  apexDeleteSelectedGridAxis,
  apexDeleteSelectedReference,
  apexDeleteSelectedSectionCut,
  apexDeleteSelectedSpace,
  apexGetSelectedConstructionLine,
  apexGetSelectedGridAxis,
  apexGetSelectedReference,
  apexGetSelectedSectionCut,
  apexGetSelectedSpace,
  apexExportProject,
  apexGetScene,
  apexGetSelected,
  apexGetSelectedElements,
  apexListElements,
  apexImportProject,
  apexListComponents,
  apexListProfiles,
  apexNewProject,
  apexPickById,
  apexPreviewElement,
  apexRedo,
  apexRegisterComponent,
  apexRegisterProfile,
  apexSelectElement,
  apexSelectConstructionLine,
  apexSelectGridAxis,
  apexSelectReference,
  apexSelectSectionCut,
  apexSelectSpace,
  apexSetConstructionLinePlacement,
  apexSetGridAxisPlacement,
  apexSetReferencePlacement,
  apexSetSectionCutPlacement,
  apexSetSpacePlacement,
  apexUpdateConstructionLine,
  apexUpdateGridAxis,
  apexUpdateSectionCut,
  apexUpdateSpace,
  apexRenameSpace,
  apexSetActiveLevel,
  apexSetElementPlacement,
  apexSetLevelElevation,
  apexTogglePickById,
  apexToggleSelectElement,
  apexTranslateSelection,
  apexUndo,
  apexUpdateElement,
  apexCreatePlanView,
  apexCreateThreeDView,
  apexDuplicateView,
  apexRenameView,
  apexDeleteView,
  apexSaveViewState,
  apexCreateSheetWithLayout,
  apexUpdateSheetLayout,
  apexRenameSheet,
  apexDeleteSheet,
  apexPlaceViewOnSheet,
  apexMoveSheetViewport,
  apexCreateViewAnnotation,
  apexExportViewVector,
  apexExportViewDxf,
  apexSetSheetViewportCrop,
  apexResetSheetViewportCrop,
  apexSetSheetViewportScale,
  apexUpdateProfileType,
  initApex,
} from './wasm/apex';
import {
  GRID_STEP,
  orthoConstrain,
  snapPointToGrid,
  ViewportRenderer,
  type ProjectionMode,
  type ViewNavigationMode,
  type Vec3,
} from './viewport/ViewportRenderer';
import type {
  ComponentDto,
  ConstructionLineDto,
  ElementDto,
  ElementListDto,
  LevelDto,
  ParamValue,
  PlacementKind,
  ProfileTypeDto,
  GridAxisDto,
  ReferenceDto,
  ReferenceKind,
  SceneDto,
  SectionCutDto,
  SpaceDto,
} from './types';
import { GridAxisLabels } from './ui/GridAxisLabels';
import { LevelList } from './ui/LevelList';
import { MobileMenuSheet, type MobileMenuTab } from './ui/MobileMenuSheet';
import { ComponentEditor } from './ui/ComponentEditor';
import { ProfileEditor } from './ui/ProfileEditor';
import { defaultNewComponent, isUserAuthoredComponent, nextComponentId } from './ui/componentModel';
import { ProjectBrowser } from './ui/ProjectBrowser';
import { DocumentViewsHost } from './ui/DocumentViewsHost';
import { useDocumentTabs } from './hooks/useDocumentTabs';
import {
  applyViewToRenderer,
  buildViewKindFromRenderer,
  filterPickIdsForCategories,
  findView,
  hiddenCategoriesForView,
  projectionFromStored,
} from './ui/viewModel';
import { viewAnnotationSegments } from './ui/viewAnnotationSegments';
import { pickAnnotationAnchor } from './annotations/pickAnchor';
import { downloadBlob, downloadTextFile, drawingToPdf, drawingToSvg } from './ui/vectorExport';
import type { VectorDrawing2d } from './types';
import type { DocumentTab } from './ui/ViewTabBar';
import { PropertiesPanel } from './ui/PropertiesPanel';
import { ToolsToolbar } from './ui/ToolsToolbar';
import { GettingStartedPanel } from './ui/GettingStartedPanel';
import { buildSampleProject } from './ui/sampleProject';
import { defaultNewProfile, defaultPlacementParams, nextProfileId } from './ui/profileModel';
import { clearStoredProject, downloadText, loadStoredProject, storeProject } from './persist';
import { useMediaQuery } from './hooks/useMediaQuery';
import { ToolRegistry } from './tools/registry';
import { finishOpenGesture } from './tools/placementTool';
import { requiredPoints, type PointerInfo, type ToolContext } from './tools/Tool';
import { buildTranslatedGhostMesh } from './tools/transformGhost';
import { type TransformMode } from './tools/transformTypes';
import { extensions, installGlobalSdk } from './extensions/sdk';
import { exporterRegistry, installPlugins } from './plugins';

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
  const projectRestoreDoneRef = useRef(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const canvasSplitRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<ViewportRenderer | null>(null);
  const splitRendererRef = useRef<ViewportRenderer | null>(null);
  const registryRef = useRef<ToolRegistry>(makeToolRegistry());
  const shiftHeldRef = useRef(false);
  const selectedRef = useRef<ElementDto | null>(null);
  const selectedReferenceRef = useRef<ReferenceDto | null>(null);
  const selectedGridAxisRef = useRef<GridAxisDto | null>(null);
  const selectedConstructionLineRef = useRef<ConstructionLineDto | null>(null);
  const selectedSectionCutRef = useRef<SectionCutDto | null>(null);
  const selectedSpaceRef = useRef<SpaceDto | null>(null);
  const selectedCountRef = useRef(0);
  const activeElevationRef = useRef(0);
  const suppressClickRef = useRef(false);
  /** True only after App claims LMB capture for a tool gesture — not camera buttons. */
  const appPointerCaptureRef = useRef(false);
  const draggingRef = useRef(false);
  const placementParamsRef = useRef<Record<string, ParamValue>>({});

  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [showGettingStarted, setShowGettingStarted] = useState(() => {
    try {
      return localStorage.getItem('apex.gettingStarted.dismissed') !== '1';
    } catch {
      return true;
    }
  });
  const [components, setComponents] = useState<ComponentDto[]>([]);
  const [exporters, setExporters] = useState(() => exporterRegistry.list());
  const [profiles, setProfiles] = useState<ProfileTypeDto[]>([]);
  const [placementDraft, setPlacementDraft] = useState<Record<string, ParamValue>>({});
  const [profileEditor, setProfileEditor] = useState<{
    profile: ProfileTypeDto;
    originalId: string | null;
  } | null>(null);
  const [componentEditor, setComponentEditor] = useState<{
    component: ComponentDto;
    originalId: string | null;
  } | null>(null);
  const [toolId, setToolId] = useState<string>(ToolRegistry.selectId);
  const placementToolIdRef = useRef(toolId);
  const [drawMode, setDrawMode] = useState<string | null>(null);
  const [projection, setProjection] = useState<ProjectionMode>('orthographic');
  const [viewNavigation, setViewNavigation] = useState<ViewNavigationMode>('3d');
  const viewNavigationRef = useRef<ViewNavigationMode>('3d');
  viewNavigationRef.current = viewNavigation;
  const [scene, setScene] = useState<SceneDto | null>(null);
  const sceneRef = useRef<SceneDto | null>(null);
  const documentTabs = useDocumentTabs(scene);
  const {
    openTabs,
    activeTab,
    splitTab,
    splitEnabled,
    activeIsView,
    activeViewId,
    activeSheet,
    openTab,
    closeTab,
    setActiveTab,
    toggleSplit,
  } = documentTabs;
  const [selected, setSelected] = useState<ElementDto | null>(null);
  const [selectedReference, setSelectedReference] = useState<ReferenceDto | null>(null);
  const [selectedGridAxis, setSelectedGridAxis] = useState<GridAxisDto | null>(null);
  const [selectedConstructionLine, setSelectedConstructionLine] =
    useState<ConstructionLineDto | null>(null);
  const [selectedSectionCut, setSelectedSectionCut] = useState<SectionCutDto | null>(null);
  const [selectedSpace, setSelectedSpace] = useState<SpaceDto | null>(null);
  const [selectedLevelId, setSelectedLevelId] = useState<string | null>(null);
  const [pending, setPending] = useState<Vec3[]>([]);
  /** Digits typed mid-gesture: the next segment's length in metres. */
  const [typedLength, setTypedLength] = useState('');
  const typedLengthRef = useRef('');
  typedLengthRef.current = typedLength;
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);
  const pendingRef = useRef<Vec3[]>([]);
  pendingRef.current = pending;
  useEffect(() => {
    if (pending.length === 0) setTypedLength('');
  }, [pending.length]);
  const [fps, setFps] = useState(0);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [mobileMenuTab, setMobileMenuTab] = useState<MobileMenuTab>('levels');
  const isMobile = useMediaQuery('(max-width: 900px)');
  const fileRef = useRef<HTMLInputElement>(null);

  selectedRef.current = selected;
  selectedReferenceRef.current = selectedReference;
  selectedGridAxisRef.current = selectedGridAxis;
  selectedConstructionLineRef.current = selectedConstructionLine;
  selectedSectionCutRef.current = selectedSectionCut;
  selectedSpaceRef.current = selectedSpace;
  selectedCountRef.current = scene?.selected_ids?.length ?? 0;
  sceneRef.current = scene;
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
  rendererRef.current?.setPlanCutHeight(activeLevel?.elevation ?? 0);

  const selectedLevel = useMemo(() => {
    if (!selectedLevelId) return activeLevel;
    return levels.find((l) => l.id === selectedLevelId) ?? activeLevel;
  }, [selectedLevelId, levels, activeLevel]);

  const selectedComponent = useMemo(() => {
    if (!selected) return null;
    return components.find((c) => c.id === selected.component_id) ?? null;
  }, [selected, components]);

  const syncReferenceGizmos = useCallback((refs: ReferenceDto[]) => {
    const segments: Vec3[] = [];
    for (const reference of refs) {
      if (reference.gizmo_segments?.length) {
        segments.push(...reference.gizmo_segments);
      }
    }
    rendererRef.current?.setReferenceGizmos(segments.length >= 2 ? segments : null);
  }, []);

  const syncGridAxisGizmos = useCallback((axes: GridAxisDto[]) => {
    const lines: Vec3[] = [];
    const bubbles: Vec3[] = [];
    for (const axis of axes) {
      if (axis.line_segments?.length) lines.push(...axis.line_segments);
      if (axis.bubble_segments?.length) bubbles.push(...axis.bubble_segments);
    }
    rendererRef.current?.setGridAxisOverlays(
      lines.length >= 2 ? lines : null,
      bubbles.length >= 2 ? bubbles : null,
    );
  }, []);

  const syncConstructionLineOverlays = useCallback((items: ConstructionLineDto[]) => {
    const lines: Vec3[] = [];
    for (const item of items) {
      if (item.line_segments?.length) lines.push(...item.line_segments);
    }
    rendererRef.current?.setConstructionLineOverlays(lines.length >= 2 ? lines : null);
  }, []);

  const syncSectionCutOverlays = useCallback((items: SectionCutDto[]) => {
    const lines: Vec3[] = [];
    const fill: Vec3[] = [];
    for (const item of items) {
      if (item.line_segments?.length) lines.push(...item.line_segments);
      if (item.fill_segments?.length) fill.push(...item.fill_segments);
    }
    rendererRef.current?.setSectionCutOverlays(
      lines.length >= 2 ? lines : null,
      fill.length >= 2 ? fill : null,
    );
  }, []);

  const syncViewAnnotationOverlays = useCallback((next: SceneDto, viewId: string | null) => {
    const segs = viewId ? viewAnnotationSegments(next, viewId) : [];
    rendererRef.current?.setViewAnnotationOverlays(segs.length >= 2 ? segs : null);
  }, []);

  const syncSpaceOverlays = useCallback((items: SpaceDto[], activeLevelId?: string | null) => {
    const lines: Vec3[] = [];
    for (const item of items) {
      // Spaces are per-storey plan annotations: only the active level's show.
      if (activeLevelId && item.level_id !== activeLevelId) continue;
      if (item.line_segments?.length) lines.push(...item.line_segments);
    }
    rendererRef.current?.setSpaceOverlays(lines.length >= 2 ? lines : null);
  }, []);

  const syncEditGizmo = useCallback(
    (
      el: ElementDto | null,
      ref: ReferenceDto | null,
      axis: GridAxisDto | null,
      line: ConstructionLineDto | null = null,
      cut: SectionCutDto | null = null,
      space: SpaceDto | null = null,
    ) => {
      // A boolean has no geometry of its own to drag; its origin is noise.
      const anchors = el?.anchors?.length && el.component_id !== 'apex.boolean'
        ? el.anchors
        : ref?.anchors?.length
          ? ref.anchors
          : axis?.anchors?.length
            ? axis.anchors
            : line?.anchors?.length
              ? line.anchors
              : cut?.anchors?.length
                ? cut.anchors
                : space?.anchors?.length
                  ? space.anchors
                  : null;
      rendererRef.current?.setEditGizmo(anchors);
    },
    [],
  );

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
    setExporters(exporterRegistry.list());
  }, []);

  const sceneFitBounds = useCallback((next: SceneDto) => {
    if (next.fit_bounds_min && next.fit_bounds_max) {
      return { min: next.fit_bounds_min, max: next.fit_bounds_max };
    }
    return null;
  }, []);

  const slabPickIds = useCallback((next: SceneDto) => {
    return (next.elements ?? [])
      .filter((el) => el.category === 'slab' || el.component_id === 'apex.slab')
      .map((el) => el.pick_id);
  }, []);

  const syncSceneToRenderer = useCallback(
    (
      renderer: ViewportRenderer,
      next: SceneDto,
      fitCamera: boolean,
      viewId: string | null,
      syncGizmos: boolean,
    ) => {
      const view = findView(next, viewId);
      const hidden = hiddenCategoriesForView(view);
      renderer.setScene({
        positions: toFloatArray(next.positions),
        normals: toFloatArray(next.normals),
        indices: toUint32Array(next.indices),
        pickIds: filterPickIdsForCategories(next, hidden),
        edgePositions: next.edge_positions ? toFloatArray(next.edge_positions) : [],
        selectedPickIds: selectedPickIds(next),
        fitBounds: sceneFitBounds(next),
        slabPickIds: slabPickIds(next),
        fitCamera,
      });
      syncLevelPlanes(renderer, next);
      renderer.setPlanSymbols(next.plan_symbols?.length ? next.plan_symbols : null);
      if (syncGizmos) {
        syncReferenceGizmos(next.references ?? []);
        syncGridAxisGizmos(next.grid_axes ?? []);
        syncConstructionLineOverlays(next.construction_lines ?? []);
        syncSectionCutOverlays(next.section_cuts ?? []);
        syncSpaceOverlays(next.spaces ?? [], next.active_level_id);
        syncViewAnnotationOverlays(next, viewId);
      }
    },
    [
      sceneFitBounds,
      slabPickIds,
      syncConstructionLineOverlays,
      syncGridAxisGizmos,
      syncReferenceGizmos,
      syncSectionCutOverlays,
      syncSpaceOverlays,
      syncViewAnnotationOverlays,
    ],
  );

  const syncSheetViewportScene = useCallback(
    (renderer: ViewportRenderer, next: SceneDto, viewId: string) => {
      const view = findView(next, viewId);
      const hidden = hiddenCategoriesForView(view);
      renderer.setSheetPresentation(true);
      renderer.setLevelPlanes([]);
      renderer.setScene({
        positions: toFloatArray(next.positions),
        normals: toFloatArray(next.normals),
        indices: toUint32Array(next.indices),
        pickIds: filterPickIdsForCategories(next, hidden),
        edgePositions: next.edge_positions ? toFloatArray(next.edge_positions) : [],
        selectedPickIds: [],
        slabPickIds: slabPickIds(next),
        fitCamera: false,
      });
      renderer.setPlanSymbols(next.plan_symbols?.length ? next.plan_symbols : null);
      const segs = viewId ? viewAnnotationSegments(next, viewId) : [];
      renderer.setViewAnnotationOverlays(segs.length >= 2 ? segs : null);
    },
    [slabPickIds],
  );

  const applyScene = useCallback(
    (next: SceneDto, fitCamera = false) => {
      setScene(next);
      if (next.room_detect_report) {
        const { created, loops_found } = next.room_detect_report;
        if (created > 0) {
          setInfo(`Detect rooms: ${created} room${created === 1 ? '' : 's'} found on the active level.`);
        } else if (loops_found === 0) {
          setInfo(
            'Detect rooms: 0 rooms — add closed wall loops with joined endpoints on this level.',
          );
        } else {
          setInfo(
            `Detect rooms: 0 new rooms (${loops_found} loop${loops_found === 1 ? '' : 's'} found; walls may already have spaces).`,
          );
        }
      }
      const renderer = rendererRef.current;
      if (renderer) {
        syncSceneToRenderer(renderer, next, fitCamera, activeViewId, true);
      }
      const splitRenderer = splitRendererRef.current;
      if (splitRenderer && splitTab?.kind === 'view') {
        syncSceneToRenderer(splitRenderer, next, false, splitTab.id, false);
      }
      setComponents(apexListComponents());
      const sel = apexGetSelected();
      const selRef = apexGetSelectedReference();
      const selAxis = apexGetSelectedGridAxis();
      const selLine = apexGetSelectedConstructionLine();
      const selCut = apexGetSelectedSectionCut();
      const selSpace = apexGetSelectedSpace();
      setSelected(sel);
      setSelectedReference(selRef);
      setSelectedGridAxis(selAxis);
      setSelectedConstructionLine(selLine);
      setSelectedSectionCut(selCut);
      setSelectedSpace(selSpace);
      if (sel) setSelectedLevelId(sel.level_id);
      else if (selRef) setSelectedLevelId(selRef.level_id);
      else if (selAxis) setSelectedLevelId(selAxis.level_id);
      else if (selLine) setSelectedLevelId(selLine.level_id);
      else if (selCut) setSelectedLevelId(selCut.level_id);
      else if (selSpace) setSelectedLevelId(selSpace.level_id);
      if (!draggingRef.current) syncEditGizmo(sel, selRef, selAxis, selLine, selCut, selSpace);
    },
    [activeViewId, splitTab, syncEditGizmo, syncSceneToRenderer],
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

      createElementWithParent: (componentId, points, parentId, placementKind) => {
        try {
          applyScene(
            apexCreateElementWithParent(
              componentId,
              points,
              parentId,
              placementParamsRef.current,
              0,
              placementKind,
            ),
          );
          setError(null);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      },

      hostCandidates: () => {
        const active = sceneRef.current?.active_level_id ?? null;
        return apexListElements()
          .filter((element) => !active || element.effective_level_id === active)
          .map((element) => ({
            id: element.id,
            category: element.category,
            anchors: element.anchors,
          }));
      },

      worldToClient: (point) => renderer.worldToClient(point),

      elementCategory: (id) => {
        const element = sceneRef.current?.elements.find((item) => item.id === id);
        return element?.category ?? null;
      },

      createReference: (kind: ReferenceKind, points) => {
        try {
          applyScene(apexCreateReference(kind, points));
          setError(null);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      },

      createGridAxis: (points) => {
        try {
          applyScene(apexCreateGridAxis(points));
          setError(null);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      },

      createConstructionLine: (points) => {
        try {
          applyScene(apexCreateConstructionLine(points));
          setError(null);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      },

      createSectionCut: (points) => {
        try {
          applyScene(apexCreateSectionCut(points));
          setError(null);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      },

      createSpace: (points) => {
        try {
          applyScene(apexCreateSpace(points));
          setError(null);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      },

      detectRoomsFromWalls: () => {
        try {
          applyScene(apexDetectRoomsFromWalls());
          setError(null);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      },

      createLevel: () => {
        const currentLevels = sceneRef.current?.levels ?? [];
        const maxElev = currentLevels.reduce(
          (m, l) => Math.max(m, l.elevation),
          Number.NEGATIVE_INFINITY,
        );
        const elevation = currentLevels.length === 0 ? 0 : maxElev + DEFAULT_LEVEL_RISE;
        try {
          const next = apexCreateLevel('', elevation);
          applyScene(next);
          const createdId =
            next.levels.find((l) => !currentLevels.some((prev) => prev.id === l.id))?.id ??
            next.levels[next.levels.length - 1]?.id ??
            null;
          setSelectedLevelId(createdId);
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

      selectAt: (clientX, clientY, multi) => {
        const current = sceneRef.current;
        const candidates: { kind: string; id: string; distance: number }[] = [];
        const gridHit = renderer.hitGridAxis(clientX, clientY, current?.grid_axes ?? []);
        if (gridHit) candidates.push({ kind: 'grid_axis', id: gridHit.id, distance: gridHit.distance });
        const refHit = renderer.hitReference(clientX, clientY, current?.references ?? []);
        if (refHit) candidates.push({ kind: 'reference', id: refHit.id, distance: refHit.distance });
        const lineHit = renderer.hitPlanSegment(clientX, clientY, current?.construction_lines ?? []);
        if (lineHit)
          candidates.push({
            kind: 'construction_line',
            id: lineHit.id,
            distance: lineHit.distance,
          });
        const cutHit = renderer.hitPlanSegment(
          clientX,
          clientY,
          (current?.section_cuts ?? []).map((cut) => ({
            id: cut.id,
            line_segments: cut.line_segments,
            anchors: cut.anchors,
            extra_segments: cut.fill_segments,
          })),
        );
        if (cutHit)
          candidates.push({ kind: 'section_cut', id: cutHit.id, distance: cutHit.distance });
        const spaceHit = renderer.hitPlanSegment(clientX, clientY, current?.spaces ?? []);
        if (spaceHit)
          candidates.push({ kind: 'space', id: spaceHit.id, distance: spaceHit.distance });
        candidates.sort((a, b) => a.distance - b.distance);
        const overlayHit = candidates[0] ?? null;

        if (overlayHit) {
          switch (overlayHit.kind) {
            case 'grid_axis':
              applyScene(apexSelectGridAxis(overlayHit.id));
              break;
            case 'reference':
              applyScene(apexSelectReference(overlayHit.id));
              break;
            case 'construction_line':
              applyScene(apexSelectConstructionLine(overlayHit.id));
              break;
            case 'section_cut':
              applyScene(apexSelectSectionCut(overlayHit.id));
              break;
            case 'space':
              applyScene(apexSelectSpace(overlayHit.id));
              break;
            default:
              break;
          }
          return;
        }

        const pickId = renderer.pick(clientX, clientY);
        // Plan: a click inside a room (on its floor slab or on nothing) selects
        // the room, so it can be renamed without hunting for its boundary.
        if (!multi && renderer.isPlanNavigation() && (pickId == null || renderer.isSlabPick(pickId))) {
          const elevation = activeElevationRef.current;
          const ground = renderer.screenToGround(clientX, clientY, elevation);
          const room = ground
            ? (current?.spaces ?? []).find(
                (space) =>
                  space.anchors.length >= 3 &&
                  Math.abs(space.anchors[0][1] - elevation) < 0.05 &&
                  pointInPlanPolygon(ground, space.anchors),
              )
            : undefined;
          if (room) {
            applyScene(apexSelectSpace(room.id));
            return;
          }
        }
        if (pickId != null) {
          applyScene(multi ? apexTogglePickById(pickId) : apexPickById(pickId));
          return;
        }

        if (!multi) {
          applyScene(apexSelectElement(null));
          applyScene(apexSelectReference(null));
          applyScene(apexSelectGridAxis(null));
          applyScene(apexSelectConstructionLine(null));
          applyScene(apexSelectSectionCut(null));
          applyScene(apexSelectSpace(null));
        }
      },

      hitEditHandle: (x, y) => renderer.hitEditHandle(x, y),
      selectedAnchors: () => {
        if (selectedGridAxisRef.current) return selectedGridAxisRef.current.anchors;
        if (selectedConstructionLineRef.current)
          return selectedConstructionLineRef.current.anchors;
        if (selectedSectionCutRef.current) return selectedSectionCutRef.current.anchors;
        if (selectedSpaceRef.current) return selectedSpaceRef.current.anchors;
        if (selectedReferenceRef.current) return selectedReferenceRef.current.anchors;
        return selectedCountRef.current === 1 ? (selectedRef.current?.anchors ?? null) : null;
      },

      previewAnchors: (anchors) => {
        draggingRef.current = true;
        renderer.setEditGizmo(anchors);
        const applyLive = (
          next: SceneDto,
          sync: (scene: SceneDto) => void,
        ) => {
          renderer.setScene({
            positions: toFloatArray(next.positions),
            normals: toFloatArray(next.normals),
            indices: toUint32Array(next.indices),
            pickIds: next.pick_ids,
            edgePositions: next.edge_positions ? toFloatArray(next.edge_positions) : [],
            selectedPickIds: selectedPickIds(next),
            fitCamera: false,
          });
          sync(next);
          setScene(next);
        };
        const axisSel = selectedGridAxisRef.current;
        if (axisSel) {
          try {
            applyLive(apexSetGridAxisPlacement(axisSel.id, anchors, 0, false), (next) =>
              syncGridAxisGizmos(next.grid_axes ?? []),
            );
          } catch {
            /* keep dragging */
          }
          return;
        }
        const lineSel = selectedConstructionLineRef.current;
        if (lineSel) {
          try {
            applyLive(apexSetConstructionLinePlacement(lineSel.id, anchors, 0, false), (next) =>
              syncConstructionLineOverlays(next.construction_lines ?? []),
            );
          } catch {
            /* keep dragging */
          }
          return;
        }
        const cutSel = selectedSectionCutRef.current;
        if (cutSel) {
          try {
            applyLive(apexSetSectionCutPlacement(cutSel.id, anchors, 0, false), (next) =>
              syncSectionCutOverlays(next.section_cuts ?? []),
            );
          } catch {
            /* keep dragging */
          }
          return;
        }
        const spaceSel = selectedSpaceRef.current;
        if (spaceSel) {
          try {
            applyLive(apexSetSpacePlacement(spaceSel.id, anchors, 0, false), (next) =>
              syncSpaceOverlays(next.spaces ?? [], next.active_level_id),
            );
          } catch {
            /* keep dragging */
          }
          return;
        }
        const refSel = selectedReferenceRef.current;
        if (refSel) {
          try {
            applyLive(apexSetReferencePlacement(refSel.id, anchors, 0, false), (next) =>
              syncReferenceGizmos(next.references ?? []),
            );
          } catch {
            /* keep dragging */
          }
          return;
        }
        const sel = selectedRef.current;
        if (!sel) return;
        try {
          applyLive(apexSetElementPlacement(sel.id, anchors, 0, false), () => undefined);
        } catch {
          /* keep dragging */
        }
      },

      commitAnchors: (anchors) => {
        draggingRef.current = false;
        const axisSel = selectedGridAxisRef.current;
        if (axisSel) {
          try {
            applyScene(apexSetGridAxisPlacement(axisSel.id, anchors, 0, true));
            setError(null);
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            syncEditGizmo(null, null, axisSel);
          }
          return;
        }
        const lineSel = selectedConstructionLineRef.current;
        if (lineSel) {
          try {
            applyScene(apexSetConstructionLinePlacement(lineSel.id, anchors, 0, true));
            setError(null);
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            syncEditGizmo(null, null, null, lineSel);
          }
          return;
        }
        const cutSel = selectedSectionCutRef.current;
        if (cutSel) {
          try {
            applyScene(apexSetSectionCutPlacement(cutSel.id, anchors, 0, true));
            setError(null);
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            syncEditGizmo(null, null, null, null, cutSel);
          }
          return;
        }
        const spaceSel = selectedSpaceRef.current;
        if (spaceSel) {
          try {
            applyScene(apexSetSpacePlacement(spaceSel.id, anchors, 0, true));
            setError(null);
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            syncEditGizmo(null, null, null, null, null, spaceSel);
          }
          return;
        }
        const refSel = selectedReferenceRef.current;
        if (refSel) {
          try {
            applyScene(apexSetReferencePlacement(refSel.id, anchors, 0, true));
            setError(null);
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            syncEditGizmo(null, refSel, null);
          }
          return;
        }
        const sel = selectedRef.current;
        if (!sel) return;
        try {
          applyScene(apexSetElementPlacement(sel.id, anchors, 0, true));
          setError(null);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
          syncEditGizmo(sel, null, null);
        }
      },

      beginUndoGroup: () => {
        try {
          apexBeginUndoGroup();
        } catch {
          /* ignore */
        }
      },

      abortUndoGroup: () => {
        try {
          apexAbortUndoGroup();
        } catch {
          /* ignore */
        }
      },

      getTransformSelection: () => {
        const axisSel = selectedGridAxisRef.current;
        if (axisSel) {
          return [
            {
              kind: 'grid_axis' as const,
              id: axisSel.id,
              anchors: axisSel.anchors.map((p) => [...p] as Vec3),
            },
          ];
        }
        const lineSel = selectedConstructionLineRef.current;
        if (lineSel) {
          return [
            {
              kind: 'construction_line' as const,
              id: lineSel.id,
              anchors: lineSel.anchors.map((p) => [...p] as Vec3),
            },
          ];
        }
        const cutSel = selectedSectionCutRef.current;
        if (cutSel) {
          return [
            {
              kind: 'section_cut' as const,
              id: cutSel.id,
              anchors: cutSel.anchors.map((p) => [...p] as Vec3),
            },
          ];
        }
        const spaceSel = selectedSpaceRef.current;
        if (spaceSel) {
          return [
            {
              kind: 'space' as const,
              id: spaceSel.id,
              anchors: spaceSel.anchors.map((p) => [...p] as Vec3),
            },
          ];
        }
        const refSel = selectedReferenceRef.current;
        if (refSel) {
          return [
            {
              kind: 'reference' as const,
              id: refSel.id,
              anchors: refSel.anchors.map((p) => [...p] as Vec3),
            },
          ];
        }
        const elements = apexGetSelectedElements();
        if (elements.length === 0) return null;
        return elements.map((element) => ({
          kind: 'element' as const,
          id: element.id,
          anchors: element.anchors.map((p) => [...p] as Vec3),
        }));
      },

      previewTransform: (originals, delta) => {
        // Ghost-only: never mutate placements while the pointer moves.
        const current = sceneRef.current;
        if (!current) {
          renderer.setGhostMesh(null);
          return;
        }
        const ghost = buildTranslatedGhostMesh(current, originals, delta);
        renderer.setGhostMesh(ghost);
      },

      commitTransform: (_originals, delta, mode: TransformMode) => {
        try {
          renderer.setGhostMesh(null);
          const next =
            mode === 'move' ? apexTranslateSelection(delta, true) : apexCopySelection(delta);
          applyScene(next);
          setError(null);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      },

      restoreTransformOriginals: () => {
        // Preview never mutated the document — just drop the ghost overlay.
        renderer.setGhostMesh(null);
      },

      // Parenting gestures need element identity, not just a GPU pick id.
      pickElementId: (clientX, clientY) => {
        const pickId = renderer.pick(clientX, clientY);
        if (pickId == null) return null;
        const current = sceneRef.current;
        const entry = current?.elements.find((candidate) => candidate.pick_id === pickId);
        return entry?.id ?? null;
      },

      selectedElementIds: () => apexGetSelectedElements().map((element) => element.id),

      elementParentId: (id) =>
        apexListElements().find((element) => element.id === id)?.parent_id ?? null,

      anchorOf: (id) => {
        const element = apexListElements().find((candidate) => candidate.id === id);
        const origin = element?.anchors[0];
        return (origin ? [...origin] : [0, 0, 0]) as Vec3;
      },

      applyScene: (scene) => {
        applyScene(scene as SceneDto);
      },

      activeViewId: () => activeViewId,

      createViewAnnotation: (viewId, kind) => {
        try {
          applyScene(apexCreateViewAnnotation(viewId, kind));
          setError(null);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      },

      pickAnnotationAnchor: (clientX, clientY, worldFallback) => {
        const sc = sceneRef.current;
        if (!sc) return null;
        return pickAnnotationAnchor(
          renderer,
          sc,
          apexListElements(),
          clientX,
          clientY,
          worldFallback,
        );
      },

      setError,
      setPending,
      setTouchOrbitEnabled: (enabled) => renderer.setTouchOrbitEnabled(enabled),
    };
  }, [
    applyScene,
    resolvePoint,
    syncConstructionLineOverlays,
    syncEditGizmo,
    syncGridAxisGizmos,
    syncReferenceGizmos,
    syncSectionCutOverlays,
    syncSpaceOverlays,
    activeViewId,
  ]);

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
      if (next?.group === 'create') {
        try {
          applyScene(apexClearDatumSelections());
        } catch {
          /* selection sync falls back on next scene apply */
        }
      }
      setDrawMode(next?.getMode?.() ?? null);
      if (id === ToolRegistry.selectId) {
        syncEditGizmo(
          selectedRef.current,
          selectedReferenceRef.current,
          selectedGridAxisRef.current,
          selectedConstructionLineRef.current,
          selectedSectionCutRef.current,
          selectedSpaceRef.current,
        );
      }
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
    [applyScene, cancelGesture, components, profiles, syncEditGizmo],
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

  const onUndo = useCallback(() => {
    try {
      applyScene(apexUndo());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [applyScene]);

  const onRedo = useCallback(() => {
    try {
      applyScene(apexRedo());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [applyScene]);

  /** Escape: clear an in-progress create pick chain; otherwise fall back to Select. */
  const onEscape = useCallback(() => {
    if (toolRef.current.group === 'create' && pendingRef.current.length > 0) {
      cancelGesture();
      return;
    }
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
      applyScene(apexClearDatumSelections());
      applyScene(apexSelectElement(null));
    } catch {
      rendererRef.current?.setEditGizmo(null);
      setSelected(null);
      setSelectedReference(null);
      setSelectedGridAxis(null);
      setSelectedConstructionLine(null);
      setSelectedSectionCut(null);
      setSelectedSpace(null);
    }
  }, [applyScene, cancelGesture]);

  const setProjectionMode = useCallback((mode: ProjectionMode) => {
    setProjection(mode);
    rendererRef.current?.setProjection(mode);
  }, []);

  const setViewNavigationMode = useCallback((mode: ViewNavigationMode) => {
    setViewNavigation(mode);
    const renderer = rendererRef.current;
    if (!renderer) return;
    renderer.setPlanCutHeight(activeElevationRef.current);
    renderer.setViewNavigation(mode);
    if (mode === 'plan') {
      setProjection('orthographic');
      renderer.fitViewExtents();
    } else {
      setProjection(renderer.getProjection());
    }
  }, []);

  const fitView = useCallback(() => {
    rendererRef.current?.fitViewExtents();
  }, []);

  const onSelectDocumentTab = useCallback(
    (tab: DocumentTab) => {
      setActiveTab(tab);
      openTab(tab);
    },
    [openTab, setActiveTab],
  );

  const runViewAction = useCallback(
    (fn: () => SceneDto) => {
      try {
        applyScene(fn());
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [applyScene],
  );

  const onSaveActiveView = useCallback(() => {
    if (!activeViewId || !scene) return;
    const view = findView(scene, activeViewId);
    const renderer = rendererRef.current;
    if (!view || !renderer) return;
    const kind = buildViewKindFromRenderer(view, renderer, viewNavigationRef.current);
    runViewAction(() => apexSaveViewState(activeViewId, kind));
  }, [activeViewId, runViewAction, scene]);

  const loadActiveViewDrawing = useCallback((): VectorDrawing2d | null => {
    if (!activeViewId) return null;
    try {
      return JSON.parse(apexExportViewVector(activeViewId)) as VectorDrawing2d;
    } catch {
      return null;
    }
  }, [activeViewId]);

  const onExportActiveViewSvg = useCallback(() => {
    const drawing = loadActiveViewDrawing();
    if (!drawing) return;
    const view = scene ? findView(scene, activeViewId ?? '') : undefined;
    const name = view?.name ?? 'view';
    downloadTextFile(`${name.replace(/\s+/g, '_')}.svg`, drawingToSvg(drawing), 'image/svg+xml');
  }, [activeViewId, loadActiveViewDrawing, scene]);

  const onExportActiveViewDxf = useCallback(() => {
    if (!activeViewId) return;
    try {
      const dxf = apexExportViewDxf(activeViewId);
      const view = scene ? findView(scene, activeViewId) : undefined;
      const name = view?.name ?? 'view';
      downloadTextFile(`${name.replace(/\s+/g, '_')}.dxf`, dxf, 'application/dxf');
    } catch {
      /* ignore */
    }
  }, [activeViewId, scene]);

  const onExportActiveViewPdf = useCallback(() => {
    const drawing = loadActiveViewDrawing();
    if (!drawing) return;
    const view = scene ? findView(scene, activeViewId ?? '') : undefined;
    const name = view?.name ?? 'view';
    const pdf = drawingToPdf(drawing, { title: name });
    downloadBlob(`${name.replace(/\s+/g, '_')}.pdf`, new Blob([pdf as BlobPart], { type: 'application/pdf' }));
  }, [activeViewId, loadActiveViewDrawing, scene]);

  const onSheetViewportCropChange = useCallback(
    (viewportId: string, crop: import('./types').CropUvDto[]) => {
      if (!activeSheet) return;
      runViewAction(() =>
        apexSetSheetViewportCrop(activeSheet.id, viewportId, JSON.stringify(crop)),
      );
    },
    [activeSheet, runViewAction],
  );

  const onResetSheetViewportCrop = useCallback(
    (viewportId: string) => {
      if (!activeSheet) return;
      runViewAction(() => apexResetSheetViewportCrop(activeSheet.id, viewportId));
    },
    [activeSheet, runViewAction],
  );

  const activeViewIsPlan = useMemo(() => {
    if (!activeViewId || !scene) return false;
    return findView(scene, activeViewId)?.kind.kind === 'plan';
  }, [activeViewId, scene]);

  const onPlaceViewOnSheet = useCallback(
    (viewId: string, centerXmm: number, centerYmm: number) => {
      if (!activeSheet) return;
      runViewAction(() =>
        apexPlaceViewOnSheet(activeSheet.id, viewId, centerXmm, centerYmm, 120, 90),
      );
    },
    [activeSheet, runViewAction],
  );

  const onMoveSheetViewport = useCallback(
    (viewportId: string, centerXmm: number, centerYmm: number) => {
      if (!activeSheet) return;
      runViewAction(() => apexMoveSheetViewport(activeSheet.id, viewportId, centerXmm, centerYmm));
    },
    [activeSheet, runViewAction],
  );

  const onUpdateSheetLayout = useCallback(
    (
      paper: import('./types').PaperSize,
      orientation: import('./types').PaperOrientation,
      customWidthMm: number,
      customHeightMm: number,
    ) => {
      if (!activeSheet) return;
      const paperWasm = paper === 'custom' ? 'CUSTOM' : paper.toUpperCase();
      runViewAction(() =>
        apexUpdateSheetLayout(
          activeSheet.id,
          paperWasm,
          orientation,
          customWidthMm,
          customHeightMm,
        ),
      );
    },
    [activeSheet, runViewAction],
  );

  const onSetSheetViewportScale = useCallback(
    (viewportId: string, scale: number) => {
      if (!activeSheet) return;
      runViewAction(() =>
        apexSetSheetViewportScale(activeSheet.id, viewportId, scale),
      );
    },
    [activeSheet, runViewAction],
  );

  // Apply a view's camera/level once when its tab opens. Re-running on every
  // active-level change would snap the level back to the view's and undo the
  // user's pick in the level list.
  const appliedViewRef = useRef<string | null>(null);
  useEffect(() => {
    if (!ready || activeTab?.kind !== 'view' || !activeViewId || !scene) {
      if (activeTab?.kind !== 'view') appliedViewRef.current = null;
      return;
    }
    if (appliedViewRef.current === activeViewId) return;
    const view = findView(scene, activeViewId);
    const renderer = rendererRef.current;
    if (!view || !renderer) return;
    appliedViewRef.current = activeViewId;
    applyViewToRenderer(view, renderer);
    if (view.kind.kind === 'plan') {
      viewNavigationRef.current = 'plan';
      setViewNavigation('plan');
      setProjection('orthographic');
      renderer.setViewNavigation('plan');
      if (view.kind.level_id && view.kind.level_id !== scene.active_level_id) {
        try {
          applyScene(apexSetActiveLevel(view.kind.level_id));
        } catch {
          /* ignore */
        }
      }
    } else if (view.kind.kind === 'three_d') {
      viewNavigationRef.current = '3d';
      setViewNavigation('3d');
      const mode = projectionFromStored(view.kind.projection);
      setProjection(mode);
      renderer.setViewNavigation('3d');
      renderer.setProjection(mode);
    }
  }, [activeTab?.kind, activeViewId, applyScene, ready, scene]);

  useEffect(() => {
    if (!splitEnabled) {
      splitRendererRef.current?.dispose();
      splitRendererRef.current = null;
      return;
    }
    const canvas = canvasSplitRef.current;
    if (!canvas) return;
    if (!splitRendererRef.current) {
      splitRendererRef.current = new ViewportRenderer(canvas);
    }
    if (scene && splitTab?.kind === 'view') {
      syncSceneToRenderer(splitRendererRef.current, scene, false, splitTab.id, false);
      const view = findView(scene, splitTab.id);
      if (view) applyViewToRenderer(view, splitRendererRef.current);
    }
  }, [scene, splitEnabled, splitTab, syncSceneToRenderer]);

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
      // A focused dropdown or checkbox (e.g. after editing a property) must not
      // swallow Delete; only real text entry keeps the key for itself.
      const textEntry =
        active instanceof HTMLTextAreaElement ||
        (active instanceof HTMLInputElement &&
          !['checkbox', 'radio', 'button', 'range', 'color'].includes(active.type));
      const deleteKey = e.key === 'Delete' || (e.key === 'Backspace' && !typing);
      if (!textEntry && deleteKey) {
        if (active instanceof HTMLElement && active !== document.body) active.blur();
        if (selectedGridAxisRef.current) {
          e.preventDefault();
          try {
            applyScene(apexDeleteSelectedGridAxis());
          } catch {
            /* ignore */
          }
          return;
        }
        if (selectedConstructionLineRef.current) {
          e.preventDefault();
          try {
            applyScene(apexDeleteSelectedConstructionLine());
          } catch {
            /* ignore */
          }
          return;
        }
        if (selectedSectionCutRef.current) {
          e.preventDefault();
          try {
            applyScene(apexDeleteSelectedSectionCut());
          } catch {
            /* ignore */
          }
          return;
        }
        if (selectedSpaceRef.current) {
          e.preventDefault();
          try {
            applyScene(apexDeleteSelectedSpace());
          } catch {
            /* ignore */
          }
          return;
        }
        if (selectedReferenceRef.current) {
          e.preventDefault();
          try {
            applyScene(apexDeleteSelectedReference());
          } catch {
            /* ignore */
          }
          return;
        }
        if (selectedCountRef.current > 0) {
          e.preventDefault();
          try {
            applyScene(apexDeleteSelected());
          } catch {
            /* ignore */
          }
          return;
        }
      }
      const mod = e.ctrlKey || e.metaKey;
      // Typed length: with a gesture in progress, digits set the next
      // segment's length along the cursor direction; Enter commits it.
      const gesture = pendingRef.current ?? [];
      if (!typing && !mod && gesture.length > 0 && toolRef.current.group === 'create') {
        const buffer = typedLengthRef.current;
        if (/^[0-9.,]$/.test(e.key)) {
          e.preventDefault();
          setTypedLength(buffer + (e.key === ',' ? '.' : e.key));
          return;
        }
        if (buffer && e.key === 'Backspace') {
          e.preventDefault();
          setTypedLength(buffer.slice(0, -1));
          return;
        }
        if (buffer && (e.key === 'Enter' || e.code === 'Enter')) {
          e.preventDefault();
          setTypedLength('');
          const length = Number.parseFloat(buffer);
          const anchor = gesture[gesture.length - 1]!;
          const last = lastPointerRef.current;
          const ctx = toolContext();
          const cursor = last ? ctx.resolvePoint(last.x, last.y, false, anchor) : null;
          let dx = cursor ? cursor[0] - anchor[0] : 1;
          let dz = cursor ? cursor[2] - anchor[2] : 0;
          if (shiftHeldRef.current) {
            if (Math.abs(dx) >= Math.abs(dz)) dz = 0;
            else dx = 0;
          }
          const norm = Math.hypot(dx, dz);
          if (!(length > 0) || norm < 1e-6) return;
          const target: Vec3 = [
            anchor[0] + (dx / norm) * length,
            anchor[1],
            anchor[2] + (dz / norm) * length,
          ];
          const client = ctx.worldToClient(target);
          if (!client) return;
          const info = { clientX: client[0], clientY: client[1], shift: false, multi: false };
          const active = toolRef.current;
          // Gesture tools claim pointerdown; placement tools commit on click.
          if (active.onPointerDown?.(info, ctx)) active.onPointerUp?.(info, ctx);
          else active.onClick?.(info, ctx);
          return;
        }
      }
      if (!typing && mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) onRedo();
        else onUndo();
        return;
      }
      if (!typing && mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        onRedo();
        return;
      }
      if (!typing && !mod && e.key.toLowerCase() === 'm') {
        e.preventDefault();
        activateTool('apex.move');
        return;
      }
      if (!typing && !mod && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        activateTool('apex.copy');
        return;
      }
      if (!typing && !mod && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        setViewNavigationMode(viewNavigationRef.current === 'plan' ? '3d' : 'plan');
        return;
      }
      if (!typing && !mod && e.key === '3') {
        e.preventDefault();
        setViewNavigationMode('3d');
        return;
      }
      if (!typing && !mod && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        fitView();
        return;
      }
      if (!typing && !mod && (e.key === 'Enter' || e.code === 'Enter')) {
        const activeTool = toolRef.current;
        if (activeTool.finishGesture) {
          e.preventDefault();
          const ctx = toolContext();
          if (activeTool.finishGesture(pendingRef.current ?? [], ctx)) {
            setPending([]);
          }
          return;
        }
      }
      if (!typing && !mod && (e.key === 'PageUp' || e.key === 'PageDown')) {
        const activeTool = toolRef.current;
        if (activeTool.nudgeElevation) {
          e.preventDefault();
          activeTool.nudgeElevation(e.key === 'PageUp' ? 0.5 : -0.5);
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
  }, [
    activateTool,
    applyScene,
    fitView,
    onEscape,
    onRedo,
    onUndo,
    profileEditor,
    setViewNavigationMode,
    toolContext,
  ]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await initApex();
        if (cancelled) return;
        const canvas = canvasRef.current;
        if (!canvas) return;
        rendererRef.current = new ViewportRenderer(canvas);
        // Test hook: world -> client mapping so UI scripts can click real points.
        (window as unknown as { __apexTest?: unknown }).__apexTest = {
          worldToClient: (p: Vec3) => rendererRef.current?.worldToClient(p) ?? null,
          getCamera: () => rendererRef.current?.getCamera() ?? null,
          setCamera: (c: Parameters<ViewportRenderer['setCamera']>[0]) => rendererRef.current?.setCamera(c),
        };

        const stored = loadStoredProject();
        if (stored) {
          try {
            apexImportProject(stored);
          } catch (restoreError) {
            console.warn('could not restore saved project', restoreError);
          }
        }

        // The toolbar is generated from whatever the core has installed.
        syncCatalog();
        installGlobalSdk();

        let initial = apexGetScene();
        if (
          stored?.includes('"sheets":[{') &&
          (initial.sheets?.length ?? 0) === 0
        ) {
          try {
            apexImportProject(stored);
            initial = apexGetScene();
          } catch {
            /* ignore */
          }
        }
        if (!cancelled) {
          applyScene(initial, false);
          setSelectedLevelId(initial.active_level_id);
          projectRestoreDoneRef.current = true;
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

  const persistSceneKey = scene
    ? [
        scene.version,
        scene.views?.length ?? 0,
        scene.sheets?.length ?? 0,
        scene.view_annotations?.length ?? 0,
      ].join(':')
    : '';

  useEffect(() => {
    if (!ready || !scene || !projectRestoreDoneRef.current) return;
    try {
      storeProject(apexExportProject());
    } catch {
      /* ignore */
    }
  }, [ready, persistSceneKey, scene]);

  useEffect(() => {
    if (!ready) return;
    const id = window.setInterval(() => setFps(rendererRef.current?.getFps() ?? 0), 500);
    return () => window.clearInterval(id);
  }, [ready]);

  useEffect(() => {
    if (!isMobile) setMobileMenuOpen(false);
  }, [isMobile]);

  // A module can install a component at any time; the toolbar follows.
  useEffect(() => {
    if (!ready) return;
    return extensions.subscribe(() => {
      syncCatalog();
      applyScene(apexGetScene());
    });
  }, [ready, syncCatalog, applyScene]);

  const elements: ElementListDto[] = useMemo(() => scene?.elements ?? [], [scene]);
  /** Space labels follow the outlines: only the active storey's spaces. */
  const activeLevelSpaces = useMemo(
    () =>
      (scene?.spaces ?? []).filter(
        (s) => !scene?.active_level_id || s.level_id === scene.active_level_id,
      ),
    [scene],
  );

  const browserViewsProps = {
    views: scene?.views ?? [],
    sheets: scene?.sheets ?? [],
    activeLevelId: scene?.active_level_id ?? null,
    openViewId: activeTab?.kind === 'view' ? activeTab.id : null,
    openSheetId: activeTab?.kind === 'sheet' ? activeTab.id : null,
    onOpenView: (id: string) => onSelectDocumentTab({ kind: 'view', id }),
    onOpenSheet: (id: string) => onSelectDocumentTab({ kind: 'sheet', id }),
    onNewPlanView: (levelId: string) => runViewAction(() => apexCreatePlanView(levelId)),
    onNewThreeDView: () => runViewAction(() => apexCreateThreeDView()),
    onDuplicateView: (id: string) => runViewAction(() => apexDuplicateView(id)),
    onRenameView: (id: string, name: string) => runViewAction(() => apexRenameView(id, name)),
    onDeleteView: (id: string) => runViewAction(() => apexDeleteView(id)),
    onCreateSheetWithLayout: (
      paper: import('./types').PaperSize,
      orientation: import('./types').PaperOrientation,
      customWidthMm: number,
      customHeightMm: number,
    ) => {
      const n = (scene?.sheets?.length ?? 0) + 1;
      const paperWasm = paper === 'custom' ? 'CUSTOM' : paper.toUpperCase();
      runViewAction(() =>
        apexCreateSheetWithLayout(
          `S-${100 + n}`,
          `Sheet ${n}`,
          paperWasm,
          orientation,
          customWidthMm,
          customHeightMm,
        ),
      );
    },
    onRenameSheet: (id: string, number: string, name: string) =>
      runViewAction(() => apexRenameSheet(id, number, name)),
    onDeleteSheet: (id: string) => runViewAction(() => apexDeleteSheet(id)),
  };

  const placementKindOf = (componentId: string): PlacementKind =>
    components.find((c) => c.id === componentId)?.placement ?? 'point';

  // -- canvas events: pure dispatch, no per-tool branching -------------------

  const onCanvasPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!ready || !rendererRef.current || e.button !== 0) return;
    const claimed = tool.onPointerDown?.(pointerInfo(e), toolContext()) ?? false;
    if (!claimed) return;
    suppressClickRef.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    appPointerCaptureRef.current = true;
    e.preventDefault();
  };

  const onCanvasPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!ready || !rendererRef.current) return;
    lastPointerRef.current = { x: e.clientX, y: e.clientY };
    tool.onPointerMove?.(pointerInfo(e), toolContext());
  };

  const onCanvasPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!ready || !rendererRef.current || e.button !== 0) return;
    tool.onPointerUp?.(pointerInfo(e), toolContext());
    if (
      appPointerCaptureRef.current &&
      e.currentTarget.hasPointerCapture(e.pointerId)
    ) {
      e.currentTarget.releasePointerCapture(e.pointerId);
      appPointerCaptureRef.current = false;
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
    if (tool.finishGesture?.(pending, toolContext())) {
      setPending([]);
      return;
    }
    const kind =
      tool.placementKind?.() ??
      (tool.componentId ? placementKindOf(tool.componentId) : 'point');
    if (tool.componentId && requiredPoints(kind) === null) {
      const component = tool.componentId
        ? (components.find((item) => item.id === tool.componentId) ?? null)
        : null;
      if (finishOpenGesture(tool, pending, toolContext(), component)) {
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

  const onSelectReferenceFromTree = (id: string) => {
    activateTool(ToolRegistry.selectId);
    applyScene(apexSelectReference(id));
  };

  const onSelectGridAxisFromTree = (id: string) => {
    activateTool(ToolRegistry.selectId);
    applyScene(apexSelectGridAxis(id));
  };

  const onSelectConstructionLineFromTree = (id: string) => {
    activateTool(ToolRegistry.selectId);
    applyScene(apexSelectConstructionLine(id));
  };

  const onSelectSectionCutFromTree = (id: string) => {
    activateTool(ToolRegistry.selectId);
    applyScene(apexSelectSectionCut(id));
  };

  const onSelectSpaceFromTree = (id: string) => {
    activateTool(ToolRegistry.selectId);
    applyScene(apexSelectSpace(id));
  };

  const onSelectLevel = (id: string) => {
    setSelectedLevelId(id);
    const levelName = levels.find((l) => l.id === id)?.name ?? 'Level';
    try {
      apexSetActiveLevel(id);
      applyScene(apexSelectElement(null));
      setInfo(`Active level: ${levelName}`);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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

  const onUpdateWallThickness = (thickness: number) => {
    if (!selected || selected.category !== 'wall' || !Number.isFinite(thickness) || thickness <= 0) {
      return;
    }
    const profileId = selected.profile_id ?? String(selected.params.profile ?? 'apex.wall.rect');
    const profile = profiles.find((item) => item.id === profileId);
    if (!profile) return;
    const dedicatedId = `user.wall.${selected.id.replace(/-/g, '').slice(0, 12)}`;
    try {
      const existing = profiles.find((item) => item.id === dedicatedId);
      if (!existing) {
        apexRegisterProfile({
          ...profile,
          id: dedicatedId,
          display_name: `${profile.display_name} · ${selected.name}`,
          type_values: { ...profile.type_values, thickness },
        });
      } else {
        apexUpdateProfileType(dedicatedId, { thickness });
      }
      applyScene(apexUpdateElement(selected.id, { profile: dedicatedId }));
      setProfiles(apexListProfiles());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onUpdateGridAxisParams = (params: Record<string, ParamValue>) => {
    if (!selectedGridAxis) return;
    try {
      applyScene(apexUpdateGridAxis(selectedGridAxis.id, params));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onUpdateConstructionLineParams = (params: Record<string, ParamValue>) => {
    if (!selectedConstructionLine) return;
    try {
      applyScene(apexUpdateConstructionLine(selectedConstructionLine.id, params));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onUpdateSectionCutParams = (params: Record<string, ParamValue>) => {
    if (!selectedSectionCut) return;
    try {
      applyScene(apexUpdateSectionCut(selectedSectionCut.id, params));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onUpdateSpaceParams = (params: Record<string, ParamValue>) => {
    if (!selectedSpace) return;
    try {
      applyScene(apexUpdateSpace(selectedSpace.id, params));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onRenameSpace = (name: string) => {
    if (!selectedSpace) return;
    try {
      applyScene(apexRenameSpace(selectedSpace.id, name));
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
    setComponentEditor(null);
    setProfileEditor({ profile, originalId: profile.id });
  };

  const onNewProfile = (category: string) => {
    const id = nextProfileId(profiles, category);
    setComponentEditor(null);
    setProfileEditor({ profile: defaultNewProfile(category, id), originalId: null });
  };

  const onEditComponent = (componentId: string) => {
    const component = components.find((item) => item.id === componentId);
    if (!component || !isUserAuthoredComponent(component)) return;
    setProfileEditor(null);
    setComponentEditor({ component, originalId: component.id });
  };

  const onNewComponent = (template: 'box' | 'beam' = 'box') => {
    const id = nextComponentId(components, template === 'beam' ? 'beam' : 'custom');
    setProfileEditor(null);
    setComponentEditor({
      component: defaultNewComponent(id, template),
      originalId: null,
    });
  };

  const onSaveComponent = (component: ComponentDto) => {
    const next = apexRegisterComponent(component);
    applyScene(next);
    syncCatalog();
    setComponentEditor(null);
    setError(null);
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

  const onSaveProject = () => {
    try {
      const json = apexExportProject();
      storeProject(json);
      downloadText('apex-project.json', json);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onOpenProjectFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = String(reader.result ?? '');
        const next = apexImportProject(text);
        storeProject(text);
        applyScene(next, true);
        syncCatalog();
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    };
    reader.readAsText(file);
  };

  const onNewProject = () => {
    if (scene?.can_undo) {
      const ok = window.confirm(
        'Start a new empty project? Unsaved changes in this document will be cleared.',
      );
      if (!ok) return;
    }
    try {
      const next = apexNewProject();
      clearStoredProject();
      applyScene(next, true);
      syncCatalog();
      setPlacementDraft({});
      setError(null);
      try {
        if (localStorage.getItem('apex.gettingStarted.dismissed') !== '1') {
          setShowGettingStarted(true);
        }
      } catch {
        setShowGettingStarted(true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onSelectType = (profileId: string) => {
    onEditType(profileId);
  };

  const selectedIds = scene?.selected_ids ?? [];
  const tools = useMemo(() => registryRef.current.list(), [components]);
  const placementComponent = tool.componentId
    ? (components.find((item) => item.id === tool.componentId) ?? null)
    : null;

  const inspector = (
    <PropertiesPanel
      selected={selected}
      selectedCount={selectedIds.length}
      selectedReference={selectedReference}
      selectedGridAxis={selectedGridAxis}
      selectedConstructionLine={selectedConstructionLine}
      selectedSectionCut={selectedSectionCut}
      selectedSpace={selectedSpace}
      component={selectedComponent}
      profiles={profiles}
      references={scene?.references ?? []}
      selectedLevel={
        selectedIds.length === 0 &&
        !placementComponent &&
        !selectedGridAxis &&
        !selectedConstructionLine &&
        !selectedSectionCut &&
        !selectedSpace &&
        !selectedReference
          ? selectedLevel
          : null
      }
      placement={
        placementComponent
          ? { component: placementComponent, params: placementDraft }
          : null
      }
      onUpdate={onUpdateParams}
      onUpdateGridAxis={onUpdateGridAxisParams}
      onUpdateConstructionLine={onUpdateConstructionLineParams}
      onUpdateSectionCut={onUpdateSectionCutParams}
      onUpdateSpace={onUpdateSpaceParams}
      onRenameSpace={onRenameSpace}
      onPlacementChange={onPlacementChange}
      onEditType={onEditType}
      onNewProfile={onNewProfile}
      onUpdateLevelElevation={onUpdateLevelElevation}
      onUpdateWallThickness={onUpdateWallThickness}
      onDelete={onDelete}
      booleanOperands={(() => {
        if (!selected || selected.component_id !== 'apex.boolean') return null;
        const list = scene?.elements ?? [];
        return (['operand_a', 'operand_b'] as const).map((key) => {
          const id = String(selected.params[key] ?? '');
          return { key, id, name: list.find((element) => element.id === id)?.name ?? '(missing)' };
        });
      })()}
      onSelectElement={(id) => onSelectFromTree(id, false)}
      parentName={(() => {
        if (!selected) return null;
        const list = scene?.elements ?? [];
        const parentId = list.find((element) => element.id === selected.id)?.parent_id;
        if (!parentId) return null;
        return list.find((element) => element.id === parentId)?.name ?? parentId;
      })()}
      onDetach={() => {
        if (!selected) return;
        try {
          applyScene(apexSetElementParent(selected.id, null));
          setError(null);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }}
      onDeleteGridAxis={() => applyScene(apexDeleteSelectedGridAxis())}
      onDeleteConstructionLine={() => applyScene(apexDeleteSelectedConstructionLine())}
      onDeleteSectionCut={() => applyScene(apexDeleteSelectedSectionCut())}
      onDeleteSpace={() => applyScene(apexDeleteSelectedSpace())}
    />
  );

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-doc">
          <div className="brand">APEX</div>
          <div className="file-actions">
            <button
              type="button"
              onClick={onUndo}
              disabled={!scene?.can_undo}
              title="Undo (Ctrl+Z)"
              data-testid="undo"
            >
              Undo
            </button>
            <button
              type="button"
              onClick={onRedo}
              disabled={!scene?.can_redo}
              title="Redo (Ctrl+Shift+Z)"
              data-testid="redo"
            >
              Redo
            </button>
            <button type="button" onClick={onSaveProject} data-testid="save-project">
              Save
            </button>
            {exporters.map((exporter) => (
              <button
                key={exporter.id}
                type="button"
                data-testid={`export-${exporter.id}`}
                title={exporter.title}
                onClick={() => {
                  try {
                    const text = exporter.export();
                    downloadText(exporter.filename, text);
                    setError(null);
                  } catch (err) {
                    setError(err instanceof Error ? err.message : String(err));
                  }
                }}
              >
                {exporter.label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              data-testid="open-project"
            >
              Open
            </button>
            <button type="button" onClick={onNewProject} data-testid="new-project">
              New
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              hidden
              aria-label="Open project file"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) onOpenProjectFile(file);
              }}
            />
          </div>
          <div className="topbar-level" data-testid="topbar-level">
            <em>{activeLevel?.name ?? '—'}</em>
          </div>
        </div>
        <ToolsToolbar
          tools={tools}
          activeToolId={toolId}
          drawMode={drawMode}
          projection={projection}
          viewNavigation={viewNavigation}
          onActivateTool={activateTool}
          onActivateDrawMode={activateDrawMode}
          onSetProjection={setProjectionMode}
          onSetViewNavigation={setViewNavigationMode}
          onFitView={fitView}
        />
        <div className="topbar-hint" data-testid="topbar-hint">
          <b>INFO</b>
          <span>
            {info ?? tool.hint(pending.length)}
            {pending.length > 0 && tool.group === 'create'
              ? typedLength
                ? ` — length ${typedLength} m (Enter)`
                : ' — type a length, Shift snaps to grid'
              : ''}
          </span>
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
          <ProjectBrowser
            elements={elements}
            references={scene?.references ?? []}
            gridAxes={scene?.grid_axes ?? []}
            constructionLines={scene?.construction_lines ?? []}
            sectionCuts={scene?.section_cuts ?? []}
            spaces={scene?.spaces ?? []}
            profiles={profiles}
            components={components}
            levels={levels}
            selectedIds={selectedIds}
            selectedProfileId={profileEditor?.originalId ?? profileEditor?.profile.id ?? null}
            selectedComponentId={
              componentEditor?.originalId ?? componentEditor?.component.id ?? null
            }
            selectedRefId={scene?.selected_ref_id ?? null}
            selectedGridAxisId={scene?.selected_grid_axis_id ?? null}
            selectedConstructionLineId={scene?.selected_construction_line_id ?? null}
            selectedSectionCutId={scene?.selected_section_cut_id ?? null}
            selectedSpaceId={scene?.selected_space_id ?? null}
            onSelectInstance={(id, multi) => onSelectFromTree(id, multi)}
            onSelectReference={onSelectReferenceFromTree}
            onSelectGridAxis={onSelectGridAxisFromTree}
            onSelectConstructionLine={onSelectConstructionLineFromTree}
            onSelectSectionCut={onSelectSectionCutFromTree}
            onSelectSpace={onSelectSpaceFromTree}
            onSelectType={onSelectType}
            onSelectComponent={onEditComponent}
            onNewProfile={() => onNewProfile('wall')}
            onNewComponent={() => onNewComponent('box')}
            {...browserViewsProps}
          />
        </aside>
      ) : null}

      <div className="viewport-wrap">
        {!ready && !error && <div className="loading">Loading Apex core…</div>}
        {error && <div className="error-banner">{error}</div>}
        {showGettingStarted && elements.length === 0 ? (
          <GettingStartedPanel
            onDismiss={() => {
              setShowGettingStarted(false);
              try {
                localStorage.setItem('apex.gettingStarted.dismissed', '1');
              } catch {
                /* ignore */
              }
            }}
            onLoadSample={() => {
              try {
                applyScene(buildSampleProject(), true);
                setInfo('Sample project loaded');
                setError(null);
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              }
            }}
          />
        ) : null}
        <DocumentViewsHost
          scene={scene}
          tabs={openTabs}
          activeTab={activeTab}
          splitTab={splitTab}
          splitEnabled={splitEnabled}
          activeIsView={activeIsView}
          activeSheet={activeSheet}
          onSelectTab={onSelectDocumentTab}
          onCloseTab={closeTab}
          onToggleSplit={toggleSplit}
          onSaveView={onSaveActiveView}
          onPlaceViewOnSheet={onPlaceViewOnSheet}
          onMoveSheetViewport={onMoveSheetViewport}
          syncSheetViewportScene={syncSheetViewportScene}
          onSheetViewportCropChange={onSheetViewportCropChange}
          onResetSheetViewportCrop={onResetSheetViewportCrop}
          onSetSheetViewportScale={onSetSheetViewportScale}
          onUpdateSheetLayout={onUpdateSheetLayout}
          onExportActiveViewSvg={onExportActiveViewSvg}
          onExportActiveViewDxf={onExportActiveViewDxf}
          onExportActiveViewPdf={onExportActiveViewPdf}
          activeViewIsPlan={activeViewIsPlan}
          viewport={
            <>
              <GridAxisLabels
                axes={scene?.grid_axes ?? []}
                spaces={activeLevelSpaces}
                renderer={ready ? rendererRef.current : null}
              />
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
            </>
          }
          splitViewport={
            <canvas ref={canvasSplitRef} className="view-canvas-split" aria-label="Secondary view" />
          }
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
              <ProjectBrowser
                elements={elements}
                references={scene?.references ?? []}
                gridAxes={scene?.grid_axes ?? []}
                constructionLines={scene?.construction_lines ?? []}
                sectionCuts={scene?.section_cuts ?? []}
                spaces={scene?.spaces ?? []}
                profiles={profiles}
                components={components}
                levels={levels}
                selectedIds={selectedIds}
                selectedProfileId={profileEditor?.originalId ?? profileEditor?.profile.id ?? null}
                selectedComponentId={
                  componentEditor?.originalId ?? componentEditor?.component.id ?? null
                }
                selectedRefId={scene?.selected_ref_id ?? null}
                selectedGridAxisId={scene?.selected_grid_axis_id ?? null}
                selectedConstructionLineId={scene?.selected_construction_line_id ?? null}
                selectedSectionCutId={scene?.selected_section_cut_id ?? null}
                selectedSpaceId={scene?.selected_space_id ?? null}
                onSelectInstance={(id, multi) => {
                  onSelectFromTree(id, multi);
                  if (!multi) closeMobileMenu();
                }}
                onSelectReference={(id) => {
                  onSelectReferenceFromTree(id);
                  closeMobileMenu();
                }}
                onSelectGridAxis={(id) => {
                  onSelectGridAxisFromTree(id);
                  closeMobileMenu();
                }}
                onSelectConstructionLine={(id) => {
                  onSelectConstructionLineFromTree(id);
                  closeMobileMenu();
                }}
                onSelectSectionCut={(id) => {
                  onSelectSectionCutFromTree(id);
                  closeMobileMenu();
                }}
                onSelectSpace={(id) => {
                  onSelectSpaceFromTree(id);
                  closeMobileMenu();
                }}
                onSelectType={(profileId) => {
                  onSelectType(profileId);
                  closeMobileMenu();
                }}
                onSelectComponent={(componentId) => {
                  onEditComponent(componentId);
                  closeMobileMenu();
                }}
                onNewProfile={() => onNewProfile('wall')}
                onNewComponent={() => onNewComponent('box')}
                {...browserViewsProps}
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
      {componentEditor ? (
        <ComponentEditor
          initial={componentEditor.component}
          originalId={componentEditor.originalId}
          profiles={profiles}
          onSave={onSaveComponent}
          onClose={() => setComponentEditor(null)}
        />
      ) : null}
    </div>
  );
}

/** Even-odd point-in-polygon test on the XZ plane. */
function pointInPlanPolygon(p: Vec3, ring: Vec3[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, , zi] = ring[i];
    const [xj, , zj] = ring[j];
    if (zi > p[2] !== zj > p[2] && p[0] < ((xj - xi) * (p[2] - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
