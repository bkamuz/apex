import { useEffect, useRef, useState } from 'react';
import type { SceneDto, SheetViewportDto, ViewDto } from '../types';
import { ViewportRenderer } from '../viewport/ViewportRenderer';
import {
  applyStoredCamera,
  findView,
  projectionFromStored,
} from './viewModel';
import { viewAnnotationSegments } from './viewAnnotationSegments';
import { cropToCssClipPath } from './sheetCropModel';
import { SheetViewAnnotationLabels } from './SheetViewAnnotationLabels';

interface Props {
  scene: SceneDto;
  view: ViewDto;
  viewport: SheetViewportDto;
  syncScene: (renderer: ViewportRenderer, scene: SceneDto, viewId: string) => void;
}

export function LiveSheetViewport({ scene, view, viewport, syncScene }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<ViewportRenderer | null>(null);
  const [renderer, setRenderer] = useState<ViewportRenderer | null>(null);
  const crop = viewport.crop_polygon?.length && viewport.crop_polygon.length >= 3
    ? viewport.crop_polygon
    : [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ];

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!rendererRef.current) {
      rendererRef.current = new ViewportRenderer(canvas, { transparentBackground: true });
      rendererRef.current.setSheetPresentation(true);
      setRenderer(rendererRef.current);
    }
    return () => {
      rendererRef.current?.dispose();
      rendererRef.current = null;
      setRenderer(null);
    };
  }, []);

  useEffect(() => {
    const r = rendererRef.current;
    if (!r) return;
    syncScene(r, scene, view.id);
    const kind = view.kind;
    r.setViewAnnotationOverlays(viewAnnotationSegments(scene, view.id));
    r.setTouchOrbitEnabled(false);
    r.setSheetPresentation(true);

    if (kind.kind === 'plan') {
      r.setViewNavigation('plan');
      r.setPlanCutHeight(kind.cut_height);
      const scale = view.settings.scale;
      r.setSheetPlanFrustum(
        viewport.width_mm,
        viewport.height_mm,
        scale,
        viewport.anchor_x_m ?? 0,
        viewport.anchor_z_m ?? 0,
        kind.cut_height,
      );
    } else if (kind.kind === 'three_d') {
      r.setViewNavigation('3d');
      r.setProjection(projectionFromStored(kind.projection));
      applyStoredCamera(r, kind.camera);
    } else if (kind.kind === 'section') {
      r.setViewNavigation('3d');
      applyStoredCamera(r, kind.camera);
    } else {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }, [scene, syncScene, view, viewport]);

  return (
    <div
      className="sheet-viewport-clip"
      style={{ clipPath: cropToCssClipPath(crop as [number, number][]) }}
    >
      <canvas
        ref={canvasRef}
        className="sheet-viewport-canvas"
        data-testid={`live-viewport-${viewport.id}`}
        onPointerDown={(e) => e.stopPropagation()}
      />
      <SheetViewAnnotationLabels scene={scene} viewId={view.id} renderer={renderer} />
    </div>
  );
}

export function resolveView(scene: SceneDto, viewId: string): ViewDto | undefined {
  return findView(scene, viewId);
}
