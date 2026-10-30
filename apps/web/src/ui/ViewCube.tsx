import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import type { ViewportRenderer } from '../viewport/ViewportRenderer';
import {
  FACE_LABEL,
  easeOutCubic,
  lerp,
  lerpAngle,
  orientationForHit,
  pickViewCube,
  projectViewCube,
  type ViewCubeHit,
} from '../viewport/viewCube';

const SIZE = 100;
const DRAG_THRESHOLD_PX = 4;
const ANIM_MS = 240;

export interface ViewCubeProps {
  renderer: ViewportRenderer | null;
  /** Hidden in plan navigation and when the renderer is unavailable. */
  visible: boolean;
}

/**
 * BIM/CAD view cube: click faces/edges/corners to snap orientation; drag to orbit.
 * Overlay only — uses ViewportRenderer.getCamera / setCamera / orbitByDelta.
 */
export function ViewCube({ renderer, visible }: ViewCubeProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
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
    if (!visible || !renderer) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(SIZE * dpr);
    canvas.height = Math.round(SIZE * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    let frame = 0;
    const tick = () => {
      const cam = renderer.getCamera();
      drawCube(ctx, cam.yaw, cam.pitch, hitRef.current);
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

  const animateTo = (yaw: number, pitch: number) => {
    cancelAnim();
    const start = renderer.getCamera();
    const t0 = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / ANIM_MS);
      const e = easeOutCubic(t);
      renderer.setCamera({
        yaw: lerpAngle(start.yaw, yaw, e),
        pitch: lerp(start.pitch, pitch, e),
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
    const x = ((e.clientX - rect.left) / rect.width) * SIZE;
    const y = ((e.clientY - rect.top) / rect.height) * SIZE;
    return { x, y };
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    cancelAnim();
    const { x, y } = localPoint(e);
    const cam = renderer.getCamera();
    const projected = projectViewCube(cam.yaw, cam.pitch, SIZE);
    const hit = pickViewCube(projected, x, y);
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
      const projected = projectViewCube(cam.yaw, cam.pitch, SIZE);
      hitRef.current = pickViewCube(projected, x, y);
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

function drawCube(
  ctx: CanvasRenderingContext2D,
  yaw: number,
  pitch: number,
  hover: ViewCubeHit | null,
): void {
  ctx.clearRect(0, 0, SIZE, SIZE);

  ctx.fillStyle = 'rgba(28, 28, 28, 0.92)';
  ctx.strokeStyle = '#3a3a3a';
  ctx.lineWidth = 1;
  ctx.fillRect(0.5, 0.5, SIZE - 1, SIZE - 1);
  ctx.strokeRect(0.5, 0.5, SIZE - 1, SIZE - 1);

  const projected = projectViewCube(yaw, pitch, SIZE);
  const hoverFace = hover?.kind === 'face' ? hover.face : null;
  const hoverFaces = new Set(
    hover?.kind === 'face'
      ? [hover.face]
      : hover?.kind === 'edge' || hover?.kind === 'corner'
        ? [...hover.faces]
        : [],
  );

  for (const f of projected.faces) {
    if (f.facing <= 0) continue;
    const [i0, i1, i2, i3] = f.indices;
    const v0 = projected.verts[i0];
    const v1 = projected.verts[i1];
    const v2 = projected.verts[i2];
    const v3 = projected.verts[i3];

    const lit = 0.55 + 0.35 * Math.max(0, f.facing);
    const active = hoverFaces.has(f.face);
    if (active && hover?.kind === 'face') {
      ctx.fillStyle = `rgba(90, 125, 78, ${0.55 + 0.25 * lit})`;
    } else if (active) {
      ctx.fillStyle = `rgba(90, 125, 78, ${0.28 + 0.2 * lit})`;
    } else {
      const g = Math.round(42 + 48 * lit);
      ctx.fillStyle = `rgb(${g}, ${g}, ${Math.round(g * 0.96)})`;
    }

    ctx.beginPath();
    ctx.moveTo(v0.x, v0.y);
    ctx.lineTo(v1.x, v1.y);
    ctx.lineTo(v2.x, v2.y);
    ctx.lineTo(v3.x, v3.y);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = active ? '#6f9460' : '#111';
    ctx.lineWidth = active ? 1.25 : 1;
    ctx.stroke();

    // Paint caption into the face plane (not screen-billboard) so it reads as
    // sitting on the facet — standard CAD view-cube convention.
    if (f.facing > 0.12) {
      drawFaceCaption(ctx, v0, v1, v2, v3, FACE_LABEL[f.face], active && hoverFace === f.face);
    }
  }
}

type Pt = { x: number; y: number };

const SHORT_FACE_LABEL: Record<string, string> = {
  FRONT: 'F',
  BACK: 'BK',
  RIGHT: 'R',
  LEFT: 'L',
  TOP: 'TOP',
  BOTTOM: 'BOT',
};

/**
 * Paint caption on the face: centered, rotated with the face, never mirrored.
 * Uses a pure rotation (CAD-readable) rather than a full affine face basis.
 */
function drawFaceCaption(
  ctx: CanvasRenderingContext2D,
  v0: Pt,
  v1: Pt,
  v2: Pt,
  v3: Pt,
  label: string,
  active: boolean,
): void {
  const cx = (v0.x + v1.x + v2.x + v3.x) / 4;
  const cy = (v0.y + v1.y + v2.y + v3.y) / 4;
  const e1x = (v1.x - v0.x + (v2.x - v3.x)) * 0.5;
  const e1y = (v1.y - v0.y + (v2.y - v3.y)) * 0.5;
  const e2x = (v3.x - v0.x + (v2.x - v1.x)) * 0.5;
  const e2y = (v3.y - v0.y + (v2.y - v1.y)) * 0.5;
  const len1 = Math.hypot(e1x, e1y);
  const len2 = Math.hypot(e2x, e2y);
  if (len1 < 6 && len2 < 6) return;

  // Prefer the more horizontal edge as the text baseline.
  const horiz1 = Math.abs(e1x) / (len1 || 1);
  const horiz2 = Math.abs(e2x) / (len2 || 1);
  let bx = e1x;
  let by = e1y;
  let faceW = len1;
  let faceH = len2;
  if (horiz2 > horiz1) {
    bx = e2x;
    by = e2y;
    faceW = len2;
    faceH = len1;
  }

  let angle = Math.atan2(by, bx);
  // Keep glyphs upright (never past ±90°).
  if (Math.cos(angle) < 0) angle += Math.PI;

  let fontPx = Math.max(7, Math.min(faceW * 0.36, faceH * 0.5, 12.5));

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  let draw = label;
  const fitFont = (text: string) => {
    let size = fontPx;
    ctx.font = `700 ${size}px ui-sans-serif, system-ui, sans-serif`;
    while (ctx.measureText(text).width > faceW * 0.9 && size > 6.5) {
      size -= 0.5;
      ctx.font = `700 ${size}px ui-sans-serif, system-ui, sans-serif`;
    }
    fontPx = size;
    return ctx.measureText(text).width <= faceW * 0.9;
  };
  if (!fitFont(draw)) {
    draw = SHORT_FACE_LABEL[label] ?? label.slice(0, 1);
    fitFont(draw);
  }

  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(12, 12, 12, 0.92)';
  ctx.lineWidth = Math.max(1.5, fontPx * 0.18);
  ctx.strokeText(draw, 0, 0);
  ctx.fillStyle = active ? '#e8f0e4' : '#f2f2f2';
  ctx.fillText(draw, 0, 0);
  ctx.restore();
}
