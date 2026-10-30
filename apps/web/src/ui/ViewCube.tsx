import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import type { ViewportRenderer } from '../viewport/ViewportRenderer';
import {
  easeOutCubic,
  lerp,
  lerpAngle,
  orientationForHit,
  pickViewCube,
  projectViewCube,
  type ViewCubeFace,
  type ViewCubeHit,
} from '../viewport/viewCube';
import { ViewCubeGl } from '../viewport/viewCubeGl';

const SIZE = 112;
const DRAG_THRESHOLD_PX = 4;
const ANIM_MS = 240;

export interface ViewCubeProps {
  renderer: ViewportRenderer | null;
  /** Hidden in plan navigation and when the renderer is unavailable. */
  visible: boolean;
}

/**
 * BIM/CAD view cube — WebGL2 textured quads (labels baked into face UV) so
 * captions stay flat on each face under perspective. Transparent hit canvas
 * shares the projected picker for faces/edges/corners + drag orbit.
 */
export function ViewCube({ renderer, visible }: ViewCubeProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glRef = useRef<ViewCubeGl | null>(null);
  const hitRef = useRef<ViewCubeHit | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    moved: boolean;
    hit: ViewCubeHit | null;
  } | null>(null);
  const animRef = useRef<number | null>(null);

  useEffect(() => {
    if (!visible) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cube: ViewCubeGl;
    try {
      cube = new ViewCubeGl(canvas);
    } catch {
      return;
    }
    glRef.current = cube;
    return () => {
      cube.dispose();
      glRef.current = null;
    };
  }, [visible]);

  useEffect(() => {
    if (!visible || !renderer) return;
    let frame = 0;
    const tick = () => {
      const cube = glRef.current;
      const canvas = canvasRef.current;
      const cam = renderer.getCamera();
      if (cube && canvas) {
        const hit = hitRef.current;
        const hover: ViewCubeFace[] =
          hit?.kind === 'face'
            ? [hit.face]
            : hit?.kind === 'edge' || hit?.kind === 'corner'
              ? [...hit.faces]
              : [];
        cube.setHoverFaces(hover);
        const w = canvas.clientWidth || SIZE;
        const h = canvas.clientHeight || SIZE;
        cube.draw(w, h, cam.yaw, cam.pitch);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [renderer, visible]);

  useEffect(() => {
    return () => {
      if (animRef.current != null) cancelAnimationFrame(animRef.current);
    };
  }, []);

  if (!visible || !renderer) return null;

  const cancelAnim = () => {
    if (animRef.current != null) {
      cancelAnimationFrame(animRef.current);
      animRef.current = null;
    }
  };

  const animateTo = (nextYaw: number, nextPitch: number) => {
    cancelAnim();
    const start = renderer.getCamera();
    const t0 = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / ANIM_MS);
      const e = easeOutCubic(t);
      renderer.setCamera({
        yaw: lerpAngle(start.yaw, nextYaw, e),
        pitch: lerp(start.pitch, nextPitch, e),
      });
      if (t < 1) {
        animRef.current = requestAnimationFrame(step);
      } else {
        animRef.current = null;
      }
    };
    animRef.current = requestAnimationFrame(step);
  };

  const localPoint = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * SIZE,
      y: ((e.clientY - rect.top) / rect.height) * SIZE,
    };
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    cancelAnim();
    const { x, y } = localPoint(e);
    const cam = renderer.getCamera();
    const hit = pickViewCube(projectViewCube(cam.yaw, cam.pitch, SIZE), x, y);
    hitRef.current = hit;
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      moved: false,
      hit,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) {
      const { x, y } = localPoint(e);
      const cam = renderer.getCamera();
      hitRef.current = pickViewCube(projectViewCube(cam.yaw, cam.pitch, SIZE), x, y);
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const dx = e.clientX - drag.lastX;
    const dy = e.clientY - drag.lastY;
    drag.lastX = e.clientX;
    drag.lastY = e.clientY;
    if (
      !drag.moved &&
      Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) >= DRAG_THRESHOLD_PX
    ) {
      drag.moved = true;
      hitRef.current = null;
    }
    if (drag.moved) {
      renderer.orbitByDelta(dx, dy);
    }
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    if (!drag.moved && drag.hit) {
      const cam = renderer.getCamera();
      const next = orientationForHit(drag.hit, cam.yaw);
      animateTo(next.yaw, next.pitch);
    }
    const { x, y } = localPoint(e);
    const cam = renderer.getCamera();
    hitRef.current = pickViewCube(projectViewCube(cam.yaw, cam.pitch, SIZE), x, y);
  };

  const onPointerLeave = () => {
    if (!dragRef.current) hitRef.current = null;
  };

  return (
    <div
      className="view-cube"
      data-testid="view-cube"
      title="View cube — click to orient, drag to orbit"
    >
      <canvas
        ref={canvasRef}
        width={SIZE}
        height={SIZE}
        aria-label="View cube"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={onPointerLeave}
        onContextMenu={(e) => e.preventDefault()}
      />
    </div>
  );
}
