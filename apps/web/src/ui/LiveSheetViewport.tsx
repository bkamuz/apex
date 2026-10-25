import { useEffect, useRef } from 'react';
import type { SceneDto, SheetViewportDto, ViewDto } from '../types';
import { ViewportRenderer } from '../viewport/ViewportRenderer';
import { applyViewToRenderer, findView } from './viewModel';
import { viewAnnotationSegments } from './viewAnnotationSegments';

interface Props {
  scene: SceneDto;
  view: ViewDto;
  viewport: SheetViewportDto;
  syncScene: (renderer: ViewportRenderer, scene: SceneDto, viewId: string) => void;
  activated?: boolean;
  onActivate?: () => void;
  onDeactivate?: () => void;
}

export function LiveSheetViewport({
  scene,
  view,
  viewport,
  syncScene,
  activated = false,
  onActivate,
  onDeactivate,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<ViewportRenderer | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!rendererRef.current) {
      rendererRef.current = new ViewportRenderer(canvas);
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
    applyViewToRenderer(view, renderer);
    if (viewport.camera) {
      renderer.setCamera({
        target: viewport.camera.target,
        distance: viewport.camera.distance,
        yaw: viewport.camera.yaw,
        pitch: viewport.camera.pitch,
      });
    }
    renderer.setViewAnnotationOverlays(viewAnnotationSegments(scene, view.id));
    renderer.setTouchOrbitEnabled(activated && !viewport.lock_navigation);
  }, [activated, scene, syncScene, view, viewport.camera, viewport.lock_navigation]);

  return (
    <canvas
      ref={canvasRef}
      tabIndex={activated ? 0 : -1}
      className={`sheet-viewport-canvas${activated ? ' sheet-viewport-canvas--active' : ''}`}
      data-testid={`live-viewport-${viewport.id}`}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onActivate?.();
        canvasRef.current?.focus();
      }}
      onPointerDown={(e) => {
        if (activated && e.target === canvasRef.current) {
          e.stopPropagation();
        }
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onDeactivate?.();
      }}
    />
  );
}

export function resolveView(scene: SceneDto, viewId: string): ViewDto | undefined {
  return findView(scene, viewId);
}
