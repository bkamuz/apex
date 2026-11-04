import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadHairline, saveHairline } from './viewport/planStyle';
import { createShortcutMatcher, shortcutForCommand } from './ui/shortcuts';
import { ContextBar } from './ui/ContextBar';
import { CommandPalette, bilingual } from './ui/CommandPalette';
import type { PaletteCommand } from './ui/commands';
import { useTheme } from './theme/useTheme';
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
  apexJoinableSnapTargets,
  apexElementSnapGeometry,
  apexPreviewStretchTranslate,
  apexPreviewPathAnchorEdit,
  apexUndo,
  apexCommandScene,
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
  initApex,
  apexSetSlabShape,
  apexSlabShapeInfo,
  apexKernelStatus,
  apexRunQuery,
} from './wasm/apex';
import {
  currentKernel,
  kernelStats,
  preferredKernel,
  pumpKernelJobs,
  selectKernel,
  setKernelSceneSink,
} from './kernel/geometryKernel';
import { KernelToggle } from './ui/KernelToggle';
import {
  findElementSnap,
  loadSnapFilter,
  saveSnapFilter,
  snapKindLabel,
  type SnapFilter,
  type SnapGroup,
} from './tools/elementSnap';
import { StatusBar } from './ui/StatusBar';
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
  SlabShapeDto,
  SlabShapeInfoDto,
} from './types';
import { GridAxisLabels } from './ui/GridAxisLabels';
import { ViewCube } from './ui/ViewCube';
import { ViewPill } from './ui/ViewPill';
import { SettingsMenu } from './ui/SettingsMenu';
import { LevelList } from './ui/LevelList';
import { MobileMenuSheet, type MobileMenuTab } from './ui/MobileMenuSheet';
import { ComponentEditor } from './ui/ComponentEditor';
import { ProfileEditor } from './ui/ProfileEditor';
import { defaultNewComponent, isUserAuthoredComponent, nextComponentId } from './ui/componentModel';
import { ProjectBrowser } from './ui/ProjectBrowser';
import {
  clampSidebarWidth,
  loadSidebarPrefs,
  saveSidebarPrefs,
  type SidebarPrefs,
  type SidebarTab,
} from './ui/sidebarPrefs';
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
import type { SpeciesDto, VectorDrawing2d } from './types';
import type { DocumentTab } from './ui/ViewTabBar';
import { PropertiesPanel } from './ui/PropertiesPanel';
import { GenusSpeciesSection } from './ui/GenusSpeciesSection';
import { SHAPEABLE_COMPONENTS, SlabShapePanel } from './ui/SlabShapePanel';
import { ToolsToolbar } from './ui/ToolsToolbar';
import { GettingStartedPanel } from './ui/GettingStartedPanel';
import { buildSampleProject } from './ui/sampleProject';
import { defaultNewProfile, defaultPlacementParams, nextProfileId } from './ui/profileModel';
import { AgentBridgeControl } from './ui/AgentBridgeControl';
import {
  clearStoredProject,
  DEFAULT_PROJECT_FILENAME,
  downloadText,
  loadStoredProject,
  normalizeProjectFilename,
  storeProject,
} from './persist';
import { useMediaQuery } from './hooks/useMediaQuery';
import { ToolRegistry } from './tools/registry';
import { finishOpenGesture } from './tools/placementTool';
import { requiredPoints, type PointerInfo, type ToolContext } from './tools/Tool';
import {
  buildTranslatedGhostMesh,
  expandTransformOriginals,
  mergeGhostMeshes,
} from './tools/transformGhost';
import { type TransformMode } from './tools/transformTypes';
import { extensions, installGlobalSdk } from './extensions/sdk';
import {
  exporterDisplayLabel,
  exporterDisplayTitle,
  toolDisplayLabel,
  useI18n,
} from './i18n';
import {
  exporterRegistry,
  importerRegistry,
  installPlugins,
  subscribePackPrefs,
} from './plugins';
import { FileMenu } from './ui/FileMenu';

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

/** Shared-snap timing, read by benches through `__apexTest.snapStats`. */
const snapStats = { calls: 0, ms: 0, maxMs: 0 };

export default function App() {
  const { t, locale, setLocale } = useI18n();
  const { setPreference: setThemePreference } = useTheme();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sidebar, setSidebar] = useState<SidebarPrefs>(loadSidebarPrefs);
  const updateSidebar = useCallback((patch: Partial<SidebarPrefs>) => {
    setSidebar((prev) => {
      const next = { ...prev, ...patch };
      saveSidebarPrefs(next);
      return next;
    });
  }, []);
  const toggleSidebar = useCallback(
    () =>
      setSidebar((prev) => {
        const next = { ...prev, collapsed: !prev.collapsed };
        saveSidebarPrefs(next);
        return next;
      }),
    [],
  );
  const setSidebarTab = useCallback(
    (tab: SidebarTab) => updateSidebar({ tab, collapsed: false }),
    [updateSidebar],
  );
  // After placing from the Роды tab, show the model tree so the new instance is visible.
  const showModelAfterPlace = useCallback(
    () =>
      setSidebar((prev) => {
        if (prev.tab !== 'genera') return prev;
        const next = { ...prev, tab: 'model' as SidebarTab };
        saveSidebarPrefs(next);
        return next;
      }),
    [],
  );
  const startSidebarResize = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = sidebar.width;
      const onMove = (ev: PointerEvent) =>
        setSidebar((prev) => ({ ...prev, width: clampSidebarWidth(startW + ev.clientX - startX) }));
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        setSidebar((prev) => {
          saveSidebarPrefs(prev);
          return prev;
        });
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [sidebar.width],
  );
  /** Runs a two-letter shortcut command; refreshed every render. */
  const shortcutRunRef = useRef<(command: string) => boolean>(() => false);
  const projectRestoreDoneRef = useRef(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const canvasSplitRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<ViewportRenderer | null>(null);
  const splitRendererRef = useRef<ViewportRenderer | null>(null);
  const registryRef = useRef<ToolRegistry>(makeToolRegistry());
  const shiftHeldRef = useRef(false);
  const selectedRef = useRef<ElementDto | null>(null);
  /** Slab sub-element editing: active shape info and an in-flight drag. */
  const shapeEditRef = useRef<SlabShapeInfoDto | null>(null);
  const shapeDragRef = useRef<{
    index: number;
    startY: number;
    pxPerM: number;
    dz: number;
  } | null>(null);
  const selectedReferenceRef = useRef<ReferenceDto | null>(null);
  const selectedGridAxisRef = useRef<GridAxisDto | null>(null);
  const selectedConstructionLineRef = useRef<ConstructionLineDto | null>(null);
  const selectedSectionCutRef = useRef<SectionCutDto | null>(null);
  const selectedSpaceRef = useRef<SpaceDto | null>(null);
  const selectedCountRef = useRef(0);
  /** Attach Top/Base pick mode: the next clicked roof/slab becomes the target. */
  const attachPickRef = useRef<{ end: 'top' | 'base'; ids: string[] } | null>(null);
  const [attachPick, setAttachPickState] = useState<{ end: 'top' | 'base'; ids: string[] } | null>(null);
  const setAttachPick = (value: { end: 'top' | 'base'; ids: string[] } | null) => {
    attachPickRef.current = value;
    setAttachPickState(value);
  };
  const activeElevationRef = useRef(0);
  const suppressClickRef = useRef(false);
  /** True only after App claims LMB capture for a tool gesture — not camera buttons. */
  const appPointerCaptureRef = useRef(false);
  const draggingRef = useRef(false);
  const placementParamsRef = useRef<Record<string, ParamValue>>({});

  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kernelEpoch, setKernelEpoch] = useState(0);
  const [info, setInfo] = useState<string | null>(null);
  /** Live element-snap kind shown in the status line (end / mid / edge / …). */
  const [snapStatus, setSnapStatus] = useState<string | null>(null);
  /** Status-bar snap toggles; the ref feeds the hot snap path without re-renders. */
  const [snapFilter, setSnapFilter] = useState<SnapFilter>(() =>
    loadSnapFilter(typeof localStorage !== 'undefined' ? localStorage : undefined),
  );
  const snapFilterRef = useRef(snapFilter);
  snapFilterRef.current = snapFilter;
  const toggleSnap = useCallback((g: SnapGroup) => {
    setSnapFilter((prev) => {
      const next = { ...prev, [g]: !prev[g] };
      saveSnapFilter(typeof localStorage !== 'undefined' ? localStorage : undefined, next);
      return next;
    });
  }, []);
  /** fps + revision readout; `?debug=1` or localStorage `apex.debug=1`. */
  const [debugInfo, setDebugInfo] = useState<boolean>(() => {
    try {
      return (
        new URLSearchParams(location.search).get('debug') === '1' ||
        localStorage.getItem('apex.debug') === '1'
      );
    } catch {
      return false;
    }
  });
  const lastElementSnapRef = useRef<{ kind: string; point: Vec3 } | null>(null);
  const [showGettingStarted, setShowGettingStarted] = useState(() => {
    try {
      return localStorage.getItem('apex.gettingStarted.dismissed') !== '1';
    } catch {
      return true;
    }
  });
  const [components, setComponents] = useState<ComponentDto[]>([]);
  const [exporters, setExporters] = useState(() => exporterRegistry.list());
  const [importers, setImporters] = useState(() => importerRegistry.list());
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
  const toolIdRef = useRef(toolId);
  toolIdRef.current = toolId;
  /** Bumped whenever plugins are reinstalled so the toolbar re-reads the registry. */
  const [pluginEpoch, setPluginEpoch] = useState(0);
  const placementToolIdRef = useRef(toolId);
  const [drawMode, setDrawMode] = useState<string | null>(null);
  const [projection, setProjection] = useState<ProjectionMode>('orthographic');
  const [hairline, setHairline] = useState<boolean>(() =>
    loadHairline(typeof localStorage !== 'undefined' ? localStorage : undefined),
  );
  /** Revit-style two-letter codes (WA, DR, …, TL). */
  const shortcutSeqRef = useRef(createShortcutMatcher());
  useEffect(() => {
    rendererRef.current?.setHairline(hairline);
    saveHairline(typeof localStorage !== 'undefined' ? localStorage : undefined, hairline);
  });
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
  /** Bumps when a tool wants the status line to re-read `hint()`. */
  const [, setToolUiTick] = useState(0);
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
  const isMobile = useMediaQuery('(max-width: 640px)');
  const fileRef = useRef<HTMLInputElement>(null);
  /** Baseline JSON after New / Open / Save — dirty when live export differs. */
  const cleanProjectJsonRef = useRef<string | null>(null);
  const [projectFileName, setProjectFileName] = useState(DEFAULT_PROJECT_FILENAME);
  const [projectDirty, setProjectDirty] = useState(false);

  selectedRef.current = selected;
  selectedReferenceRef.current = selectedReference;
  selectedGridAxisRef.current = selectedGridAxis;
  selectedConstructionLineRef.current = selectedConstructionLine;
  selectedSectionCutRef.current = selectedSectionCut;
  selectedSpaceRef.current = selectedSpace;
  selectedCountRef.current = scene?.selected_ids?.length ?? 0;
  sceneRef.current = scene;

  const [shapeEditing, setShapeEditing] = useState(false);
  const [shapeHandle, setShapeHandle] = useState<number | null>(null);
  const shapeTarget =
    selected && (scene?.selected_ids?.length ?? 0) === 1 && SHAPEABLE_COMPONENTS.has(selected.component_id)
      ? selected
      : null;
  const shapeInfo = useMemo(() => {
    if (!shapeTarget) return null;
    try {
      return apexSlabShapeInfo(shapeTarget.id);
    } catch {
      return null;
    }
    // The scene changes whenever the slab (or its openings) is rebuilt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shapeTarget, scene]);
  const shapeEditForRef = useRef<{ id: string; info: SlabShapeInfoDto } | null>(null);
  const editingInfo = shapeEditing && shapeTarget && shapeInfo ? shapeInfo : null;
  shapeEditRef.current = editingInfo;
  shapeEditForRef.current = editingInfo && shapeTarget ? { id: shapeTarget.id, info: editingInfo } : null;
  useEffect(() => {
    setShapeEditing(false);
    setShapeHandle(null);
  }, [shapeTarget?.id]);
  useEffect(() => {
    if (editingInfo) showShapeGizmo(editingInfo);
    else if (toolRef.current?.id === ToolRegistry.selectId)
      syncEditGizmo(
        selectedRef.current,
        selectedReferenceRef.current,
        selectedGridAxisRef.current,
        selectedConstructionLineRef.current,
        selectedSectionCutRef.current,
        selectedSpaceRef.current,
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingInfo]);
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

  const showShapeGizmo = useCallback((info: SlabShapeInfoDto, drag?: { index: number; dz: number }) => {
    const points = info.handles.map((h, i) => {
      const p = [...h.position] as Vec3;
      if (drag && drag.index === i) p[1] += drag.dz;
      return p;
    });
    const vertices = points.filter((_, i) => info.handles[i].kind === 'vertex');
    const segments: Vec3[] = [];
    vertices.forEach((p, i) => segments.push(p, vertices[(i + 1) % vertices.length]));
    for (const [a, b] of info.shape.creases) {
      if (points[a] && points[b]) segments.push(points[a], points[b]);
    }
    rendererRef.current?.setEditGizmo(points, segments);
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
      if (shapeEditRef.current && el && el.id === shapeEditForRef.current?.id) {
        showShapeGizmo(shapeEditRef.current);
        return;
      }
      // A boolean has no geometry of its own to drag; its origin is noise.
      // Joinable paths expose every vertex, including T-junction inserts:
      // grabbing the junction bends the host into a corner and the abutting
      // wall's tip follows (path stretch). Move/translate still never kinks
      // a host — that guard lives in plan_stretch_translate (#142).
      const elementAnchors =
        el?.anchors?.length && el.component_id !== 'apex.boolean' ? el.anchors : null;
      const anchors = elementAnchors?.length
        ? elementAnchors
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
    setImporters(importerRegistry.list());
    setPluginEpoch((n) => n + 1);
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
      pumpKernelJobs();
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
  const applySceneRef = useRef(applyScene);
  applySceneRef.current = applyScene;

  /**
   * Screen → work-plane point. Shared snap pipeline: element geometry
   * (ends / mids / vertices / points / edge closest) for every type on the
   * active level, then Shift grid/ortho when nothing element-snapped.
   * Joinable peer ends are one source inside `apexElementSnapGeometry`.
   */
  const resolvePoint = useCallback(
    (
      clientX: number,
      clientY: number,
      shift: boolean,
      anchor: Vec3 | null,
      elevation?: number,
    ): Vec3 | null => {
      const renderer = rendererRef.current;
      if (!renderer) return null;
      const planeY = elevation ?? activeElevationRef.current;
      const raw = renderer.screenToGround(clientX, clientY, planeY);
      if (!raw) return null;

      const exclude = (() => {
        try {
          return apexGetSelectedElements().map((el) => el.id);
        } catch {
          return [] as string[];
        }
      })();
      let elementHit: ReturnType<typeof findElementSnap> = null;
      const snapT0 = performance.now();
      try {
        const geometry = apexElementSnapGeometry(exclude);
        elementHit = findElementSnap(
          { worldToClient: (p) => renderer.worldToClient(p) },
          clientX,
          clientY,
          geometry,
          raw,
          undefined,
          snapFilterRef.current,
        );
      } catch {
        elementHit = null;
      }
      const snapMs = performance.now() - snapT0;
      snapStats.calls += 1;
      snapStats.ms += snapMs;
      if (snapMs > snapStats.maxMs) snapStats.maxMs = snapMs;

      if (elementHit) {
        const point: Vec3 = [elementHit.point[0], planeY, elementHit.point[2]];
        lastElementSnapRef.current = { kind: elementHit.kind, point };
        const label = snapKindLabel(elementHit.kind);
        setSnapStatus((prev) => (prev === label ? prev : label));
        return point;
      }

      lastElementSnapRef.current = null;
      setSnapStatus((prev) => (prev == null ? prev : null));

      if (!shift && !shiftHeldRef.current) return raw;
      let point = snapPointToGrid(raw, GRID_STEP);
      if (anchor) point = snapPointToGrid(orthoConstrain(anchor, point), GRID_STEP);
      return point;
    },
    [],
  );

  /** Elevation of the level a selected editable sits on (element / annotation). */
  const selectedAnchorPlaneElevation = useCallback((): number | null => {
    const current = sceneRef.current;
    const levels = current?.levels ?? [];
    const levelElev = (levelId: string | undefined | null): number | null => {
      if (!levelId) return null;
      const hit = levels.find((l) => l.id === levelId);
      return hit ? hit.elevation : null;
    };
    if (selectedGridAxisRef.current) return levelElev(selectedGridAxisRef.current.level_id);
    if (selectedConstructionLineRef.current)
      return levelElev(selectedConstructionLineRef.current.level_id);
    if (selectedSectionCutRef.current) return levelElev(selectedSectionCutRef.current.level_id);
    if (selectedSpaceRef.current) return levelElev(selectedSpaceRef.current.level_id);
    if (selectedReferenceRef.current) return levelElev(selectedReferenceRef.current.level_id);
    const sel = selectedRef.current;
    if (sel && selectedCountRef.current === 1) {
      return levelElev(sel.effective_level_id || sel.level_id);
    }
    return null;
  }, []);

  /** Fresh services for the active tool; nothing is captured across events. */
  const toolContext = useCallback((): ToolContext => {
    const renderer = rendererRef.current!;
    return {
      resolvePoint: (x, y, shift, anchor, elevation) =>
        resolvePoint(x, y, shift, anchor, elevation),

      joinableSnapTargets: (componentId) => {
        try {
          return apexJoinableSnapTargets(componentId).map((t) => ({
            point: [...t.point] as Vec3,
            kind: t.kind,
            element_id: t.element_id,
          }));
        } catch {
          return [];
        }
      },

      createElement: (componentId, points, placementKind) => {
        try {
          applyScene(
            apexCreateElement(componentId, points, placementParamsRef.current, 0, placementKind),
          );
          setError(null);
          showModelAfterPlace();
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
          showModelAfterPlace();
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
        const elementSnapped = !!lastElementSnapRef.current;
        renderer.setSnapMarker(
          point && (shift || shiftHeldRef.current || elementSnapped) ? point : null,
          lastElementSnapRef.current?.kind === 'intersection' ? 'cross' : 'dot',
        );
      },

      pick: (x, y) => renderer.pick(x, y),

      selectElementId: (id, multi) => {
        applyScene(multi ? apexToggleSelectElement(id) : apexSelectElement(id));
      },

      setHoverPickIds: (pickIds) => {
        renderer.setHoveredPickIds(pickIds);
      },

      refreshToolUi: () => {
        setToolUiTick((n) => n + 1);
      },

      selectAt: (clientX, clientY, multi) => {
        const current = sceneRef.current;
        const attaching = attachPickRef.current;
        if (attaching) {
          const hit = renderer.pick(clientX, clientY);
          if (hit == null) return;
          try {
            const picked = apexPickById(hit).selected_ids?.[0];
            const target = (current?.elements ?? []).find((el) => el.id === picked);
            const ok = target && ['apex.roof', 'apex.roof.pitched', 'apex.slab'].includes(target.component_id);
            if (!ok) {
              setError(t('attach.pickError'));
              return;
            }
            const op = attaching.end === 'top' ? 'attach_top' : 'attach_base';
            apexCommandScene({ op, ids: attaching.ids, targets: [target.id] });
            applyScene(apexSelectElement(attaching.ids[0]));
            setInfo(`Attached ${attaching.ids.length} element(s) ${attaching.end} to ${target.name}.`);
            setError(null);
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          }
          setAttachPick(null);
          return;
        }
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
        let overlayHit: (typeof candidates)[number] | null = candidates[0] ?? null;
        // A wall drawn on a grid line must stay selectable: a model element
        // (not a floor slab) under the cursor beats a grid axis. The axis is
        // still picked off the element, e.g. at its bubble.
        if (overlayHit?.kind === 'grid_axis') {
          const under = renderer.pick(clientX, clientY);
          if (under != null && !renderer.isSlabPick(under)) overlayHit = null;
        }

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

      hitEditHandle: (x, y) => (shapeEditRef.current ? null : renderer.hitEditHandle(x, y)),
      hitShapeHandle: (x, y) => (shapeEditRef.current ? renderer.hitEditHandle(x, y) : null),
      beginShapeDrag: (index, _x, y) => {
        const info = shapeEditRef.current;
        const handle = info?.handles[index];
        if (!info || !handle) return;
        setShapeHandle(index);
        const p = handle.position;
        const a = renderer.worldToClient(p);
        const b = renderer.worldToClient([p[0], p[1] + 1, p[2]]);
        const pxPerM = a && b ? a[1] - b[1] : 0;
        // Looking straight down (plan): no vertical drag; type the offset instead.
        shapeDragRef.current = Math.abs(pxPerM) < 4 ? null : { index, startY: y, pxPerM, dz: 0 };
      },
      moveShapeDrag: (_x, y) => {
        const drag = shapeDragRef.current;
        const info = shapeEditRef.current;
        if (!drag || !info) return;
        drag.dz = Math.round(((drag.startY - y) / drag.pxPerM) * 100) / 100;
        showShapeGizmo(info, drag);
      },
      endShapeDrag: () => {
        const drag = shapeDragRef.current;
        shapeDragRef.current = null;
        const info = shapeEditRef.current;
        const target = shapeEditForRef.current?.id;
        if (!drag || !info || !target || Math.abs(drag.dz) < 1e-6) return;
        const handle = info.handles[drag.index];
        const vertices = info.handles.filter((h) => h.kind === 'vertex').length;
        const next: SlabShapeDto = {
          z: Array.from({ length: vertices }, (_, i) => info.shape.z[i] ?? 0),
          points: info.shape.points.map((p) => [...p] as [number, number, number]),
          creases: info.shape.creases,
        };
        if (handle.kind === 'vertex') next.z[handle.index] = handle.offset + drag.dz;
        else next.points[handle.index][2] = handle.offset + drag.dz;
        try {
          applyScene(apexSetSlabShape(target, next));
          setError(null);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
          showShapeGizmo(info);
        }
      },
      selectedAnchors: () => {
        if (selectedGridAxisRef.current) return selectedGridAxisRef.current.anchors;
        if (selectedConstructionLineRef.current)
          return selectedConstructionLineRef.current.anchors;
        if (selectedSectionCutRef.current) return selectedSectionCutRef.current.anchors;
        if (selectedSpaceRef.current) return selectedSpaceRef.current.anchors;
        if (selectedReferenceRef.current) return selectedReferenceRef.current.anchors;
        if (selectedCountRef.current !== 1 || !selectedRef.current) return null;
        return selectedRef.current.anchors;
      },

      selectedAnchorPlaneElevation: () => selectedAnchorPlaneElevation(),

      previewAnchors: (anchors) => {
        draggingRef.current = true;
        // Seat every handle on the editable's level plane so 3D drag does not
        // draw a rising gizmo when active elevation ≠ element elevation.
        // Prefer the element's level; fall back to the existing anchors' Y so a
        // stale selection ref cannot lift the gizmo to the active storey.
        const planeY = selectedAnchorPlaneElevation() ?? anchors[0]?.[1] ?? null;
        const seated =
          planeY == null
            ? anchors
            : anchors.map((p) => [p[0], planeY, p[2]] as Vec3);
        renderer.setEditGizmo(seated);
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
            applyLive(apexSetGridAxisPlacement(axisSel.id, seated, 0, false), (next) =>
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
            applyLive(apexSetConstructionLinePlacement(lineSel.id, seated, 0, false), (next) =>
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
            applyLive(apexSetSectionCutPlacement(cutSel.id, seated, 0, false), (next) =>
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
            applyLive(apexSetSpacePlacement(spaceSel.id, seated, 0, false), (next) =>
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
            applyLive(apexSetReferencePlacement(refSel.id, seated, 0, false), (next) =>
              syncReferenceGizmos(next.references ?? []),
            );
          } catch {
            /* keep dragging */
          }
          return;
        }
        const sel = selectedRef.current;
        if (!sel) return;
        // Ghost-only: remesh edited path + stretch peers without mutating the
        // document or dumping a full scene on every pointer move (multi-wall lag).
        try {
          const preview = apexPreviewPathAnchorEdit(sel.id, seated);
          const current = sceneRef.current;
          const hidePicks: number[] = [];
          if (current) {
            for (const id of preview.hide_ids) {
              const entry = current.elements.find((el) => el.id === id);
              if (entry) hidePicks.push(entry.pick_id);
            }
          }
          renderer.setHiddenPickIds(hidePicks);
          if (preview.indices.length > 0) {
            renderer.setGhostMesh({
              positions: toFloatArray(preview.positions),
              normals: toFloatArray(preview.normals),
              indices: toUint32Array(preview.indices),
            });
          } else {
            renderer.setGhostMesh(null);
          }
          renderer.setJunctionMarkers(preview.junctions);
        } catch {
          /* keep dragging */
        }
      },

      commitAnchors: (anchors) => {
        draggingRef.current = false;
        renderer.setGhostMesh(null);
        renderer.setJunctionMarkers(null);
        renderer.setHiddenPickIds([]);
        const planeY = selectedAnchorPlaneElevation() ?? anchors[0]?.[1] ?? null;
        const seated =
          planeY == null
            ? anchors
            : anchors.map((p) => [p[0], planeY, p[2]] as Vec3);
        const axisSel = selectedGridAxisRef.current;
        if (axisSel) {
          try {
            applyScene(apexSetGridAxisPlacement(axisSel.id, seated, 0, true));
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
            applyScene(apexSetConstructionLinePlacement(lineSel.id, seated, 0, true));
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
            applyScene(apexSetSectionCutPlacement(cutSel.id, seated, 0, true));
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
            applyScene(apexSetSpacePlacement(spaceSel.id, seated, 0, true));
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
            applyScene(apexSetReferencePlacement(refSel.id, seated, 0, true));
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
          applyScene(apexSetElementPlacement(sel.id, seated, 0, true));
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
        renderer.setGhostMesh(null);
        renderer.setHiddenPickIds([]);
        draggingRef.current = false;
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
        // Movers: translate live scene triangles (cheap). Stretch peers: remesh
        // in WASM only the connected joinables whose shape actually changes.
        const current = sceneRef.current;
        if (!current) {
          renderer.setGhostMesh(null);
          return;
        }
        const expanded = expandTransformOriginals(originals, current.elements);
        const movers = buildTranslatedGhostMesh(current, expanded, delta);
        let stretch: ReturnType<typeof buildTranslatedGhostMesh> = null;
        let junctions: Vec3[] | null = null;
        const joinableIds = new Set(
          components.filter((c) => c.joinable).map((c) => c.id),
        );
        const needsStretch = originals.some((o) => {
          if (o.kind !== 'element') return false;
          const el = current.elements.find((e) => e.id === o.id);
          return !!el && joinableIds.has(el.component_id);
        });
        if (needsStretch) {
          try {
            const mesh = apexPreviewStretchTranslate(delta);
            junctions = mesh?.junctions ?? null;
            if (mesh && mesh.indices.length > 0) {
              stretch = {
                positions: toFloatArray(mesh.positions),
                normals: toFloatArray(mesh.normals),
                indices: toUint32Array(mesh.indices),
              };
            }
          } catch {
            /* translate-only ghost still useful */
          }
        }
        renderer.setGhostMesh(mergeGhostMeshes(movers, stretch));
        renderer.setJunctionMarkers(junctions);
      },

      commitTransform: (_originals, delta, mode: TransformMode) => {
        try {
          renderer.setGhostMesh(null);
          renderer.setJunctionMarkers(null);
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

      pickElementCandidates: (clientX, clientY) => {
        const current = sceneRef.current;
        if (!current) return [];
        return renderer
          .pickAll(clientX, clientY)
          .map((pickId) => {
            const el = current.elements.find((c) => c.pick_id === pickId);
            return el
              ? { id: el.id, name: el.name, category: el.category, pickId }
              : null;
          })
          .filter((c): c is NonNullable<typeof c> => !!c);
      },

      selectedElementIds: () => apexGetSelectedElements().map((element) => element.id),

      selectedJoinableComponentId: () => {
        const sel = selectedRef.current;
        if (!sel || selectedCountRef.current !== 1) return null;
        const def = apexListComponents().find((c) => c.id === sel.component_id);
        return def?.joinable ? sel.component_id : null;
      },

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
    components,
    resolvePoint,
    selectedAnchorPlaneElevation,
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
    rendererRef.current.setHoveredPickIds([]);
  }, [clearPreview, toolContext]);

  const focusViewportCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== canvas && active !== document.body) {
      // Drop toolbar/button focus so Tab cannot walk chrome while Select is live.
      active.blur();
    }
    canvas.focus({ preventScroll: true });
  }, []);

  const activateTool = useCallback(
    (id: string) => {
      cancelGesture();
      rendererRef.current?.setHoveredPickIds([]);
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
        // After clicking the Select button, keep focus on the viewport so Tab
        // cycles pick candidates instead of the next toolbar control.
        queueMicrotask(() => focusViewportCanvas());
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
    [applyScene, cancelGesture, components, focusViewportCanvas, profiles, syncEditGizmo],
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
    if (attachPickRef.current) {
      setAttachPick(null);
      return;
    }
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
      // Ctrl+K: command palette over every command.
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      // Ctrl+B: show / hide the project browser.
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        toggleSidebar();
        return;
      }
      // Revit-style two-letter codes (WA wall, DR door, …, TL thin lines).
      if (!typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const command = shortcutSeqRef.current.feed(e.key, performance.now());
        if (command && shortcutRunRef.current(command)) {
          e.preventDefault();
          return;
        }
      }
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
      // Select / Boolean claim Tab for pick cycling — never let the browser
      // walk toolbar/header focus. Still allow Tab inside real text fields.
      if (!textEntry && (e.key === 'Tab' || e.code === 'Tab')) {
        const activeTool = toolRef.current;
        if (
          activeTool.id === ToolRegistry.selectId ||
          activeTool.id === 'apex.booleanTool'
        ) {
          e.preventDefault();
          e.stopPropagation();
          activeTool.onKey?.(e, toolContext());
          return;
        }
      }
      if (!typing && toolRef.current.onKey?.(e, toolContext())) {
        e.preventDefault();
        e.stopPropagation();
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
          /** Geometry kernel: 'smlib' (default, exact) or 'mesh'. */
          setKernel: (name: 'mesh' | 'smlib') => {
            applyScene(selectKernel(name));
            setKernelEpoch((n) => n + 1);
          },
          kernelStats: () => ({ ...kernelStats, kernel: currentKernel() }),
          /** Cumulative shared-snap cost (resolvePoint element snap) for benches. */
          snapStats: () => ({ ...snapStats }),
          resetSnapStats: () => {
            snapStats.calls = 0;
            snapStats.ms = 0;
            snapStats.maxMs = 0;
          },
          /** Core calls for scripts that run against a production build. */
          api: {
            importProject: apexImportProject,
            listElements: apexListElements,
            runQuery: apexRunQuery,
            kernelStatus: apexKernelStatus,
            elementSnapGeometry: apexElementSnapGeometry,
          },
          /** Run a project command the way the UI does (scene + kernel pump). */
          command: (cmd: Record<string, unknown>) => applyScene(apexCommandScene(cmd)),
          worldToClient: (p: Vec3) => rendererRef.current?.worldToClient(p) ?? null,
          screenToGround: (clientX: number, clientY: number, elevation?: number) =>
            rendererRef.current?.screenToGround(
              clientX,
              clientY,
              elevation ?? activeElevationRef.current,
            ) ?? null,
          /** Live edit-handle world positions (null when no gizmo). */
          getEditHandles: () => rendererRef.current?.getEditHandles() ?? null,
          /** Live junction marker count while dragging (tests). */
          junctionMarkerCount: () => rendererRef.current?.getJunctionMarkerCount() ?? 0,
          getCamera: () => rendererRef.current?.getCamera() ?? null,
          setCamera: (c: Parameters<ViewportRenderer['setCamera']>[0]) => rendererRef.current?.setCamera(c),
          /** Replace the document with the built-in sample house (tests / demos). */
          loadSampleProject: () => {
            applyScene(buildSampleProject(), true);
            setShowGettingStarted(false);
            return true;
          },
          /** Select the newest element of a component (e.g. 'apex.roof_pitched'). */
          selectLast: (componentId: string) => {
            const hit = apexListElements().filter((e) => e.component_id === componentId).pop();
            if (hit) applyScene(apexSelectElement(hit.id));
            return hit?.id ?? null;
          },
          /** Select the element of a category whose anchors' midpoint is nearest (x, y, z). */
          selectNear: (category: string, p: Vec3) => {
            let best: { id: string; d: number } | null = null;
            for (const e of apexListElements().filter((el) => el.category === category)) {
              apexSelectElement(e.id);
              const a = apexGetSelected()?.anchors ?? [];
              if (!a.length) continue;
              const m = [0, 1, 2].map((k) => a.reduce((s, v) => s + v[k], 0) / a.length);
              const d = Math.hypot(m[0] - p[0], m[1] - p[1], m[2] - p[2]);
              if (!best || d <= best.d + 1e-6) best = { id: e.id, d }; // ties: newest wins
            }
            applyScene(apexSelectElement(best?.id ?? null));
            return best?.id ?? null;
          },
          /** Multi-hit stack under a client point (nearest first). */
          pickCandidates: (clientX: number, clientY: number) => {
            const r = rendererRef.current;
            const current = sceneRef.current;
            if (!r || !current) return [];
            return r
              .pickAll(clientX, clientY)
              .map((pickId) => {
                const el = current.elements.find((c) => c.pick_id === pickId);
                return el
                  ? { id: el.id, name: el.name, category: el.category, pickId }
                  : { id: null, name: `pick:${pickId}`, category: '?', pickId };
              });
          },
          /** Select a datum by kind and id (tests / screenshots). */
          selectDatum: (kind: string, id: string | null) => {
            const fn = {
              reference: apexSelectReference,
              grid: apexSelectGridAxis,
              construction: apexSelectConstructionLine,
              section: apexSelectSectionCut,
              space: apexSelectSpace,
            }[kind];
            if (fn) applyScene(fn(id));
          },
          /** Select several elements at once (tests / screenshots). */
          selectElements: (ids: string[]) => {
            applyScene(apexSelectElement(ids[0] ?? null));
            for (const id of ids.slice(1)) applyScene(apexToggleSelectElement(id));
          },
          clearSelection: () => {
            applyScene(apexSelectElement(null));
            applyScene(apexSelectReference(null));
            applyScene(apexSelectGridAxis(null));
            applyScene(apexSelectConstructionLine(null));
            applyScene(apexSelectSectionCut(null));
            applyScene(apexSelectSpace(null));
          },
        };

        const stored = loadStoredProject();
        let autoLoadedSample = false;
        if (stored) {
          try {
            apexImportProject(stored);
          } catch (restoreError) {
            console.warn('could not restore saved project', restoreError);
          }
        } else {
          // First visit with no autosave: load the house sample. Never overwrite
          // a stored project. Smoke/tests set gettingStarted.dismissed to skip.
          let dismissed = false;
          try {
            dismissed = localStorage.getItem('apex.gettingStarted.dismissed') === '1';
          } catch {
            dismissed = false;
          }
          if (!dismissed) {
            try {
              buildSampleProject();
              autoLoadedSample = true;
            } catch (sampleError) {
              console.warn('could not auto-load sample project', sampleError);
            }
          }
        }

        // The toolbar is generated from whatever the core has installed.
        syncCatalog();
        installGlobalSdk();

        // Exact SMLib booleans by default; `?kernel=mesh` or the toggle opts out.
        setKernelSceneSink((next) => applySceneRef.current(next, false));
        if (preferredKernel() === 'smlib') selectKernel('smlib');
        setKernelEpoch((n) => n + 1);

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
          try {
            cleanProjectJsonRef.current = apexExportProject();
            setProjectDirty(false);
          } catch {
            cleanProjectJsonRef.current = stored;
            setProjectDirty(false);
          }
          if (autoLoadedSample) {
            setShowGettingStarted(false);
            setInfo(t('chrome.sampleLoaded'));
          }
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

  const activateToolRef = useRef(activateTool);
  activateToolRef.current = activateTool;

  // System-pack Settings toggles reinstall plugins; fall back to Select if the
  // active tool belonged to a pack that was just disabled.
  useEffect(() => {
    if (!ready) return;
    return subscribePackPrefs(() => {
      syncCatalog();
      if (!registryRef.current.get(toolIdRef.current)) {
        activateToolRef.current(ToolRegistry.selectId);
      }
    });
  }, [ready, syncCatalog]);

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

  const blurFocusedField = () => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.matches('input, select, textarea, [contenteditable="true"]')) {
      active.blur();
    }
  };

  const placementKindOf = (componentId: string): PlacementKind =>
    components.find((c) => c.id === componentId)?.placement ?? 'point';

  // -- canvas events: pure dispatch, no per-tool branching -------------------

  const onCanvasPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!ready || !rendererRef.current || e.button !== 0) return;
    // Commit a property edit in progress before the canvas acts on the click,
    // otherwise its blur/commit can land after (and undo) the new selection.
    blurFocusedField();
    if (toolRef.current.id === ToolRegistry.selectId) focusViewportCanvas();
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

  const onCanvasPointerEnter = () => {
    if (toolRef.current.id === ToolRegistry.selectId) focusViewportCanvas();
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
    if (toolRef.current.id === ToolRegistry.selectId) {
      rendererRef.current?.setHoveredPickIds([]);
    }
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

  const onSetSlabShape = (shape: SlabShapeDto) => {
    if (!selected) return;
    try {
      applyScene(apexSetSlabShape(selected.id, shape));
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
    try {
      // One core command: derives the per-wall profile and rebinds the wall
      // inside a single undo step.
      applyScene(apexCommandScene({ op: 'update_element', id: selected.id, params: { thickness } }));
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

  const markProjectClean = useCallback((json?: string, fileName?: string) => {
    try {
      const snapshot = json ?? apexExportProject();
      cleanProjectJsonRef.current = snapshot;
      setProjectDirty(false);
      if (fileName) setProjectFileName(normalizeProjectFilename(fileName));
    } catch {
      cleanProjectJsonRef.current = json ?? null;
      setProjectDirty(false);
      if (fileName) setProjectFileName(normalizeProjectFilename(fileName));
    }
  }, []);

  const isProjectDirty = useCallback(() => {
    try {
      const json = apexExportProject();
      const clean = cleanProjectJsonRef.current;
      if (clean === null) return Boolean(sceneRef.current?.can_undo);
      return json !== clean;
    } catch {
      return Boolean(sceneRef.current?.can_undo);
    }
  }, []);

  const refreshProjectDirty = useCallback(() => {
    setProjectDirty(isProjectDirty());
  }, [isProjectDirty]);

  const confirmDiscardIfDirty = useCallback(
    (message: string) => {
      if (!isProjectDirty()) return true;
      return window.confirm(message);
    },
    [isProjectDirty],
  );

  const writeProjectFile = useCallback(
    (fileName: string) => {
      const json = apexExportProject();
      const name = normalizeProjectFilename(fileName);
      storeProject(json);
      downloadText(name, json);
      markProjectClean(json, name);
      setInfo(t('chrome.saveDone', { name }));
      setError(null);
    },
    [markProjectClean, t],
  );

  const onSaveProject = useCallback(() => {
    try {
      writeProjectFile(projectFileName);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [projectFileName, writeProjectFile]);

  const onSaveProjectAs = useCallback(() => {
    const suggested = projectFileName || DEFAULT_PROJECT_FILENAME;
    const entered = window.prompt(t('chrome.saveAsPrompt'), suggested);
    if (entered == null) return;
    try {
      writeProjectFile(entered);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [projectFileName, t, writeProjectFile]);

  const onRequestOpenProject = useCallback(() => {
    if (!confirmDiscardIfDirty(t('chrome.openConfirm'))) return;
    fileRef.current?.click();
  }, [confirmDiscardIfDirty, t]);

  const onOpenProjectFile = useCallback(
    (file: File) => {
      const reader = new FileReader();
      reader.onload = () => {
        void (async () => {
          try {
            const text = String(reader.result ?? '');
            const importer = importerRegistry.findForFile(file.name);
            if (importer) {
              setInfo(t('chrome.opening', { label: importer.label }));
              const next = (await Promise.resolve(importer.import(text))) as SceneDto & {
                ifc_import?: {
                  levels: number;
                  products: number;
                  skipped_no_mesh: number;
                  warnings: string[];
                };
              };
              applyScene(next, true);
              syncCatalog();
              if (importer.id === 'apex.project') {
                storeProject(text);
                markProjectClean(text, file.name);
              } else {
                // Non-JSON imports (IFC) start a new live document until Save.
                clearStoredProject();
                markProjectClean(undefined, DEFAULT_PROJECT_FILENAME);
              }
              const summary = next.ifc_import;
              if (summary) {
                const skipped =
                  summary.skipped_no_mesh > 0
                    ? ` (${summary.skipped_no_mesh} without mesh skipped)`
                    : '';
                setInfo(
                  `Opened IFC: ${summary.products} product${summary.products === 1 ? '' : 's'}, ${summary.levels} level${summary.levels === 1 ? '' : 's'}${skipped}`,
                );
              } else {
                setInfo(
                  t('chrome.openImporterDone', { label: importer.label, name: file.name }),
                );
              }
              setError(null);
              return;
            }
            const next = apexImportProject(text);
            storeProject(text);
            markProjectClean(text, file.name);
            applyScene(next, true);
            syncCatalog();
            setInfo(t('chrome.openDone', { name: file.name }));
            setError(null);
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          }
        })();
      };
      reader.readAsText(file);
    },
    [applyScene, markProjectClean, syncCatalog, t],
  );

  const onNewProject = useCallback(() => {
    if (!confirmDiscardIfDirty(t('chrome.newProjectConfirm'))) return;
    try {
      const next = apexNewProject();
      clearStoredProject();
      applyScene(next, true);
      syncCatalog();
      setPlacementDraft({});
      markProjectClean(undefined, DEFAULT_PROJECT_FILENAME);
      setError(null);
      setInfo(null);
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
  }, [applyScene, confirmDiscardIfDirty, markProjectClean, syncCatalog, t]);

  useEffect(() => {
    if (!ready) return;
    refreshProjectDirty();
  }, [ready, scene?.version, scene?.can_undo, refreshProjectDirty]);

  useEffect(() => {
    const onFileKeyDown = (e: KeyboardEvent) => {
      const active = document.activeElement;
      const typing =
        active instanceof HTMLElement &&
        (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT');
      const mod = e.ctrlKey || e.metaKey;
      if (typing || !mod) return;
      const key = e.key.toLowerCase();
      if (key === 's') {
        e.preventDefault();
        if (e.shiftKey) onSaveProjectAs();
        else onSaveProject();
        return;
      }
      if (key === 'o') {
        e.preventDefault();
        onRequestOpenProject();
        return;
      }
      if (key === 'n') {
        e.preventDefault();
        onNewProject();
      }
    };
    window.addEventListener('keydown', onFileKeyDown, true);
    return () => window.removeEventListener('keydown', onFileKeyDown, true);
  }, [onNewProject, onRequestOpenProject, onSaveProject, onSaveProjectAs]);

  const onSelectType = (profileId: string) => {
    onEditType(profileId);
  };

  const selectedIds = scene?.selected_ids ?? [];
  const selectedElementsList = useMemo(
    () => (selectedIds.length > 1 ? apexGetSelectedElements() : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scene],
  );
  const profileUsage = useMemo(() => {
    const out: Record<string, number> = {};
    for (const element of scene?.elements ?? []) {
      if (element.profile_id) out[element.profile_id] = (out[element.profile_id] ?? 0) + 1;
    }
    return out;
  }, [scene]);
  const tools = useMemo(() => registryRef.current.list(), [components, pluginEpoch]);
  const placementComponent = tool.componentId
    ? (components.find((item) => item.id === tool.componentId) ?? null)
    : null;

  const attachableIds = (scene?.elements ?? [])
    .filter((el) => selectedIds.includes(el.id) && ['apex.wall', 'apex.column'].includes(el.component_id))
    .map((el) => el.id);
  const runAttach = (command: Record<string, unknown>, note: string) => {
    try {
      applyScene(apexCommandScene(command));
      setInfo(note);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  const attachButtons = () =>
    attachableIds.length === 0 ? null : (
      <>
        <button
          type="button"
          data-testid="attach-top"
          title={t('attach.topAutoTitle')}
          onClick={() =>
            runAttach({ op: 'attach_top', ids: attachableIds }, t('attach.topAutoDone'))
          }
        >
          {t('attach.topAuto')}
        </button>
        <button
          type="button"
          data-testid="attach-top-pick"
          className={attachPick?.end === 'top' ? 'active' : undefined}
          title={t('attach.topPickTitle')}
          onClick={() => setAttachPick({ end: 'top', ids: attachableIds })}
        >
          {t('attach.topPick')}
        </button>
        <button
          type="button"
          data-testid="attach-base-pick"
          className={attachPick?.end === 'base' ? 'active' : undefined}
          title={t('attach.basePickTitle')}
          onClick={() => setAttachPick({ end: 'base', ids: attachableIds })}
        >
          {t('attach.basePick')}
        </button>
        <button
          type="button"
          data-testid="attach-detach"
          title={t('attach.detachTitle')}
          onClick={() => runAttach({ op: 'detach', ids: attachableIds }, t('attach.detachDone'))}
        >
          {t('attach.detach')}
        </button>
      </>
    );
  // Attach top/base joins the contextual Modify panel (not Annotate).
  const attachToolbar =
    attachableIds.length > 0 ? (
      <span className="rb-attach" role="group" aria-label={t('attach.group')}>
        {attachButtons()}
      </span>
    ) : null;
  // Attach top/base commands live on the Изменить ribbon; the inspector keeps
  // only the pick hint (the attach fields themselves are schema params).
  const attachSection = attachPick ? (
    <div className="empty" style={{ padding: 0, marginTop: 4 }} data-testid="attach-pick-hint">
      {t('attach.pickHint', { end: attachPick.end })}
    </div>
  ) : null;

  const inspector = (
    <PropertiesPanel
      attachSection={attachSection}
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
      genusSection={
        selected && selectedComponent?.default_species ? (
          <GenusSpeciesSection
            element={selected}
            component={selectedComponent}
            components={components}
            onScene={applyScene}
            onError={setError}
          />
        ) : null
      }
      speciesSection={
        selected && selectedComponent?.default_species ? (
          <GenusSpeciesSection
            part="params"
            element={selected}
            component={selectedComponent}
            components={components}
            onScene={applyScene}
            onError={setError}
          />
        ) : null
      }
      selectedElements={selectedElementsList}
      components={components}
      profileUsage={profileUsage}
      onUpdateMany={(patch) => {
        const ids = selectedElementsList.map((element) => element.id);
        if (ids.length === 0) return;
        try {
          applyScene(
            apexCommandScene({
              op: 'batch',
              commands: ids.map((id) => ({ op: 'update_element', id, params: patch })),
            }),
          );
          // Keep the whole selection after the edit.
          if (apexGetSelectedElements().length !== ids.length) {
            applyScene(apexSelectElement(ids[0]));
            for (const id of ids.slice(1)) applyScene(apexToggleSelectElement(id));
          }
          setError(null);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }}
      onResetParams={(params) => {
        if (!selected) return;
        try {
          applyScene(apexCommandScene({ op: 'reset_element_params', id: selected.id, params }));
          if (apexGetSelectedElements()[0]?.id !== selected.id) applyScene(apexSelectElement(selected.id));
          setError(null);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }}
      shapeSection={
        shapeTarget && shapeInfo ? (
          <SlabShapePanel
            info={shapeInfo}
            editing={shapeEditing}
            activeHandle={shapeHandle}
            onToggleEditing={() => setShapeEditing((v) => !v)}
            onChange={onSetSlabShape}
          />
        ) : null
      }
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

  const onboarding = showGettingStarted && elements.length === 0;
  const contextSpecies = useMemo(
    () => {
      if (!tool.componentId) return [] as SpeciesDto[];
      try {
        return apexRunQuery({ op: 'list_genus_species' }) as SpeciesDto[];
      } catch {
        return [] as SpeciesDto[];
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tool.componentId, scene],
  );
  const statusText = `${info ?? tool.hint(pending.length)}${
    pending.length > 0 && tool.group === 'create'
      ? typedLength
        ? t('chrome.typedLength', { length: typedLength })
        : t('chrome.typeLengthHint')
      : ''
  }${snapStatus ? t('chrome.elementSnap', { kind: t(`snap.kind.${snapStatus}`, undefined, snapStatus) }) : ''}`;

  shortcutRunRef.current = (command: string) => {
    if (command === 'action:thin-lines') {
      setHairline((v) => !v);
      return true;
    }
    if (command.startsWith('tool:')) {
      const id = command.slice('tool:'.length);
      if (!registryRef.current.get(id)) return false;
      activateTool(id);
      return true;
    }
    return false;
  };

  const paletteCommands = (): PaletteCommand[] => {
    const out: PaletteCommand[] = [];
    const add = (
      id: string,
      key: string,
      groupKey: string,
      run: () => void,
      opts: { shortcut?: string; disabled?: boolean; label?: string; extra?: string[] } = {},
    ) =>
      out.push({
        id,
        label: opts.label ?? t(key),
        search: bilingual(key, id, opts.shortcut, ...(opts.extra ?? [])),
        group: t(groupKey),
        shortcut: opts.shortcut,
        disabled: opts.disabled,
        run,
      });
    for (const item of tools) {
      const key = item.id.startsWith('place:')
        ? `component.${item.id.slice('place:'.length)}`
        : `tool.${item.id}.label`;
      add(`tool:${item.id}`, key, 'cmd.group.tool', () => activateTool(item.id), {
        label: toolDisplayLabel(item),
        shortcut: shortcutForCommand(`tool:${item.id}`) ?? item.shortcut,
        extra: [item.label],
      });
    }
    if (attachableIds.length > 0) {
      add('attach-top', 'cmd.attachTop', 'cmd.group.edit', () =>
        setAttachPick({ end: 'top', ids: attachableIds }),
      );
      add('attach-base', 'cmd.attachBase', 'cmd.group.edit', () =>
        setAttachPick({ end: 'base', ids: attachableIds }),
      );
    }
    add('undo', 'cmd.undo', 'cmd.group.edit', onUndo, { shortcut: 'Ctrl+Z', disabled: !scene?.can_undo });
    add('redo', 'cmd.redo', 'cmd.group.edit', onRedo, { shortcut: 'Ctrl+Y', disabled: !scene?.can_redo });
    add('new', 'cmd.new', 'cmd.group.file', onNewProject, { shortcut: 'Ctrl+N' });
    add('open', 'cmd.open', 'cmd.group.file', onRequestOpenProject, { shortcut: 'Ctrl+O' });
    add('save', 'cmd.save', 'cmd.group.file', onSaveProject, { shortcut: 'Ctrl+S' });
    add('save-as', 'cmd.saveAs', 'cmd.group.file', onSaveProjectAs);
    for (const exporter of exporters) {
      const label = exporterDisplayLabel(exporter);
      out.push({
        id: `export:${exporter.id}`,
        label: t('cmd.export', { label }),
        search: `${bilingual('cmd.group.export')} export экспорт ${label} ${exporter.id}`.toLowerCase(),
        group: t('cmd.group.export'),
        run: () => {
          try {
            downloadText(exporter.filename, exporter.export(), 'application/octet-stream');
            setError(null);
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          }
        },
      });
    }
    add('view-3d', 'cmd.view3d', 'cmd.group.view', () => setViewNavigationMode('3d'), { shortcut: '3' });
    add('view-plan', 'cmd.plan', 'cmd.group.view', () => setViewNavigationMode('plan'), { shortcut: 'P' });
    add('view-fit', 'cmd.fit', 'cmd.group.view', fitView, { shortcut: 'F' });
    add('view-axon', 'cmd.axon', 'cmd.group.view', () => setProjectionMode('orthographic'));
    add('view-persp', 'cmd.persp', 'cmd.group.view', () => setProjectionMode('perspective'));
    add('toggle-browser', 'cmd.toggleBrowser', 'cmd.group.view', toggleSidebar, { shortcut: 'Ctrl+B' });
    add('thin-lines', 'cmd.thinLines', 'cmd.group.view', () => setHairline((v) => !v), { shortcut: 'TL' });
    add('split', 'cmd.split', 'cmd.group.view', toggleSplit);
    add('theme-light', 'cmd.themeLight', 'cmd.group.settings', () => setThemePreference('light'));
    add('theme-dark', 'cmd.themeDark', 'cmd.group.settings', () => setThemePreference('dark'));
    add('theme-system', 'cmd.themeSystem', 'cmd.group.settings', () => setThemePreference('system'));
    add('lang-ru', 'cmd.langRu', 'cmd.group.settings', () => setLocale('ru'), { disabled: locale === 'ru' });
    add('lang-en', 'cmd.langEn', 'cmd.group.settings', () => setLocale('en'), { disabled: locale === 'en' });
    return out;
  };

  return (
    <div className={`app${onboarding ? ' app--onboarding' : ''}`}>
      <header className="topbar">
        <div className="topbar-doc">
          <div className="brand">APEX</div>
          <div className="file-actions">
            <div className="file-actions-group" data-group="history">
              <button
                type="button"
                onClick={onUndo}
                disabled={!scene?.can_undo}
                title={t('chrome.undoTitle')}
                data-testid="undo"
              >
                {t('chrome.undo')}
              </button>
              <button
                type="button"
                onClick={onRedo}
                disabled={!scene?.can_redo}
                title={t('chrome.redoTitle')}
                data-testid="redo"
              >
                {t('chrome.redo')}
              </button>
            </div>
            <div className="file-actions-group" data-group="document">
              <FileMenu
                dirty={projectDirty}
                onNew={onNewProject}
                onOpen={onRequestOpenProject}
                onSave={onSaveProject}
                onSaveAs={onSaveProjectAs}
              >
                {exporters.map((exporter) => (
                  <button
                    key={exporter.id}
                    type="button"
                    data-testid={`export-${exporter.id}`}
                    title={exporterDisplayTitle(exporter)}
                    onClick={() => {
                      try {
                        const text = exporter.export();
                        downloadText(exporter.filename, text, 'application/octet-stream');
                        setError(null);
                      } catch (err) {
                        setError(err instanceof Error ? err.message : String(err));
                      }
                    }}
                  >
                    {exporterDisplayLabel(exporter)}
                  </button>
                ))}
              </FileMenu>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept={['application/json', '.json', ...importers.map((i) => i.accept)].join(',')}
              hidden
              aria-label={t('chrome.openFile')}
              title={t('chrome.openFileTitle')}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) onOpenProjectFile(file);
              }}
            />
          </div>
          <div className="topbar-end">
            <SettingsMenu
              debug={debugInfo}
              onToggleDebug={() =>
                setDebugInfo((v) => {
                  try {
                    localStorage.setItem('apex.debug', v ? '0' : '1');
                  } catch {
                    /* ignore */
                  }
                  return !v;
                })
              }
            >
                <AgentBridgeControl
                  onModelChanged={(fit) => {
                    applyScene(apexGetScene(), fit);
                    syncCatalog();
                  }}
                  screenshot={async () => {
                    const r = rendererRef.current;
                    if (!r) throw new Error('no 3D viewport is open');
                    return r.snapshotDataUrl();
                  }}
                />
                <KernelToggle key={kernelEpoch} onScene={(next) => applyScene(next)} />
            </SettingsMenu>
          </div>
        </div>
        <ToolsToolbar
          tools={tools}
          activeToolId={toolId}
          onActivateTool={activateTool}
          selectedCount={selectedIds.length}
          modifyExtra={attachToolbar}
          onOpenPalette={() => setPaletteOpen(true)}
          view={{
            viewNavigation,
            onSetViewNavigation: setViewNavigationMode,
            onFitView: fitView,
            hairline,
            onToggleHairline: () => setHairline((v) => !v),
          }}
        />
        <ContextBar
          tool={tool}
          drawMode={drawMode}
          onActivateDrawMode={activateDrawMode}
          components={components}
          species={contextSpecies}
          profiles={profiles}
          draft={placementDraft}
          selectedCount={selectedIds.length}
          statusText={statusText}
          notice={Boolean(info)}
        />
      </header>
      <CommandPalette
        open={paletteOpen}
        commands={paletteOpen ? paletteCommands() : []}
        onClose={() => {
          setPaletteOpen(false);
          queueMicrotask(() => focusViewportCanvas());
        }}
      />

      {!isMobile && sidebar.collapsed ? (
        <aside className="sidebar sidebar--collapsed" data-testid="sidebar" data-collapsed="true">
          <button
            type="button"
            className="sidebar-rail-btn"
            data-testid="sidebar-expand"
            title={t('sidebar.expand')}
            aria-label={t('sidebar.expand')}
            onClick={toggleSidebar}
          >
            »
          </button>
          {(['views', 'model', 'genera'] as const).map((id) => (
            <button
              key={id}
              type="button"
              className={`sidebar-rail-btn sidebar-rail-tab${sidebar.tab === id ? ' active' : ''}`}
              data-testid={`sidebar-rail-${id}`}
              title={t(`sidebar.tab.${id}`)}
              onClick={() => setSidebarTab(id)}
            >
              {t(`sidebar.tab.${id}`)}
            </button>
          ))}
        </aside>
      ) : null}
      {!isMobile && !sidebar.collapsed ? (
        <aside className="sidebar" data-testid="sidebar" style={{ width: sidebar.width }}>
          <div
            className="sidebar-resize"
            role="separator"
            aria-orientation="vertical"
            aria-label={t('sidebar.resize')}
            data-testid="sidebar-resize"
            onPointerDown={startSidebarResize}
            onDoubleClick={() => updateSidebar({ width: 248 })}
          />
          <ProjectBrowser
            tab={sidebar.tab}
            onTabChange={setSidebarTab}
            onCollapse={toggleSidebar}
            levelsSlot={
              <LevelList
                levels={levels}
                activeLevelId={scene?.active_level_id ?? null}
                selectedLevelId={selectedLevel?.id ?? null}
                onSelect={onSelectLevel}
                onCreate={onCreateLevel}
              />
            }
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
        {!ready && !error && <div className="loading">{t('chrome.loading')}</div>}
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
                setShowGettingStarted(false);
                setInfo(t('chrome.sampleLoaded'));
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
                selectedIds={scene?.selected_ids}
              />
              {/* Main WebGL canvas first so harnesses using querySelector('canvas') stay valid. */}
              <canvas
                ref={canvasRef}
                data-testid="viewport-canvas"
                tabIndex={-1}
                onClick={onCanvasClick}
                onDoubleClick={onCanvasDoubleClick}
                onContextMenu={(e) => e.preventDefault()}
                onPointerDown={onCanvasPointerDown}
                onPointerEnter={onCanvasPointerEnter}
                onPointerMove={onCanvasPointerMove}
                onPointerUp={onCanvasPointerUp}
                onPointerCancel={onCanvasPointerUp}
                onPointerLeave={onCanvasPointerLeave}
              />
              <ViewCube
                renderer={ready ? rendererRef.current : null}
                visible={ready && viewNavigation === '3d'}
              />
              <ViewPill
                viewNavigation={viewNavigation}
                projection={projection}
                onSetViewNavigation={setViewNavigationMode}
                onSetProjection={setProjectionMode}
                onFitView={fitView}
              />
            </>
          }
          splitViewport={
            <canvas
              ref={canvasSplitRef}
              className="view-canvas-split"
              aria-label={t('chrome.secondaryView')}
            />
          }
        />
        {isMobile ? (
          <button
            type="button"
            className="mobile-menu-fab"
            onClick={() => openMobileMenu()}
            title={t('chrome.menuTitle')}
            aria-label={t('chrome.menuTitle')}
          >
            {t('chrome.menu')}
          </button>
        ) : null}
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
                tab={sidebar.tab}
                onTabChange={setSidebarTab}
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
          <div className="panel-title">{t('panel.properties')}</div>
          {inspector}
        </aside>
      ) : null}

      <StatusBar
        levelName={activeLevel?.name ?? '—'}
        snapKind={snapStatus}
        snaps={snapFilter}
        onToggleSnap={toggleSnap}
        hairline={hairline}
        onToggleHairline={() => setHairline((v) => !v)}
        debug={debugInfo ? { fps, version: scene?.version ?? 0 } : null}
        compact={isMobile}
      />
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
