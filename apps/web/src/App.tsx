import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  apexAbortUndoGroup,
  apexBeginUndoGroup,
  apexCopySelection,
  apexCreateElement,
  apexCreateElementWithParent,
  apexCreateLevel,
  apexCreateConstructionLine,
  apexCreateGridAxis,
  apexCreateReference,
  apexCreateSectionCut,
  apexDeleteSelected,
  apexDeleteSelectedConstructionLine,
  apexDeleteSelectedGridAxis,
  apexDeleteSelectedReference,
  apexDeleteSelectedSectionCut,
  apexGetSelectedConstructionLine,
  apexGetSelectedGridAxis,
  apexGetSelectedReference,
  apexGetSelectedSectionCut,
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
  apexRegisterProfile,
  apexSelectElement,
  apexSelectConstructionLine,
  apexSelectGridAxis,
  apexSelectReference,
  apexSelectSectionCut,
  apexSetConstructionLinePlacement,
  apexSetGridAxisPlacement,
  apexSetReferencePlacement,
  apexSetSectionCutPlacement,
  apexUpdateConstructionLine,
  apexUpdateGridAxis,
  apexUpdateSectionCut,
  apexSetActiveLevel,
  apexSetElementPlacement,
  apexSetLevelElevation,
  apexTogglePickById,
  apexToggleSelectElement,
  apexTranslateSelection,
  apexUndo,
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
} from './types';
import { GridAxisLabels } from './ui/GridAxisLabels';
import { LevelList } from './ui/LevelList';
import { MobileMenuSheet, type MobileMenuTab } from './ui/MobileMenuSheet';
import { ProfileEditor } from './ui/ProfileEditor';
import { ProjectBrowser } from './ui/ProjectBrowser';
import { PropertiesPanel } from './ui/PropertiesPanel';
import { ToolsToolbar } from './ui/ToolsToolbar';
import { defaultNewProfile, defaultPlacementParams, nextProfileId } from './ui/profileModel';
import { clearStoredProject, downloadText, loadStoredProject, storeProject } from './persist';
import { useMediaQuery } from './hooks/useMediaQuery';
import { ToolRegistry } from './tools/registry';
import { finishOpenGesture } from './tools/placementTool';
import { requiredPoints, type PointerInfo, type ToolContext } from './tools/Tool';
import {
  translatedAnchors,
  type TransformMode,
  type TransformOriginal,
} from './tools/transformTypes';
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

function applyTransformPlacements(
  originals: TransformOriginal[],
  delta: Vec3 | null,
  recordHistory: boolean,
): SceneDto | null {
  let scene: SceneDto | null = null;
  for (const original of originals) {
    const anchors = delta ? translatedAnchors(original.anchors, delta) : original.anchors;
    switch (original.kind) {
      case 'element':
        scene = apexSetElementPlacement(original.id, anchors, 0, recordHistory);
        break;
      case 'reference':
        scene = apexSetReferencePlacement(original.id, anchors, 0, recordHistory);
        break;
      case 'grid_axis':
        scene = apexSetGridAxisPlacement(original.id, anchors, 0, recordHistory);
        break;
      case 'construction_line':
        scene = apexSetConstructionLinePlacement(original.id, anchors, 0, recordHistory);
        break;
      case 'section_cut':
        scene = apexSetSectionCutPlacement(original.id, anchors, 0, recordHistory);
        break;
      default: {
        const exhaustive: never = original.kind;
        return exhaustive;
      }
    }
  }
  return scene;
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
  const selectedReferenceRef = useRef<ReferenceDto | null>(null);
  const selectedGridAxisRef = useRef<GridAxisDto | null>(null);
  const selectedConstructionLineRef = useRef<ConstructionLineDto | null>(null);
  const selectedSectionCutRef = useRef<SectionCutDto | null>(null);
  const selectedCountRef = useRef(0);
  const activeElevationRef = useRef(0);
  const suppressClickRef = useRef(false);
  /** True only after App claims LMB capture for a tool gesture — not camera buttons. */
  const appPointerCaptureRef = useRef(false);
  const draggingRef = useRef(false);
  const placementParamsRef = useRef<Record<string, ParamValue>>({});

  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [components, setComponents] = useState<ComponentDto[]>([]);
  const [exporters, setExporters] = useState(() => exporterRegistry.list());
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
  const sceneRef = useRef<SceneDto | null>(null);
  const [selected, setSelected] = useState<ElementDto | null>(null);
  const [selectedReference, setSelectedReference] = useState<ReferenceDto | null>(null);
  const [selectedGridAxis, setSelectedGridAxis] = useState<GridAxisDto | null>(null);
  const [selectedConstructionLine, setSelectedConstructionLine] =
    useState<ConstructionLineDto | null>(null);
  const [selectedSectionCut, setSelectedSectionCut] = useState<SectionCutDto | null>(null);
  const [selectedLevelId, setSelectedLevelId] = useState<string | null>(null);
  const [pending, setPending] = useState<Vec3[]>([]);
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

  const syncEditGizmo = useCallback(
    (
      el: ElementDto | null,
      ref: ReferenceDto | null,
      axis: GridAxisDto | null,
      line: ConstructionLineDto | null = null,
      cut: SectionCutDto | null = null,
    ) => {
      const anchors = el?.anchors?.length
        ? el.anchors
        : ref?.anchors?.length
          ? ref.anchors
          : axis?.anchors?.length
            ? axis.anchors
            : line?.anchors?.length
              ? line.anchors
              : cut?.anchors?.length
                ? cut.anchors
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
        syncReferenceGizmos(next.references ?? []);
        syncGridAxisGizmos(next.grid_axes ?? []);
        syncConstructionLineOverlays(next.construction_lines ?? []);
        syncSectionCutOverlays(next.section_cuts ?? []);
      }
      setComponents(apexListComponents());
      const sel = apexGetSelected();
      const selRef = apexGetSelectedReference();
      const selAxis = apexGetSelectedGridAxis();
      const selLine = apexGetSelectedConstructionLine();
      const selCut = apexGetSelectedSectionCut();
      setSelected(sel);
      setSelectedReference(selRef);
      setSelectedGridAxis(selAxis);
      setSelectedConstructionLine(selLine);
      setSelectedSectionCut(selCut);
      if (sel) setSelectedLevelId(sel.level_id);
      else if (selRef) setSelectedLevelId(selRef.level_id);
      else if (selAxis) setSelectedLevelId(selAxis.level_id);
      else if (selLine) setSelectedLevelId(selLine.level_id);
      else if (selCut) setSelectedLevelId(selCut.level_id);
      if (!draggingRef.current) syncEditGizmo(sel, selRef, selAxis, selLine, selCut);
    },
    [
      syncConstructionLineOverlays,
      syncEditGizmo,
      syncGridAxisGizmos,
      syncReferenceGizmos,
      syncSectionCutOverlays,
    ],
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
            default:
              break;
          }
          return;
        }

        const pickId = renderer.pick(clientX, clientY);
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
        }
      },

      hitEditHandle: (x, y) => renderer.hitEditHandle(x, y),
      selectedAnchors: () => {
        if (selectedGridAxisRef.current) return selectedGridAxisRef.current.anchors;
        if (selectedConstructionLineRef.current)
          return selectedConstructionLineRef.current.anchors;
        if (selectedSectionCutRef.current) return selectedSectionCutRef.current.anchors;
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
        try {
          const next = applyTransformPlacements(originals, delta, false);
          if (next) {
            renderer.setScene({
              positions: toFloatArray(next.positions),
              normals: toFloatArray(next.normals),
              indices: toUint32Array(next.indices),
              pickIds: next.pick_ids,
              edgePositions: next.edge_positions ? toFloatArray(next.edge_positions) : [],
              selectedPickIds: selectedPickIds(next),
              fitCamera: false,
            });
            syncGridAxisGizmos(next.grid_axes ?? []);
            syncConstructionLineOverlays(next.construction_lines ?? []);
            syncSectionCutOverlays(next.section_cuts ?? []);
            syncReferenceGizmos(next.references ?? []);
            setScene(next);
          }
        } catch {
          /* keep dragging */
        }
      },

      commitTransform: (originals, delta, mode: TransformMode) => {
        try {
          let next: SceneDto;
          if (mode === 'move') {
            // Live preview already wrote original+delta into the document.
            // Restore captured anchors, then translate once so commit cannot
            // double-apply the delta.
            applyTransformPlacements(originals, null, false);
            next = apexTranslateSelection(delta, true);
          } else {
            next = apexCopySelection(delta);
          }
          applyScene(next);
          setError(null);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      },

      restoreTransformOriginals: (originals) => {
        try {
          const next = applyTransformPlacements(originals, null, false);
          if (next) applyScene(next);
        } catch {
          /* ignore */
        }
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
      setDrawMode(next?.getMode?.() ?? null);
      if (id === ToolRegistry.selectId) {
        syncEditGizmo(
          selectedRef.current,
          selectedReferenceRef.current,
          selectedGridAxisRef.current,
          selectedConstructionLineRef.current,
          selectedSectionCutRef.current,
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
      applyScene(apexSelectGridAxis(null));
      applyScene(apexSelectConstructionLine(null));
      applyScene(apexSelectSectionCut(null));
      applyScene(apexSelectReference(null));
    } catch {
      rendererRef.current?.setEditGizmo(null);
      setSelected(null);
      setSelectedReference(null);
      setSelectedGridAxis(null);
      setSelectedConstructionLine(null);
      setSelectedSectionCut(null);
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
      if (!typing && (e.key === 'Delete' || e.key === 'Backspace')) {
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
  }, [activateTool, applyScene, onEscape, onRedo, onUndo, profileEditor]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await initApex();
        if (cancelled) return;
        const canvas = canvasRef.current;
        if (!canvas) return;
        rendererRef.current = new ViewportRenderer(canvas);

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
    if (!ready || !scene) return;
    try {
      storeProject(apexExportProject());
    } catch {
      /* ignore */
    }
  }, [ready, scene?.version]);

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
    appPointerCaptureRef.current = true;
    e.preventDefault();
  };

  const onCanvasPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!ready || !rendererRef.current) return;
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
    try {
      const next = apexNewProject();
      clearStoredProject();
      applyScene(next, true);
      syncCatalog();
      setPlacementDraft({});
      setError(null);
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
      selectedGridAxis={selectedGridAxis}
      selectedConstructionLine={selectedConstructionLine}
      selectedSectionCut={selectedSectionCut}
      component={selectedComponent}
      profiles={profiles}
      references={scene?.references ?? []}
      selectedLevel={
        selectedIds.length === 0 &&
        !placementComponent &&
        !selectedGridAxis &&
        !selectedConstructionLine &&
        !selectedSectionCut &&
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
      onPlacementChange={onPlacementChange}
      onEditType={onEditType}
      onNewProfile={onNewProfile}
      onUpdateLevelElevation={onUpdateLevelElevation}
      onDelete={onDelete}
      onDeleteGridAxis={() => applyScene(apexDeleteSelectedGridAxis())}
      onDeleteConstructionLine={() => applyScene(apexDeleteSelectedConstructionLine())}
      onDeleteSectionCut={() => applyScene(apexDeleteSelectedSectionCut())}
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
          onActivateTool={activateTool}
          onActivateDrawMode={activateDrawMode}
          onSetProjection={setProjectionMode}
        />
        <div className="topbar-hint" data-testid="topbar-hint">
          <b>INFO</b>
          <span>{tool.hint(pending.length)}</span>
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
            profiles={profiles}
            levels={levels}
            selectedIds={selectedIds}
            selectedProfileId={profileEditor?.originalId ?? profileEditor?.profile.id ?? null}
            selectedRefId={scene?.selected_ref_id ?? null}
            selectedGridAxisId={scene?.selected_grid_axis_id ?? null}
            selectedConstructionLineId={scene?.selected_construction_line_id ?? null}
            selectedSectionCutId={scene?.selected_section_cut_id ?? null}
            onSelectInstance={(id, multi) => onSelectFromTree(id, multi)}
            onSelectReference={onSelectReferenceFromTree}
            onSelectGridAxis={onSelectGridAxisFromTree}
            onSelectConstructionLine={onSelectConstructionLineFromTree}
            onSelectSectionCut={onSelectSectionCutFromTree}
            onSelectType={onSelectType}
            onNewProfile={() => onNewProfile('wall')}
          />
        </aside>
      ) : null}

      <div className="viewport-wrap">
        {!ready && !error && <div className="loading">Loading Apex core…</div>}
        {error && <div className="error-banner">{error}</div>}
        <GridAxisLabels
          axes={scene?.grid_axes ?? []}
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
                profiles={profiles}
                levels={levels}
                selectedIds={selectedIds}
                selectedProfileId={profileEditor?.originalId ?? profileEditor?.profile.id ?? null}
                selectedRefId={scene?.selected_ref_id ?? null}
                selectedGridAxisId={scene?.selected_grid_axis_id ?? null}
                selectedConstructionLineId={scene?.selected_construction_line_id ?? null}
                selectedSectionCutId={scene?.selected_section_cut_id ?? null}
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
                onSelectType={(profileId) => {
                  onSelectType(profileId);
                  closeMobileMenu();
                }}
                onNewProfile={() => onNewProfile('wall')}
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
