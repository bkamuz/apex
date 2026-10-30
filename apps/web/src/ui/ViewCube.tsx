import { useEffect, useMemo, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import type { ViewportRenderer } from '../viewport/ViewportRenderer';
import {
  FACE_LABEL,
  easeOutCubic,
  lerp,
  lerpAngle,
  orientationForHit,
  pickViewCube,
  projectViewCube,
  type ViewCubeFace,
  type ViewCubeHit,
} from '../viewport/viewCube';

const SIZE = 100;
const DRAG_THRESHOLD_PX = 4;
const ANIM_MS = 240;
/** Face texture resolution — crisp labels under CSS 3D. */
const FACE_TEX = 128;

const FACES: readonly ViewCubeFace[] = ['front', 'back', 'right', 'left', 'top', 'bottom'];

const FACE_FILL: Record<ViewCubeFace, string> = {
  front: '#636360',
  back: '#4e4e4c',
  right: '#585856',
  left: '#585856',
  top: '#6a6a66',
  bottom: '#454543',
};

const FACE_FILL_HOVER = '#5a7d4e';

export interface ViewCubeProps {
  renderer: ViewportRenderer | null;
  /** Hidden in plan navigation and when the renderer is unavailable. */
  visible: boolean;
}

/** Bake axis-aligned caption into a square face texture (data URL). */
function bakeFaceTexture(face: ViewCubeFace, hover: boolean): string {
  const canvas = document.createElement('canvas');
  canvas.width = FACE_TEX;
  canvas.height = FACE_TEX;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.fillStyle = hover ? FACE_FILL_HOVER : FACE_FILL[face];
  ctx.fillRect(0, 0, FACE_TEX, FACE_TEX);
  ctx.strokeStyle = hover ? '#6f9460' : '#111';
  ctx.lineWidth = 3;
  ctx.strokeRect(1.5, 1.5, FACE_TEX - 3, FACE_TEX - 3);

  const label = FACE_LABEL[face];
  let fontPx = 28;
  ctx.font = `700 ${fontPx}px ui-sans-serif, system-ui, sans-serif`;
  while (ctx.measureText(label).width > FACE_TEX * 0.82 && fontPx > 14) {
    fontPx -= 1;
    ctx.font = `700 ${fontPx}px ui-sans-serif, system-ui, sans-serif`;
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(12, 12, 12, 0.92)';
  ctx.lineWidth = Math.max(3, fontPx * 0.16);
  ctx.strokeText(label, FACE_TEX / 2, FACE_TEX / 2);
  ctx.fillStyle = hover ? '#e8f0e4' : '#f2f2f2';
  ctx.fillText(label, FACE_TEX / 2, FACE_TEX / 2);
  return canvas.toDataURL('image/png');
}

/**
 * BIM/CAD view cube: CSS 3D cube with baked face textures (axis-aligned labels
 * in face UV). Pointer hit-testing keeps projected face/edge/corner pick + drag.
 */
export function ViewCube({ renderer, visible }: ViewCubeProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<HTMLDivElement>(null);
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

  const textures = useMemo(() => {
    if (typeof document === 'undefined') {
      return null;
    }
    const normal = {} as Record<ViewCubeFace, string>;
    const hover = {} as Record<ViewCubeFace, string>;
    for (const face of FACES) {
      normal[face] = bakeFaceTexture(face, false);
      hover[face] = bakeFaceTexture(face, true);
    }
    return { normal, hover };
  }, []);

  useEffect(() => {
    if (!visible || !renderer) return;
    let frame = 0;
    let lastHoverKey = '';
    const tick = () => {
      const cam = renderer.getCamera();
      const scene = sceneRef.current;
      if (scene) {
        scene.style.transform = `rotateY(${-cam.yaw}rad) rotateX(${cam.pitch}rad)`;
      }
      const root = rootRef.current;
      const hit = hitRef.current;
      let hoverKey = '';
      if (hit?.kind === 'face') hoverKey = hit.face;
      else if (hit?.kind === 'edge' || hit?.kind === 'corner') hoverKey = hit.faces.join(' ');
      if (root && hoverKey !== lastHoverKey) {
        lastHoverKey = hoverKey;
        if (hoverKey) root.setAttribute('data-hover-faces', hoverKey);
        else root.removeAttribute('data-hover-faces');
        // Swap face background images for olive hover without React state churn.
        if (textures) {
          for (const face of FACES) {
            const el = root.querySelector<HTMLElement>(`.view-cube-face--${face}`);
            if (!el) continue;
            const on = hoverKey.split(' ').includes(face);
            el.style.backgroundImage = `url(${on ? textures.hover[face] : textures.normal[face]})`;
          }
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [renderer, visible, textures]);

  useEffect(() => {
    return () => {
      if (animRef.current != null) cancelAnimationFrame(animRef.current);
    };
  }, []);

  if (!visible || !renderer || !textures) return null;

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

  const localPoint = (e: ReactPointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * SIZE,
      y: ((e.clientY - rect.top) / rect.height) * SIZE,
    };
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
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

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
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

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
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
      ref={rootRef}
      className="view-cube"
      data-testid="view-cube"
      title="View cube — click to orient, drag to orbit"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={onPointerLeave}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="view-cube-plate" aria-hidden="true">
        <div className="view-cube-perspective">
          <div ref={sceneRef} className="view-cube-scene">
            {FACES.map((face) => (
              <div
                key={face}
                className={`view-cube-face view-cube-face--${face}`}
                data-face={face}
                style={{ backgroundImage: `url(${textures.normal[face]})` }}
                aria-label={FACE_LABEL[face]}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
