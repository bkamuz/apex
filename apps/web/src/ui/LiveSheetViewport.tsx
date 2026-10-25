import { useEffect, useRef } from 'react';
import type { SceneDto, SheetViewportDto, ViewDto } from '../types';
import { ViewportRenderer } from '../viewport/ViewportRenderer';
import { findView } from './viewModel';
import { viewAnnotationSegments } from './viewAnnotationSegments';
import { cropToCssClipPath } from './sheetCropModel';

interface Props {
  scene: SceneDto;
  view: ViewDto;
  viewport: SheetViewportDto;
  syncScene: (renderer: ViewportRenderer, scene: SceneDto, viewId: string) => void;
}

export function LiveSheetViewport({ scene, view, viewport, syncScene }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<ViewportRenderer | null>(null);
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
      rendererRef.current = new ViewportRenderer(canvas);
      rendererRef.current.setSheetPresentation(true);
    }
    return () => {
      rendererRef.current?.dispose();
      rendererRef.current = null;
    };
  }, []);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    syncScene(renderer, scene, view.id);
    const kind = view.kind;
    const cutY = kind.kind === 'plan' ? kind.cut_height : 0;
    const scale = view.settings.scale;
    const anchorX = viewport.anchor_x_m ?? 0;
    const anchorZ = viewport.anchor_z_m ?? 0;
    renderer.setPlanCutHeight(cutY);
    renderer.setSheetPlanFrustum(
      viewport.width_mm,
      viewport.height_mm,
      scale,
      anchorX,
      anchorZ,
      cutY,
    );
    renderer.setViewAnnotationOverlays(viewAnnotationSegments(scene, view.id));
    renderer.setTouchOrbitEnabled(false);
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
    </div>
  );
}

export function resolveView(scene: SceneDto, viewId: string): ViewDto | undefined {
  return findView(scene, viewId);
}
