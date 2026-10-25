import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SceneDto, SheetDto, SheetViewportDto, StoredCameraDto, VectorDrawing2d } from '../types';
import { apexExportSheetDxf, apexExportSheetVector } from '../wasm/apex';
import { exportSheetSvgFromDrawing } from './sheetExport';
import { downloadTextFile, openSvgForPrint } from './vectorExport';
import { LiveSheetViewport, resolveView } from './LiveSheetViewport';
import type { ViewportRenderer } from '../viewport/ViewportRenderer';

interface Props {
  sheet: SheetDto;
  scene: SceneDto;
  projectTitle?: string;
  onMoveViewport: (viewportId: string, centerXmm: number, centerYmm: number) => void;
  onPlaceView: (viewId: string, centerXmm: number, centerYmm: number) => void;
  syncScene: (renderer: ViewportRenderer, scene: SceneDto, viewId: string) => void;
  onViewportStateChange: (
    viewportId: string,
    camera: StoredCameraDto | null,
    lockNavigation: boolean,
  ) => void;
}

const MM_TO_PX = 2.5;

export function SheetPaperView({
  sheet,
  scene,
  projectTitle = 'Apex Project',
  onMoveViewport,
  onPlaceView,
  syncScene,
  onViewportStateChange,
}: Props) {
  const paperRef = useRef<HTMLDivElement>(null);
  const [dragViewport, setDragViewport] = useState<string | null>(null);
  const [activatedViewportId, setActivatedViewportId] = useState<string | null>(null);

  const widthPx = sheet.width_mm * MM_TO_PX;
  const heightPx = sheet.height_mm * MM_TO_PX;

  const viewports = sheet.viewports;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setActivatedViewportId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const loadSheetDrawing = useCallback((): VectorDrawing2d | null => {
    try {
      const json = apexExportSheetVector(sheet.id);
      return JSON.parse(json) as VectorDrawing2d;
    } catch {
      return null;
    }
  }, [sheet.id]);

  const onExportSvg = useCallback(() => {
    const drawing = loadSheetDrawing();
    if (!drawing) return;
    const svg = exportSheetSvgFromDrawing(sheet.number, drawing);
    downloadTextFile(`${sheet.number.replace(/\s+/g, '_')}.svg`, svg, 'image/svg+xml');
  }, [loadSheetDrawing, sheet.number]);

  const onExportDxf = useCallback(() => {
    try {
      const dxf = apexExportSheetDxf(sheet.id);
      downloadTextFile(`${sheet.number.replace(/\s+/g, '_')}.dxf`, dxf, 'application/dxf');
    } catch {
      /* ignore */
    }
  }, [sheet.id, sheet.number]);

  const onExportPdf = useCallback(() => {
    const drawing = loadSheetDrawing();
    if (!drawing) return;
    const svg = exportSheetSvgFromDrawing(sheet.number, drawing);
    openSvgForPrint(svg);
  }, [loadSheetDrawing, sheet.number]);

  const clientToMm = useCallback(
    (clientX: number, clientY: number): [number, number] | null => {
      const el = paperRef.current;
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      const xPx = clientX - rect.left;
      const yPx = clientY - rect.top;
      const xMm = xPx / MM_TO_PX;
      const yMm = sheet.height_mm - yPx / MM_TO_PX;
      return [xMm, yMm];
    },
    [sheet.height_mm],
  );

  const onDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('application/x-apex-view-id')) {
      e.preventDefault();
    }
  };

  const onDrop = (e: React.DragEvent) => {
    const viewId = e.dataTransfer.getData('application/x-apex-view-id');
    if (!viewId) return;
    e.preventDefault();
    const mm = clientToMm(e.clientX, e.clientY);
    if (!mm) return;
    onPlaceView(viewId, mm[0], mm[1]);
  };

  const viewportNodes = useMemo(
    () =>
      viewports.map((vp) => (
        <SheetViewportFrame
          key={vp.id}
          viewport={vp}
          sheet={sheet}
          scene={scene}
          mmToPx={MM_TO_PX}
          dragging={dragViewport === vp.id}
          activated={activatedViewportId === vp.id}
          dimmed={activatedViewportId !== null && activatedViewportId !== vp.id}
          onDragStart={() => {
            if (activatedViewportId) return;
            setDragViewport(vp.id);
          }}
          onDragEnd={() => setDragViewport(null)}
          onMove={(cx, cy) => onMoveViewport(vp.id, cx, cy)}
          clientToMm={clientToMm}
          syncScene={syncScene}
          onActivate={() => setActivatedViewportId(vp.id)}
          onDeactivate={(camera) => {
            setActivatedViewportId(null);
            onViewportStateChange(vp.id, camera, true);
          }}
        />
      )),
    [
      activatedViewportId,
      clientToMm,
      dragViewport,
      onMoveViewport,
      onViewportStateChange,
      scene,
      sheet,
      syncScene,
      viewports,
    ],
  );

  return (
    <div className="sheet-workspace" data-testid="sheet-workspace">
      <div className="sheet-toolbar">
        <span>
          {sheet.number} — {sheet.name} ({sheet.paper} {sheet.orientation})
        </span>
        <button type="button" data-testid="export-sheet-svg" onClick={onExportSvg}>
          Export SVG
        </button>
        <button type="button" data-testid="export-sheet-dxf" onClick={onExportDxf}>
          Export DXF
        </button>
        <button type="button" data-testid="export-sheet-pdf" onClick={onExportPdf}>
          Export PDF
        </button>
      </div>
      <div className="sheet-scroll shell-scroll">
        <div
          ref={paperRef}
          className="sheet-paper"
          style={{ width: widthPx, height: heightPx }}
          onDragOver={onDragOver}
          onDrop={onDrop}
          onPointerDown={() => setActivatedViewportId(null)}
        >
          {activatedViewportId ? <div className="sheet-viewport-dim" aria-hidden="true" /> : null}
          <div className="sheet-title-block">
            <strong>{projectTitle}</strong>
            <div>
              {sheet.number} · {sheet.name}
            </div>
          </div>
          {viewportNodes}
        </div>
      </div>
    </div>
  );
}

function SheetViewportFrame({
  viewport,
  sheet,
  scene,
  mmToPx,
  dragging,
  activated,
  dimmed,
  onDragStart,
  onDragEnd,
  onMove,
  clientToMm,
  syncScene,
  onActivate,
  onDeactivate,
}: {
  viewport: SheetViewportDto;
  sheet: SheetDto;
  scene: SceneDto;
  mmToPx: number;
  dragging: boolean;
  activated: boolean;
  dimmed: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onMove: (centerXmm: number, centerYmm: number) => void;
  clientToMm: (clientX: number, clientY: number) => [number, number] | null;
  syncScene: (renderer: ViewportRenderer, scene: SceneDto, viewId: string) => void;
  onActivate: () => void;
  onDeactivate: (camera: StoredCameraDto | null) => void;
}) {
  const view = resolveView(scene, viewport.view_id);
  const left = (viewport.center_x_mm - viewport.width_mm / 2) * mmToPx;
  const top = (sheet.height_mm - (viewport.center_y_mm + viewport.height_mm / 2)) * mmToPx;
  const w = viewport.width_mm * mmToPx;
  const h = viewport.height_mm * mmToPx;
  const rendererRef = useRef<ViewportRenderer | null>(null);

  return (
    <div
      className={`sheet-viewport${dragging ? ' sheet-viewport--drag' : ''}${dimmed ? ' sheet-viewport--dimmed' : ''}${activated ? ' sheet-viewport--active' : ''}`}
      style={{ left, top, width: w, height: h }}
      onPointerDown={(e) => {
        e.stopPropagation();
        if (activated) return;
        if (e.button !== 0) return;
        onDragStart();
        const start = clientToMm(e.clientX, e.clientY);
        if (!start) return;
        const offsetX = start[0] - viewport.center_x_mm;
        const offsetY = start[1] - viewport.center_y_mm;
        const onMoveEv = (ev: PointerEvent) => {
          const mm = clientToMm(ev.clientX, ev.clientY);
          if (!mm) return;
          onMove(mm[0] - offsetX, mm[1] - offsetY);
        };
        const onUp = () => {
          onDragEnd();
          window.removeEventListener('pointermove', onMoveEv);
          window.removeEventListener('pointerup', onUp);
        };
        window.addEventListener('pointermove', onMoveEv);
        window.addEventListener('pointerup', onUp);
      }}
    >
      {view ? (
        <LiveSheetViewport
          scene={scene}
          view={view}
          viewport={viewport}
          syncScene={(renderer, next, viewId) => {
            rendererRef.current = renderer;
            syncScene(renderer, next, viewId);
          }}
          activated={activated}
          onActivate={onActivate}
          onDeactivate={() => {
            const cam = rendererRef.current?.getCamera();
            onDeactivate(
              cam
                ? {
                    target: cam.target,
                    distance: cam.distance,
                    yaw: cam.yaw,
                    pitch: cam.pitch,
                  }
                : null,
            );
          }}
        />
      ) : (
        <div className="sheet-viewport-placeholder">Viewport</div>
      )}
      <div className="sheet-viewport-label">
        {view?.name ?? 'View'} · 1:{Math.round(view?.settings.scale ?? 100)}
        {activated ? ' · editing (Esc to exit)' : ' · double-click to edit'}
      </div>
    </div>
  );
}
