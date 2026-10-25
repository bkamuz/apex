/** Pure helpers for framing the camera to model content (plan + 3D). */

export type Vec3 = [number, number, number];

export type Aabb = { min: Vec3; max: Vec3 };

/** Default vertical FOV — keep in sync with ViewportRenderer. */
export const CAMERA_FOVY = (50 * Math.PI) / 180;

const FIT_CLAMP = 500;
const PLAN_FIT_MARGIN = 1.12;
const MIN_PLAN_DISTANCE = 4;

function clampCoord(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(-FIT_CLAMP, Math.min(FIT_CLAMP, v));
}

/** Drop non-finite coords and clamp huge helpers so fit never blows up. */
export function sanitizeAabb(aabb: Aabb | null): Aabb | null {
  if (!aabb) return null;
  const min: Vec3 = [
    clampCoord(aabb.min[0]),
    clampCoord(aabb.min[1]),
    clampCoord(aabb.min[2]),
  ];
  const max: Vec3 = [
    clampCoord(aabb.max[0]),
    clampCoord(aabb.max[1]),
    clampCoord(aabb.max[2]),
  ];
  if (min[0] > max[0] || min[1] > max[1] || min[2] > max[2]) return null;
  return { min, max };
}

/** Ortho/perspective distance so XZ content fits the viewport in plan view. */
export function planFitDistance(
  aabb: Aabb,
  aspect: number,
  fovy = CAMERA_FOVY,
  margin = PLAN_FIT_MARGIN,
): number {
  const sx = Math.max(aabb.max[0] - aabb.min[0], 0.5);
  const sz = Math.max(aabb.max[2] - aabb.min[2], 0.5);
  const tanHalf = Math.tan(fovy / 2);
  const safeAspect = Math.max(aspect, 0.05);
  const forWidth = (sx * margin) / (2 * tanHalf * safeAspect);
  const forDepth = (sz * margin) / (2 * tanHalf);
  return Math.max(forWidth, forDepth, MIN_PLAN_DISTANCE);
}

export function aabbCenter(aabb: Aabb): Vec3 {
  return [
    (aabb.min[0] + aabb.max[0]) * 0.5,
    (aabb.min[1] + aabb.max[1]) * 0.5,
    (aabb.min[2] + aabb.max[2]) * 0.5,
  ];
}

/** Perspective orbit distance for a 3D axis-aligned box. */
export function perspectiveFitDistance(aabb: Aabb, margin = 1.15): number {
  const sx = Math.max(aabb.max[0] - aabb.min[0], 0.5);
  const sy = Math.max(aabb.max[1] - aabb.min[1], 0.5);
  const sz = Math.max(aabb.max[2] - aabb.min[2], 0.5);
  const radius = Math.hypot(sx, sy, sz) * 0.5;
  return Math.max(radius * 2.6 * margin, 6);
}
