import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SceneDto, SheetDto, SheetViewportDto } from '../types';
import { exportSheetSvg } from './sheetExport';

interface Props {
  sheet: SheetDto;
  scene: SceneDto;
  projectTitle?: string;
  onMoveViewport: (viewportId: string, centerXmm: number, centerYmm: number) => void;
  onPlaceView: (viewId: string, centerXmm: number, centerYmm: number) => void;
  captureViewportImage: (viewId: string, widthPx: number, heightPx: number) => Promise<string | null>;
}

const MM_TO_PX = 2.5;

export function SheetPaperView({
  sheet,
  scene,
  projectTitle = 'Apex Project',
  onMoveViewport,
  onPlaceView,
  captureViewportImage,
}: Props) {
  const paperRef = useRef<HTMLDivElement>(null);
  const [dragViewport, setDragViewport] = useState<string | null>(null);

  const widthPx = sheet.width_mm * MM_TO_PX;
  const heightPx = sheet.height_mm * MM_TO_PX;

  const viewports = sheet.viewports;

  const onExportSvg = useCallback(async () => {
    const images = new Map<string, string>();
    for (const vp of viewports) {
      const data = await captureViewportImage(
        vp.view_id,
        Math.round(vp.width_mm * MM_TO_PX),
        Math.round(vp.height_mm * MM_TO_PX),
      );
      if (data) images.set(vp.id, data);
    }
    const svg = exportSheetSvg(sheet, scene, projectTitle, images);
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${sheet.number.replace(/\s+/g, '_')}.svg`;
    a.click();
    URL.revokeObjectURL(url);
  }, [captureViewportImage, projectTitle, scene, sheet, viewports]);

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
          onDragStart={() => setDragViewport(vp.id)}
          onDragEnd={() => setDragViewport(null)}
          onMove={(cx, cy) => onMoveViewport(vp.id, cx, cy)}
          clientToMm={clientToMm}
          captureViewportImage={captureViewportImage}
        />
      )),
    [
      captureViewportImage,
      clientToMm,
      dragViewport,
      onMoveViewport,
      scene,
      sheet,
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
      </div>
      <div className="sheet-scroll shell-scroll">
        <div
          ref={paperRef}
          className="sheet-paper"
          style={{ width: widthPx, height: heightPx }}
          onDragOver={onDragOver}
          onDrop={onDrop}
        >
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
  onDragStart,
  onDragEnd,
  onMove,
  clientToMm,
  captureViewportImage,
}: {
  viewport: SheetViewportDto;
  sheet: SheetDto;
  scene: SceneDto;
  mmToPx: number;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onMove: (centerXmm: number, centerYmm: number) => void;
  clientToMm: (clientX: number, clientY: number) => [number, number] | null;
  captureViewportImage: (viewId: string, widthPx: number, heightPx: number) => Promise<string | null>;
}) {
  const view = scene.views?.find((v) => v.id === viewport.view_id);
  const left = (viewport.center_x_mm - viewport.width_mm / 2) * mmToPx;
  const top = (sheet.height_mm - (viewport.center_y_mm + viewport.height_mm / 2)) * mmToPx;
  const w = viewport.width_mm * mmToPx;
  const h = viewport.height_mm * mmToPx;
  const [img, setImg] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void captureViewportImage(
      viewport.view_id,
      Math.max(64, Math.round(w)),
      Math.max(64, Math.round(h)),
    ).then((url) => {
      if (!cancelled) setImg(url);
    });
    return () => {
      cancelled = true;
    };
  }, [captureViewportImage, h, scene.version, viewport.view_id, w]);

  return (
    <div
      className={`sheet-viewport${dragging ? ' sheet-viewport--drag' : ''}`}
      style={{ left, top, width: w, height: h }}
      onPointerDown={(e) => {
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
      {img ? (
        <img src={img} alt="" className="sheet-viewport-img" draggable={false} />
      ) : (
        <div className="sheet-viewport-placeholder">Viewport</div>
      )}
      <div className="sheet-viewport-label">
        {view?.name ?? 'View'} · 1:{Math.round(view?.settings.scale ?? 100)}
      </div>
    </div>
  );
}
