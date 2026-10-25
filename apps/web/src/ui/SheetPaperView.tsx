import { useCallback, useMemo, useRef, useState } from 'react';
import type { CropUvDto, SceneDto, SheetDto, SheetViewportDto, VectorDrawing2d } from '../types';
import { apexExportSheetDxf, apexExportSheetVector } from '../wasm/apex';
import { exportSheetSvgFromDrawing } from './sheetExport';
import { downloadTextFile, openSvgForPrint } from './vectorExport';
import { LiveSheetViewport, resolveView } from './LiveSheetViewport';
import type { ViewportRenderer } from '../viewport/ViewportRenderer';
import {
  cloneCrop,
  DEFAULT_CROP_RECT,
  insertVertex,
  nearestEdgeInsertion,
  removeVertex,
  type CropUv,
} from './sheetCropModel';
import { formatViewScale, STANDARD_VIEW_SCALES } from './sheetScales';

interface Props {
  sheet: SheetDto;
  scene: SceneDto;
  projectTitle?: string;
  onMoveViewport: (viewportId: string, centerXmm: number, centerYmm: number) => void;
  onPlaceView: (viewId: string, centerXmm: number, centerYmm: number) => void;
  syncScene: (renderer: ViewportRenderer, scene: SceneDto, viewId: string) => void;
  onCropChange: (viewportId: string, crop: CropUvDto[]) => void;
  onResetCrop: (viewportId: string) => void;
  onSetViewportScale: (viewportId: string, scale: number) => void;
}

const MM_TO_PX = 2.5;
const LABEL_H = 18;

export function SheetPaperView({
  sheet,
  scene,
  projectTitle = 'Apex Project',
  onMoveViewport,
  onPlaceView,
  syncScene,
  onCropChange,
  onResetCrop,
  onSetViewportScale,
}: Props) {
  const paperRef = useRef<HTMLDivElement>(null);
  const [dragViewport, setDragViewport] = useState<string | null>(null);
  const [selectedViewportId, setSelectedViewportId] = useState<string | null>(null);
  const [customScaleDraft, setCustomScaleDraft] = useState('');

  const widthPx = sheet.width_mm * MM_TO_PX;
  const heightPx = sheet.height_mm * MM_TO_PX;
  const viewports = sheet.viewports;

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
    downloadTextFile(
      `${sheet.number.replace(/\s+/g, '_')}.svg`,
      exportSheetSvgFromDrawing(sheet.number, drawing),
      'image/svg+xml',
    );
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
    openSvgForPrint(exportSheetSvgFromDrawing(sheet.number, drawing));
  }, [loadSheetDrawing, sheet.number]);

  const clientToMm = useCallback(
    (clientX: number, clientY: number): [number, number] | null => {
      const el = paperRef.current;
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      const xMm = (clientX - rect.left) / MM_TO_PX;
      const yMm = sheet.height_mm - (clientY - rect.top) / MM_TO_PX;
      return [xMm, yMm];
    },
    [sheet.height_mm],
  );

  const onResetCropClick = useCallback(() => {
    if (!selectedViewportId) return;
    onResetCrop(selectedViewportId);
  }, [onResetCrop, selectedViewportId]);

  const selectedViewport = viewports.find((vp) => vp.id === selectedViewportId);
  const selectedView = selectedViewport
    ? resolveView(scene, selectedViewport.view_id)
    : undefined;
  const selectedScale = Math.round(selectedView?.settings.scale ?? 100);
  const scaleIsStandard = STANDARD_VIEW_SCALES.some((s) => s === selectedScale);

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
          selected={selectedViewportId === vp.id}
          onSelect={() => setSelectedViewportId(vp.id)}
          onDragStart={() => setDragViewport(vp.id)}
          onDragEnd={() => setDragViewport(null)}
          onMove={(cx, cy) => onMoveViewport(vp.id, cx, cy)}
          clientToMm={clientToMm}
          syncScene={syncScene}
          onCropChange={(crop) => onCropChange(vp.id, crop)}
        />
      )),
    [
      clientToMm,
      dragViewport,
      onCropChange,
      onMoveViewport,
      scene,
      selectedViewportId,
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
        {selectedViewportId && selectedViewport ? (
          <>
            <label className="sheet-scale-control">
              Scale
              <select
                data-testid="viewport-scale-select"
                value={scaleIsStandard ? String(selectedScale) : 'custom'}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === 'custom') return;
                  onSetViewportScale(selectedViewportId, Number(v));
                }}
              >
                {STANDARD_VIEW_SCALES.map((s) => (
                  <option key={s} value={s}>
                    {formatViewScale(s)}
                  </option>
                ))}
                <option value="custom">Custom…</option>
              </select>
            </label>
            {!scaleIsStandard || customScaleDraft ? (
              <label className="sheet-scale-control">
                Custom
                <input
                  type="number"
                  min={1}
                  step={1}
                  data-testid="viewport-scale-custom"
                  value={
                    customScaleDraft ||
                    (scaleIsStandard ? '' : String(selectedScale))
                  }
                  placeholder="1:?"
                  onChange={(e) => setCustomScaleDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter' || !selectedViewportId) return;
                    const n = Number(customScaleDraft || e.currentTarget.value);
                    if (Number.isFinite(n) && n >= 1) {
                      onSetViewportScale(selectedViewportId, n);
                      setCustomScaleDraft('');
                    }
                  }}
                />
              </label>
            ) : null}
            <button type="button" data-testid="reset-viewport-crop" onClick={onResetCropClick}>
              Reset crop
            </button>
          </>
        ) : null}
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
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes('application/x-apex-view-id')) e.preventDefault();
          }}
          onDrop={(e) => {
            const viewId = e.dataTransfer.getData('application/x-apex-view-id');
            if (!viewId) return;
            e.preventDefault();
            const mm = clientToMm(e.clientX, e.clientY);
            if (!mm) return;
            onPlaceView(viewId, mm[0], mm[1]);
          }}
          onPointerDown={() => setSelectedViewportId(null)}
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

function cropRing(viewport: SheetViewportDto): CropUv[] {
  const raw = viewport.crop_polygon;
  if (raw && raw.length >= 3) return raw.map((p) => [p[0], p[1]] as CropUv);
  return cloneCrop(DEFAULT_CROP_RECT);
}

function SheetViewportFrame({
  viewport,
  sheet,
  scene,
  mmToPx,
  dragging,
  selected,
  onSelect,
  onDragStart,
  onDragEnd,
  onMove,
  clientToMm,
  syncScene,
  onCropChange,
}: {
  viewport: SheetViewportDto;
  sheet: SheetDto;
  scene: SceneDto;
  mmToPx: number;
  dragging: boolean;
  selected: boolean;
  onSelect: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onMove: (centerXmm: number, centerYmm: number) => void;
  clientToMm: (clientX: number, clientY: number) => [number, number] | null;
  syncScene: (renderer: ViewportRenderer, scene: SceneDto, viewId: string) => void;
  onCropChange: (crop: CropUv[]) => void;
}) {
  const view = resolveView(scene, viewport.view_id);
  const left = (viewport.center_x_mm - viewport.width_mm / 2) * mmToPx;
  const top = (sheet.height_mm - (viewport.center_y_mm + viewport.height_mm / 2)) * mmToPx;
  const w = viewport.width_mm * mmToPx;
  const h = viewport.height_mm * mmToPx;
  const canvasH = Math.max(1, h - LABEL_H);
  const crop = cropRing(viewport);

  const clientToUv = (clientX: number, clientY: number, rect: DOMRect): CropUv => {
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const u = x / w;
    const v = 1 - y / canvasH;
    return [Math.min(1, Math.max(0, u)), Math.min(1, Math.max(0, v))];
  };

  const commitCrop = (next: CropUv[]) => {
    onCropChange(next);
  };

  return (
    <div
      className={`sheet-viewport${dragging ? ' sheet-viewport--drag' : ''}${selected ? ' sheet-viewport--selected' : ''}`}
      style={{ left, top, width: w, height: h }}
      onPointerDown={(e) => {
        e.stopPropagation();
        onSelect();
        if ((e.target as HTMLElement).closest('.sheet-crop-handle, .sheet-crop-edge-add')) return;
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
      <div className="sheet-viewport-body" style={{ height: canvasH }}>
        {view ? (
          <LiveSheetViewport scene={scene} view={view} viewport={viewport} syncScene={syncScene} />
        ) : (
          <div className="sheet-viewport-placeholder">Viewport</div>
        )}
        {selected ? (
          <svg className="sheet-crop-overlay" width={w} height={canvasH}>
            <polygon
              points={crop
                .map(([u, v]) => `${u * w},${(1 - v) * canvasH}`)
                .join(' ')}
              fill="none"
              stroke="#2563eb"
              strokeWidth={1.5}
              strokeDasharray="4 3"
            />
            {crop.map(([u, v], i) => (
              <circle
                key={`v-${i}`}
                className="sheet-crop-handle"
                cx={u * w}
                cy={(1 - v) * canvasH}
                r={5}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  const rect = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
                  const dragIndex = i;
                  const onMoveEv = (ev: PointerEvent) => {
                    const uv = clientToUv(ev.clientX, ev.clientY, rect);
                    const next = cloneCrop(crop);
                    next[dragIndex] = uv;
                    commitCrop(next);
                  };
                  const onUp = () => {
                    window.removeEventListener('pointermove', onMoveEv);
                    window.removeEventListener('pointerup', onUp);
                  };
                  window.addEventListener('pointermove', onMoveEv);
                  window.addEventListener('pointerup', onUp);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const next = removeVertex(crop, i);
                  if (next) commitCrop(next);
                }}
              />
            ))}
            {crop.map((_, i) => {
              const j = (i + 1) % crop.length;
              const a = crop[i]!;
              const b = crop[j]!;
              const mx = ((a[0] + b[0]) / 2) * w;
              const my = (1 - (a[1] + b[1]) / 2) * canvasH;
              return (
                <text
                  key={`add-${i}`}
                  className="sheet-crop-edge-add"
                  x={mx}
                  y={my}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fontSize={12}
                  fill="#2563eb"
                  style={{ cursor: 'pointer' }}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    const rect = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
                    const uv = clientToUv(e.clientX, e.clientY, rect);
                    const ins = nearestEdgeInsertion(crop, uv[0], uv[1]);
                    if (ins) commitCrop(insertVertex(crop, ins.index, ins.point));
                  }}
                >
                  +
                </text>
              );
            })}
          </svg>
        ) : null}
      </div>
      <div className="sheet-viewport-label" data-testid={`viewport-title-${viewport.id}`}>
        {view?.name ?? 'View'} · {formatViewScale(view?.settings.scale ?? 100)}
        {selected ? ' · drag vertices · dbl-click + on edge · right-click remove' : ''}
      </div>
    </div>
  );
}
