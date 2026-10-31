/** Flat-buffer WebGL2 renderer — solid + CAD edges, pick by triangle id. */

import {
  aabbCenter,
  perspectiveFitDistance,
  planFitDistance,
  sanitizeAabb,
  type Aabb,
} from './fitView';

export type Vec3 = [number, number, number];

/** Consecutive point pairs for a polyline through `points`. */
function segmentsThrough(points: Vec3[]): Float32Array {
  const data = new Float32Array((points.length - 1) * 6);
  for (let i = 0; i < points.length - 1; i++) {
    data.set(points[i], i * 6);
    data.set(points[i + 1], i * 6 + 3);
  }
  return data;
}

function flatten(points: Vec3[]): Float32Array {
  const data = new Float32Array(points.length * 3);
  points.forEach((p, i) => data.set(p, i * 3));
  return data;
}

export interface SceneMeshData {
  positions: ArrayLike<number>;
  normals: ArrayLike<number>;
  indices: ArrayLike<number>;
  pickIds: ArrayLike<number>;
  edgePositions?: ArrayLike<number>;
  selectedPickIds: number[];
  /** Model-element bounds from the core (ignores huge helpers). */
  fitBounds?: { min: Vec3; max: Vec3 } | null;
  /** Pick ids for horizontal slabs/floors drawn under walls in plan. */
  slabPickIds?: number[];
  fitCamera?: boolean;
}

export interface CameraState {
  target: [number, number, number];
  distance: number;
  yaw: number;
  pitch: number;
}

export type ProjectionMode = 'perspective' | 'orthographic';

/** Scene navigation: turntable 3D vs locked top-down plan (work plane XZ, Y up). */
export type ViewNavigationMode = '3d' | 'plan';

const DEFAULT_CAMERA: CameraState = {
  target: [0, 1.2, 0],
  distance: 18,
  yaw: 0.7,
  pitch: 0.55,
};

/** Vertical FOV for perspective; also sizes the ortho frustum from `distance`. */
const CAMERA_FOVY = (50 * Math.PI) / 180;

const MMB_DBLCLICK_MS = 400;
const MMB_DBLCLICK_PX = 8;

export const GRID_STEP = 1.0;
/** Extra cells beyond scene/placement bounds when growing the ground grid. */
export const GRID_MARGIN_CELLS = 4;
const GRID_DEFAULT_HALF = 20;
/** World-space chunk length for thick lines (avoids screen-space width blow-ups). */
const MAX_THICK_SEGMENT_LEN = 48;
/**
 * Orbit pitch clamp (radians). Just shy of ±π/2 so lookAt with Y-up never
 * gimbal-flips; turntable can still go nearly top-down / under the model.
 */
const PITCH_LIMIT = Math.PI / 2 - 0.01;
/**
 * Locked Plan navigation looks straight down −Y (true orthographic top-down).
 * Must be exactly π/2 — the orbit clamp leaves a visible ~0.57° axon tilt.
 */
const PLAN_PITCH = Math.PI / 2;
/** View-up for Plan lookAt (world −Z). World Y is parallel to the view axis. */
const PLAN_UP: Vec3 = [0, 0, -1];
/** Closest wheel-zoom distance (metres). Independent of scene size so huge walls still allow mm inspection. */
const MIN_CAMERA_DISTANCE = 0.001;
/** Soft zoom-out ceiling — generous vs scene size so large models are not hard-stopped early. */
function maxCameraDistance(sceneExtent: number): number {
  return Math.max(sceneExtent * 40, 500);
}

const VERT = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in float aPick;
uniform mat4 uMVP;
uniform mat4 uModel;
uniform mat3 uNormalMat;
uniform highp int uOutlinePass; // 0=lit, 1=stencil mask, 2=expanded ring, 3=x-ray wash
uniform float uOutlinePx;
uniform vec2 uResolution;
out vec3 vNormal;
out vec3 vWorld;
flat out float vPick;
out float vGlass;
out float vGhost;
void main(){
  vec4 world = uModel * vec4(aPos, 1.0);
  vWorld = world.xyz;
  vNormal = normalize(uNormalMat * aNormal);
  // Window glass is tagged in the core with length-2 normals.
  // Ghosts (shown boolean operands, slab openings) use length-3 normals.
  float tag = length(aNormal);
  vGlass = tag > 1.5 ? 1.0 : 0.0;
  vGhost = tag > 2.5 ? 1.0 : 0.0;
  vPick = aPick;
  vec4 clip = uMVP * vec4(aPos, 1.0);
  // Screen-space expand along the projected geometric normal for the
  // outer ring of the x-ray silhouette (pass 2 only).
  if (uOutlinePass == 2 && tag > 1e-5) {
    vec3 nObj = aNormal / tag;
    vec4 clipN = uMVP * vec4(aPos + nObj, 1.0);
    float w = abs(clip.w) < 1e-6 ? 1.0 : clip.w;
    float wN = abs(clipN.w) < 1e-6 ? 1.0 : clipN.w;
    vec2 ndc = clip.xy / w;
    vec2 ndcN = clipN.xy / wN;
    vec2 dir = ndcN - ndc;
    float len = length(dir);
    if (len > 1e-8) {
      dir /= len;
      vec2 pixelToNdc = 2.0 / max(uResolution, vec2(1.0));
      clip.xy += dir * uOutlinePx * pixelToNdc * w;
    }
  }
  gl_Position = clip;
}`;

const FRAG = `#version 300 es
precision highp float;
in vec3 vNormal;
in vec3 vWorld;
flat in float vPick;
in float vGlass;
in float vGhost;
uniform int uGlassPass;
uniform vec3 uLightDir;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
uniform float uSelectedPick; // unused when count>0; kept for layout stability
uniform float uSelectedPicks[32];
uniform int uSelectedCount;
uniform float uHoverPicks[8];
uniform int uHoverCount;
uniform float uHiddenPicks[32];
uniform int uHiddenPickCount;
uniform bool uPickPass;
uniform float uPickExclude[8];
uniform int uPickExcludeCount;
uniform float uOpacity;
uniform int uSelectionMode; // 0=all, 1=opaque others, 2=selected only, 3=hover only
uniform int uPlanMode;
uniform float uCutY;
uniform float uCutFade;
uniform int uMeshLayer;
uniform int uSlabPickCount;
uniform float uSlabPicks[32];
uniform highp int uOutlinePass; // 0=lit, 1=stencil mask, 2=expanded ring, 3=x-ray wash
out vec4 outColor;

bool isSlabPick(float pick) {
  for (int i = 0; i < 32; i++) {
    if (i >= uSlabPickCount) break;
    if (abs(pick - uSlabPicks[i]) < 0.5) return true;
  }
  return false;
}

bool isSelectedPick(float pick) {
  for (int i = 0; i < 32; i++) {
    if (i >= uSelectedCount) break;
    if (abs(pick - uSelectedPicks[i]) < 0.5) return true;
  }
  return false;
}

bool isHoverPick(float pick) {
  for (int i = 0; i < 8; i++) {
    if (i >= uHoverCount) break;
    if (abs(pick - uHoverPicks[i]) < 0.5) return true;
  }
  return false;
}

bool isHiddenPick(float pick) {
  for (int i = 0; i < 32; i++) {
    if (i >= uHiddenPickCount) break;
    if (abs(pick - uHiddenPicks[i]) < 0.5) return true;
  }
  return false;
}

void main(){
  // Plan: geometry above the cut is invisible, so it must not be pickable
  // either (a roof would otherwise swallow every click inside the plan).
  if (uPlanMode != 0 && vWorld.y - uCutY > uCutFade) discard;
  // Ghost path-anchor drag: suppress live solids replaced by the ghost overlay.
  if (uHiddenPickCount > 0 && isHiddenPick(vPick)) discard;
  if (uPickPass) {
    for (int i = 0; i < 8; i++) {
      if (i >= uPickExcludeCount) break;
      if (abs(vPick - uPickExclude[i]) < 0.5) discard;
    }
    uint id = uint(vPick);
    float r = float((id >> 0u) & 255u) / 255.0;
    float g = float((id >> 8u) & 255u) / 255.0;
    float b = float((id >> 16u) & 255u) / 255.0;
    float a = float((id >> 24u) & 255u) / 255.0;
    outColor = vec4(r, g, b, a);
    return;
  }
  // X-ray silhouette: full projected shape of hover/selection (no glass split).
  if (uOutlinePass != 0) {
    bool selected = isSelectedPick(vPick);
    bool hovered = isHoverPick(vPick);
    if (!selected && !hovered) discard;
    if (uOutlinePass == 1) {
      outColor = vec4(0.0);
      return;
    }
    // Selection orange wins over hover olive when both apply.
    vec3 col = selected ? vec3(0.98, 0.62, 0.20) : vec3(0.62, 0.84, 0.30);
    if (uOutlinePass == 3) {
      // Soft body wash so buried faces still read through occluders.
      outColor = vec4(col, selected ? 0.16 : 0.14);
      return;
    }
    outColor = vec4(col, 1.0);
    return;
  }
  if ((vGlass > 0.5) != (uGlassPass == 1)) discard;
  bool selected = isSelectedPick(vPick);
  bool hovered = isHoverPick(vPick);
  if (uSelectionMode == 1 && selected) discard;
  if (uSelectionMode == 2 && !selected) discard;
  // Dedicated olive overlay pass — selection wins, so skip selected geometry.
  if (uSelectionMode == 3 && (selected || !hovered)) discard;
  bool slab = isSlabPick(vPick);
  if (uPlanMode != 0 && uMeshLayer == 1 && !slab) discard;
  if (uPlanMode != 0 && uMeshLayer == 2 && slab) discard;
  vec3 n = normalize(vNormal);
  // Two-sided: thin walls stay lit when viewed from either side.
  float ndl = abs(dot(n, normalize(uLightDir)));
  float hemi = abs(n.y) * 0.5 + 0.5;
  vec3 ambient = mix(uGroundColor, uSkyColor, hemi);
  float wrap = ndl * 0.65 + 0.35;
  // Selection: warm orange. Hover overlay (mode 3): bright olive.
  // Inline hover wash (modes 0/1) is a light tint when no overlay yet.
  bool hoverTint = !selected && hovered && uSelectionMode != 3;
  vec3 base = selected
    ? vec3(0.86, 0.52, 0.22)
    : uSelectionMode == 3
      ? vec3(0.52, 0.72, 0.28)
      : hoverTint
        ? vec3(0.48, 0.64, 0.34)
        : vec3(0.72, 0.76, 0.80);
  float alpha = uOpacity;
  if (uPlanMode != 0) {
    float above = vWorld.y - uCutY;
    if (above > uCutFade) discard;
    if (above > 0.0) {
      alpha *= 1.0 - clamp(above / max(uCutFade, 1e-4), 0.0, 0.92);
    }
    if (slab && uMeshLayer != 2) {
      alpha *= 0.34;
    }
    if (abs(vWorld.y - uCutY) < 0.12) {
      base = mix(base, vec3(0.12, 0.13, 0.15), 0.55);
    }
  }
  vec3 color = base * (ambient * 0.45 + vec3(wrap) * 0.7);
  if (uSelectionMode == 3) {
    color = mix(color, vec3(0.62, 0.86, 0.32), 0.55);
  } else if (hoverTint) {
    color = mix(color, vec3(0.58, 0.78, 0.34), 0.35);
  }
  if (uGlassPass == 1 && vGhost > 0.5) {
    // Ghost: faint warm wash so it reads as a modelling aid, not a solid.
    color = mix(vec3(0.95, 0.72, 0.38), color, selected ? 0.6 : 0.3);
    alpha *= selected ? 0.32 : 0.18;
  } else if (uGlassPass == 1) {
    if (hovered && !selected) {
      // Openings are mostly glass — need a strong olive wash or hover is invisible.
      color = mix(vec3(0.55, 0.82, 0.28), color, 0.22);
      alpha = max(alpha, 0.55) * 0.72;
    } else {
      color = mix(vec3(0.55, 0.75, 0.86), color, selected ? 0.5 : 0.15);
      alpha *= 0.28;
    }
  }
  outColor = vec4(color, alpha);
}`;

const LINE_VERT = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos0;
layout(location=1) in vec3 aPos1;
layout(location=2) in float aSide;
layout(location=3) in float aEnd;
uniform mat4 uMVP;
uniform vec2 uResolution;
uniform float uLineWidthPx;
out float vDashCoord;

void main() {
  vec4 c0 = uMVP * vec4(aPos0, 1.0);
  vec4 c1 = uMVP * vec4(aPos1, 1.0);

  // Expand in NDC, then rebuild clip. The old "offset * clip.w" path looks correct
  // for short edges, but on kilometre segments |clip.xy| is huge: float32 eats the
  // pixel offset and the ribbon rasterizes as a fat screen-space slab.
  float w0 = c0.w == 0.0 ? 1.0 : c0.w;
  float w1 = c1.w == 0.0 ? 1.0 : c1.w;
  vec2 ndc0 = c0.xy / w0;
  vec2 ndc1 = c1.xy / w1;

  vec2 ndcDir = ndc1 - ndc0;
  float ndcLen = length(ndcDir);
  vec2 dir = ndcLen > 1e-8 ? ndcDir / ndcLen : vec2(1.0, 0.0);
  vec2 perp = vec2(-dir.y, dir.x);

  vec2 ndc = mix(ndc0, ndc1, aEnd);
  float ndcZ = mix(c0.z / w0, c1.z / w1, aEnd);
  float clipW = mix(w0, w1, aEnd);

  vec2 pixelToNdc = 2.0 / max(uResolution, vec2(1.0));
  ndc += perp * aSide * (0.5 * uLineWidthPx) * pixelToNdc;

  // Screen-space arc length along the segment (for dashed occluded pass).
  vec2 pix0 = (ndc0 * 0.5 + 0.5) * uResolution;
  vec2 pix1 = (ndc1 * 0.5 + 0.5) * uResolution;
  vDashCoord = mix(0.0, length(pix1 - pix0), aEnd);

  gl_Position = vec4(ndc * clipW, ndcZ * clipW, clipW);
}`;

const LINE_FRAG = `#version 300 es
precision highp float;
in float vDashCoord;
uniform vec4 uColor;
uniform float uDashPeriodPx;
out vec4 outColor;
void main(){
  if (uDashPeriodPx > 0.5) {
    float t = mod(vDashCoord, uDashPeriodPx);
    // ~50% duty: dash then gap.
    if (t > uDashPeriodPx * 0.5) discard;
  }
  outColor = uColor;
}`;

const POINT_VERT = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
uniform mat4 uMVP;
uniform vec3 uEye;
uniform float uPointSize;
void main(){
  vec3 toEye = uEye - aPos;
  float dist = length(toEye);
  vec3 p = aPos;
  if (dist > 1e-5) {
    p += (toEye / dist) * 0.02;
  }
  gl_Position = uMVP * vec4(p, 1.0);
  gl_PointSize = uPointSize;
}`;

const POINT_FRAG = `#version 300 es
precision highp float;
uniform vec4 uColor;
out vec4 outColor;
void main(){
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  if (dot(p, p) > 1.0) discard;
  outColor = uColor;
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(info ?? 'shader compile failed');
  }
  return sh;
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const prog = gl.createProgram()!;
  const v = compile(gl, gl.VERTEX_SHADER, vs);
  const f = compile(gl, gl.FRAGMENT_SHADER, fs);
  gl.attachShader(prog, v);
  gl.attachShader(prog, f);
  gl.linkProgram(prog);
  gl.deleteShader(v);
  gl.deleteShader(f);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(prog) ?? 'link failed');
  }
  return prog;
}

function mat4Identity(): Float32Array {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

const MAT4_IDENTITY = mat4Identity();

type CameraMatrices = {
  eye: [number, number, number];
  view: Float32Array;
  proj: Float32Array;
  viewProj: Float32Array;
  viewProjInv: Float32Array;
};

type MeshUniforms = {
  uMVP: WebGLUniformLocation | null;
  uModel: WebGLUniformLocation | null;
  uNormalMat: WebGLUniformLocation | null;
  uLightDir: WebGLUniformLocation | null;
  uSkyColor: WebGLUniformLocation | null;
  uGroundColor: WebGLUniformLocation | null;
  uSelectedPick: WebGLUniformLocation | null;
  uSelectedPicks: WebGLUniformLocation | null;
  uSelectedCount: WebGLUniformLocation | null;
  uHoverPicks: WebGLUniformLocation | null;
  uHoverCount: WebGLUniformLocation | null;
  uHiddenPicks: WebGLUniformLocation | null;
  uHiddenPickCount: WebGLUniformLocation | null;
  uPickPass: WebGLUniformLocation | null;
  uPickExclude: WebGLUniformLocation | null;
  uPickExcludeCount: WebGLUniformLocation | null;
  uGlassPass: WebGLUniformLocation | null;
  uOpacity: WebGLUniformLocation | null;
  uSelectionMode: WebGLUniformLocation | null;
  uPlanMode: WebGLUniformLocation | null;
  uCutY: WebGLUniformLocation | null;
  uCutFade: WebGLUniformLocation | null;
  uMeshLayer: WebGLUniformLocation | null;
  uSlabPickCount: WebGLUniformLocation | null;
  uSlabPicks: WebGLUniformLocation | null;
  uOutlinePass: WebGLUniformLocation | null;
  uOutlinePx: WebGLUniformLocation | null;
  uResolution: WebGLUniformLocation | null;
};

type LineUniforms = {
  uMVP: WebGLUniformLocation | null;
  uResolution: WebGLUniformLocation | null;
  uLineWidthPx: WebGLUniformLocation | null;
  uColor: WebGLUniformLocation | null;
  uDashPeriodPx: WebGLUniformLocation | null;
};

type PointUniforms = {
  uMVP: WebGLUniformLocation | null;
  uEye: WebGLUniformLocation | null;
  uPointSize: WebGLUniformLocation | null;
  uColor: WebGLUniformLocation | null;
};

/** Options for thick-line draws (boolean `overlay` still accepted for call-site compat). */
type LineDrawOpts = {
  overlay?: boolean;
  /** Depth compare when depth test is on. Default LEQUAL. */
  depthFunc?: number;
  /** Screen-space dash period in CSS pixels; 0 = solid. */
  dashPeriodPx?: number;
};

function meshUniforms(gl: WebGL2RenderingContext, prog: WebGLProgram): MeshUniforms {
  return {
    uMVP: gl.getUniformLocation(prog, 'uMVP'),
    uModel: gl.getUniformLocation(prog, 'uModel'),
    uNormalMat: gl.getUniformLocation(prog, 'uNormalMat'),
    uLightDir: gl.getUniformLocation(prog, 'uLightDir'),
    uSkyColor: gl.getUniformLocation(prog, 'uSkyColor'),
    uGroundColor: gl.getUniformLocation(prog, 'uGroundColor'),
    uSelectedPick: gl.getUniformLocation(prog, 'uSelectedPick'),
    uSelectedPicks: gl.getUniformLocation(prog, 'uSelectedPicks'),
    uSelectedCount: gl.getUniformLocation(prog, 'uSelectedCount'),
    uHoverPicks: gl.getUniformLocation(prog, 'uHoverPicks'),
    uHoverCount: gl.getUniformLocation(prog, 'uHoverCount'),
    uHiddenPicks: gl.getUniformLocation(prog, 'uHiddenPicks'),
    uHiddenPickCount: gl.getUniformLocation(prog, 'uHiddenPickCount'),
    uPickPass: gl.getUniformLocation(prog, 'uPickPass'),
    uPickExclude: gl.getUniformLocation(prog, 'uPickExclude'),
    uPickExcludeCount: gl.getUniformLocation(prog, 'uPickExcludeCount'),
    uGlassPass: gl.getUniformLocation(prog, 'uGlassPass'),
    uOpacity: gl.getUniformLocation(prog, 'uOpacity'),
    uSelectionMode: gl.getUniformLocation(prog, 'uSelectionMode'),
    uPlanMode: gl.getUniformLocation(prog, 'uPlanMode'),
    uCutY: gl.getUniformLocation(prog, 'uCutY'),
    uCutFade: gl.getUniformLocation(prog, 'uCutFade'),
    uMeshLayer: gl.getUniformLocation(prog, 'uMeshLayer'),
    uSlabPickCount: gl.getUniformLocation(prog, 'uSlabPickCount'),
    uSlabPicks: gl.getUniformLocation(prog, 'uSlabPicks'),
    uOutlinePass: gl.getUniformLocation(prog, 'uOutlinePass'),
    uOutlinePx: gl.getUniformLocation(prog, 'uOutlinePx'),
    uResolution: gl.getUniformLocation(prog, 'uResolution'),
  };
}

/** Grid bubble circles are 24 segments × 2 endpoints. */
const GRID_BUBBLE_SEGMENTS = 24;
const GRID_BUBBLE_FLOATS = GRID_BUBBLE_SEGMENTS * 2 * 3;
/** Target on-screen bubble radius in CSS pixels (plan view rescale). */
const PLAN_BUBBLE_RADIUS_PX = 14;

type Saved3DView = {
  camera: CameraState;
  projection: ProjectionMode;
};

function lineUniforms(gl: WebGL2RenderingContext, prog: WebGLProgram): LineUniforms {
  return {
    uMVP: gl.getUniformLocation(prog, 'uMVP'),
    uResolution: gl.getUniformLocation(prog, 'uResolution'),
    uLineWidthPx: gl.getUniformLocation(prog, 'uLineWidthPx'),
    uColor: gl.getUniformLocation(prog, 'uColor'),
    uDashPeriodPx: gl.getUniformLocation(prog, 'uDashPeriodPx'),
  };
}

function pointUniforms(gl: WebGL2RenderingContext, prog: WebGLProgram): PointUniforms {
  return {
    uMVP: gl.getUniformLocation(prog, 'uMVP'),
    uEye: gl.getUniformLocation(prog, 'uEye'),
    uPointSize: gl.getUniformLocation(prog, 'uPointSize'),
    uColor: gl.getUniformLocation(prog, 'uColor'),
  };
}

function mat4Perspective(fovy: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fovy / 2);
  const out = new Float32Array(16);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) / (near - far);
  out[11] = -1;
  out[14] = (2 * far * near) / (near - far);
  return out;
}

function mat4Ortho(
  left: number,
  right: number,
  bottom: number,
  top: number,
  near: number,
  far: number,
): Float32Array {
  const out = new Float32Array(16);
  const rl = right - left;
  const tb = top - bottom;
  const fn = far - near;
  out[0] = 2 / rl;
  out[5] = 2 / tb;
  out[10] = -2 / fn;
  out[12] = -(right + left) / rl;
  out[13] = -(top + bottom) / tb;
  out[14] = -(far + near) / fn;
  out[15] = 1;
  return out;
}

function mat4LookAt(
  eye: [number, number, number],
  target: [number, number, number],
  up: [number, number, number],
): Float32Array {
  const eyex = eye[0],
    eyey = eye[1],
    eyez = eye[2];
  let zx = eyex - target[0];
  let zy = eyey - target[1];
  let zz = eyez - target[2];
  let len = Math.hypot(zx, zy, zz) || 1;
  zx /= len;
  zy /= len;
  zz /= len;
  let xx = up[1] * zz - up[2] * zy;
  let xy = up[2] * zx - up[0] * zz;
  let xz = up[0] * zy - up[1] * zx;
  len = Math.hypot(xx, xy, xz) || 1;
  xx /= len;
  xy /= len;
  xz /= len;
  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;
  const out = new Float32Array(16);
  out[0] = xx;
  out[1] = yx;
  out[2] = zx;
  out[3] = 0;
  out[4] = xy;
  out[5] = yy;
  out[6] = zy;
  out[7] = 0;
  out[8] = xz;
  out[9] = yz;
  out[10] = zz;
  out[11] = 0;
  out[12] = -(xx * eyex + xy * eyey + xz * eyez);
  out[13] = -(yx * eyex + yy * eyey + yz * eyez);
  out[14] = -(zx * eyex + zy * eyey + zz * eyez);
  out[15] = 1;
  return out;
}

function mat4Multiply(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      out[j * 4 + i] =
        a[i] * b[j * 4] + a[4 + i] * b[j * 4 + 1] + a[8 + i] * b[j * 4 + 2] + a[12 + i] * b[j * 4 + 3];
    }
  }
  return out;
}

/** Axis-aligned grid covering [minX,maxX] × [minZ,maxZ] at elevation y. */
function buildGridRect(
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number,
  step: number,
  y = 0,
): Float32Array {
  const x0 = Math.floor(minX / step) * step;
  const x1 = Math.ceil(maxX / step) * step;
  const z0 = Math.floor(minZ / step) * step;
  const z1 = Math.ceil(maxZ / step) * step;
  const lines: number[] = [];
  for (let z = z0; z <= z1 + step * 0.5; z += step) {
    lines.push(x0, y, z, x1, y, z);
  }
  for (let x = x0; x <= x1 + step * 0.5; x += step) {
    lines.push(x, y, z0, x, y, z1);
  }
  return new Float32Array(lines);
}

/** Closed rectangle outline on the level plane (matches grid bounds). */
function buildRectContour(
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number,
  y: number,
): Float32Array {
  return new Float32Array([
    minX, y, minZ, maxX, y, minZ,
    maxX, y, minZ, maxX, y, maxZ,
    maxX, y, maxZ, minX, y, maxZ,
    minX, y, maxZ, minX, y, minZ,
  ]);
}

function distPointToSegment2d(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-12) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export interface ReferencePickTarget {
  id: string;
  gizmo_segments: Vec3[];
  anchors: Vec3[];
}

export interface GridAxisPickTarget {
  id: string;
  line_segments: Vec3[];
  bubble_segments: Vec3[];
  anchors: Vec3[];
}

export interface PlanSegmentPickTarget {
  id: string;
  line_segments: Vec3[];
  anchors: Vec3[];
  /** Optional secondary segments (e.g. section fill hint). */
  extra_segments?: Vec3[];
}

function minDistToSegmentPairs(
  clientX: number,
  clientY: number,
  points: Vec3[],
  toScreen: (point: Vec3) => [number, number] | null,
): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i + 1 < points.length; i += 2) {
    const a = toScreen(points[i]);
    const b = toScreen(points[i + 1]);
    if (!a || !b) continue;
    best = Math.min(best, distPointToSegment2d(clientX, clientY, a[0], a[1], b[0], b[1]));
  }
  return best;
}

function minDistToAnchors(
  clientX: number,
  clientY: number,
  anchors: Vec3[],
  toScreen: (point: Vec3) => [number, number] | null,
): number {
  let best = Number.POSITIVE_INFINITY;
  for (const anchor of anchors) {
    const screen = toScreen(anchor);
    if (!screen) continue;
    best = Math.min(best, Math.hypot(clientX - screen[0], clientY - screen[1]));
  }
  return best;
}

export interface LevelPlaneView {
  id: string;
  elevation: number;
  active: boolean;
}

/**
 * Split long xyzxyz segments so NDC thick-line width stays stable.
 * Kilometre edges push |clip/NDC| so high that float32 eats the pixel offset
 * and the ribbon reads as a inflated slab — not a segment-count problem.
 */
function subdivideLineSegments(
  segments: ArrayLike<number>,
  maxLen: number,
): Float32Array {
  const nVerts = Math.floor(segments.length / 3);
  const nSeg = Math.floor(nVerts / 2);
  const out: number[] = [];
  const maxLenSq = maxLen * maxLen;
  for (let s = 0; s < nSeg; s++) {
    const i = s * 6;
    const ax = segments[i];
    const ay = segments[i + 1];
    const az = segments[i + 2];
    const bx = segments[i + 3];
    const by = segments[i + 4];
    const bz = segments[i + 5];
    const dx = bx - ax;
    const dy = by - ay;
    const dz = bz - az;
    const lenSq = dx * dx + dy * dy + dz * dz;
    if (!(lenSq > maxLenSq)) {
      out.push(ax, ay, az, bx, by, bz);
      continue;
    }
    const len = Math.sqrt(lenSq);
    const parts = Math.max(2, Math.ceil(len / maxLen));
    for (let p = 0; p < parts; p++) {
      const t0 = p / parts;
      const t1 = (p + 1) / parts;
      out.push(
        ax + dx * t0,
        ay + dy * t0,
        az + dz * t0,
        ax + dx * t1,
        ay + dy * t1,
        az + dz * t1,
      );
    }
  }
  return new Float32Array(out);
}

/**
 * Expand endpoint pairs (xyzxyz…) into screen-space thick-line quads.
 * Each segment → 6 verts × (p0.xyz, p1.xyz, side, end) interleaved.
 */
const THICK_LINE_CORNERS: ReadonlyArray<readonly [number, number]> = [
  [-1, 0],
  [1, 0],
  [-1, 1],
  [1, 0],
  [1, 1],
  [-1, 1],
];
const THICK_LINE_FLOATS_PER_VERT = 8;
const THICK_LINE_STRIDE_BYTES = THICK_LINE_FLOATS_PER_VERT * 4;

function expandLineSegments(segments: ArrayLike<number>): Float32Array {
  const nVerts = Math.floor(segments.length / 3);
  const nSeg = Math.floor(nVerts / 2);
  const out = new Float32Array(nSeg * 6 * THICK_LINE_FLOATS_PER_VERT);
  let o = 0;
  for (let s = 0; s < nSeg; s++) {
    const i = s * 6;
    const ax = segments[i];
    const ay = segments[i + 1];
    const az = segments[i + 2];
    const bx = segments[i + 3];
    const by = segments[i + 4];
    const bz = segments[i + 5];
    for (const [side, end] of THICK_LINE_CORNERS) {
      out[o++] = ax;
      out[o++] = ay;
      out[o++] = az;
      out[o++] = bx;
      out[o++] = by;
      out[o++] = bz;
      out[o++] = side;
      out[o++] = end;
    }
  }
  return out;
}

export function snapToGrid(value: number, step = GRID_STEP): number {
  return Math.round(value / step) * step;
}

export function snapPointToGrid(
  p: [number, number, number],
  step = GRID_STEP,
): [number, number, number] {
  return [snapToGrid(p[0], step), p[1], snapToGrid(p[2], step)];
}

/** Constrain end so the longer axis wins (ortho wall). */
export function orthoConstrain(
  start: [number, number, number],
  end: [number, number, number],
): [number, number, number] {
  const dx = end[0] - start[0];
  const dz = end[2] - start[2];
  if (Math.abs(dx) >= Math.abs(dz)) {
    return [end[0], start[1], start[2]];
  }
  return [start[0], start[1], end[2]];
}

function aabbFromPositions(positions: ArrayLike<number>): {
  min: [number, number, number];
  max: [number, number, number];
} | null {
  if (positions.length < 3) return null;
  const min: [number, number, number] = [positions[0], positions[1], positions[2]];
  const max: [number, number, number] = [positions[0], positions[1], positions[2]];
  for (let i = 0; i < positions.length; i += 3) {
    min[0] = Math.min(min[0], positions[i]);
    min[1] = Math.min(min[1], positions[i + 1]);
    min[2] = Math.min(min[2], positions[i + 2]);
    max[0] = Math.max(max[0], positions[i]);
    max[1] = Math.max(max[1], positions[i + 1]);
    max[2] = Math.max(max[2], positions[i + 2]);
  }
  return { min, max };
}

export class ViewportRenderer {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private meshProg: WebGLProgram;
  private lineProg: WebGLProgram;
  private pointProg: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private posBuf: WebGLBuffer;
  private nrmBuf: WebGLBuffer;
  private pickBuf: WebGLBuffer;
  private idxBuf: WebGLBuffer;
  private edgeVao: WebGLVertexArrayObject;
  private edgeBuf: WebGLBuffer;
  private edgeCount = 0;
  private gridVao: WebGLVertexArrayObject;
  private gridBuf: WebGLBuffer;
  private gridCount = 0;
  private contourVao: WebGLVertexArrayObject;
  private contourBuf: WebGLBuffer;
  private contourCount = 0;
  private activeContourVao: WebGLVertexArrayObject;
  private activeContourBuf: WebGLBuffer;
  private activeContourCount = 0;
  private gridBounds = {
    minX: -GRID_DEFAULT_HALF,
    maxX: GRID_DEFAULT_HALF,
    minZ: -GRID_DEFAULT_HALF,
    maxZ: GRID_DEFAULT_HALF,
  };
  private levelPlanes: LevelPlaneView[] = [];
  private previewVao: WebGLVertexArrayObject;
  private previewBuf: WebGLBuffer;
  private previewCount = 0;
  private ghostVao: WebGLVertexArrayObject;
  private ghostPosBuf: WebGLBuffer;
  private ghostNrmBuf: WebGLBuffer;
  private ghostIdxBuf: WebGLBuffer;
  private ghostIndexCount = 0;
  private handleVao: WebGLVertexArrayObject;
  private handleBuf: WebGLBuffer;
  private handleCount = 0;
  private snapVao: WebGLVertexArrayObject;
  private snapBuf: WebGLBuffer;
  private snapCount = 0;
  private editLineVao: WebGLVertexArrayObject;
  private editLineBuf: WebGLBuffer;
  private editLineCount = 0;
  private refLineVao: WebGLVertexArrayObject;
  private refLineBuf: WebGLBuffer;
  private refLineCount = 0;
  private gridAxisLineVao: WebGLVertexArrayObject;
  private gridAxisLineBuf: WebGLBuffer;
  private gridAxisLineCount = 0;
  private gridAxisBubbleVao: WebGLVertexArrayObject;
  private gridAxisBubbleBuf: WebGLBuffer;
  private gridAxisBubbleCount = 0;
  private constructionLineVao: WebGLVertexArrayObject;
  private constructionLineBuf: WebGLBuffer;
  private constructionLineCount = 0;
  private planSymbolVao: WebGLVertexArrayObject;
  private planSymbolBuf: WebGLBuffer;
  private planSymbolCount = 0;
  private sectionCutLineVao: WebGLVertexArrayObject;
  private sectionCutLineBuf: WebGLBuffer;
  private sectionCutLineCount = 0;
  private sectionCutFillVao: WebGLVertexArrayObject;
  private sectionCutFillBuf: WebGLBuffer;
  private sectionCutFillCount = 0;
  private spaceLineVao: WebGLVertexArrayObject;
  private spaceLineBuf: WebGLBuffer;
  private spaceLineCount = 0;
  private viewAnnotationLineVao: WebGLVertexArrayObject;
  private viewAnnotationLineBuf: WebGLBuffer;
  private viewAnnotationLineCount = 0;
  private editHandles: Vec3[] | null = null;
  private indexCount = 0;
  private pickFbo: WebGLFramebuffer | null = null;
  private pickTex: WebGLTexture | null = null;
  private pickDepth: WebGLRenderbuffer | null = null;
  private pickW = 0;
  private pickH = 0;
  private camera: CameraState = {
    target: [...DEFAULT_CAMERA.target] as [number, number, number],
    distance: DEFAULT_CAMERA.distance,
    yaw: DEFAULT_CAMERA.yaw,
    pitch: DEFAULT_CAMERA.pitch,
  };
  /** CAD default: parallel projection (axonometric when pitched/yawed). */
  private projection: ProjectionMode = 'orthographic';
  private viewNavigation: ViewNavigationMode = '3d';
  private saved3dView: Saved3DView | null = null;
  /** Horizontal plan cut height (world Y); defaults with active level elevation. */
  private planCutY = 0;
  private planCutFade = 0.35;
  private sceneAabb: Aabb | null = null;
  private slabPickIds: number[] = [];
  private scratchSlabPicks = new Float32Array(32);
  private gridAxisBubbleRaw: Float32Array | null = null;
  private lastPlanBubbleDistance = -1;
  private sceneExtent = 10;
  private selectedPickIds: number[] = [];
  /** Pre-selection hover (Select tool / Tab cycle); not committed selection. */
  private hoveredPickIds: number[] = [];
  private scratchHoverPicks = new Float32Array(8);
  /** Live solids replaced by a path-anchor ghost (source + stretch peers). */
  private hiddenPickIds: number[] = [];
  private scratchHiddenPicks = new Float32Array(32);
  /** CAD edges lack pick ids — suppress all outlines while a hide set is active. */
  private edgesSuppressedForHide = false;
  private savedEdgeCount = 0;
  /** Locked for the whole gesture so MMB never falls through into orbit/zoom. */
  private dragMode: 'pan' | 'orbit' | null = null;
  private lastX = 0;
  private lastY = 0;
  private lastMmbAt = 0;
  private lastMmbX = 0;
  private lastMmbY = 0;
  /** Active pointers for multi-touch (pinch zoom + two-finger pan). */
  private pointers = new Map<number, { x: number; y: number; type: string }>();
  private touchGesture: 'none' | 'orbit' | 'pinchpan' = 'none';
  private touchOrbitEnabled = true;
  /** Sheet paper viewport: transparent drawing, no camera interaction. */
  private sheetPresentation = false;
  private readonly transparentBackground: boolean;
  private pinchStartSpan = 0;
  private pinchStartDistance = 0;
  private lastCentroidX = 0;
  private lastCentroidY = 0;
  /** Cleared by App after a click so place/select ignore camera gestures. */
  private cameraGestureConsumed = false;
  private raf = 0;
  private meshUniforms: MeshUniforms;
  private lineUniforms: LineUniforms;
  private pointUniforms: PointUniforms;
  /** Valid only inside `loop()` so pick/ground rays still recompute after camera edits. */
  private frameMats: CameraMatrices | null = null;
  private readonly scratchLight = new Float32Array([0.45, 0.85, 0.35]);
  private readonly scratchSky = new Float32Array([0.92, 0.94, 0.98]);
  private readonly scratchGround = new Float32Array([0.28, 0.3, 0.34]);
  private readonly scratchGhostSky = new Float32Array([0.95, 0.9, 0.75]);
  private readonly scratchGhostGround = new Float32Array([0.45, 0.35, 0.2]);
  private readonly scratchNormalMat = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  private readonly scratchPicks = new Float32Array(32);
  private readonly scratchEye = new Float32Array(3);
  private fps = 0;
  private fpsFrames = 0;
  private fpsWindowStart = 0;
  private readonly eventAbort = new AbortController();

  constructor(
    canvas: HTMLCanvasElement,
    options?: { transparentBackground?: boolean },
  ) {
    this.canvas = canvas;
    this.transparentBackground = options?.transparentBackground === true;
    const gl = canvas.getContext('webgl2', {
      antialias: true,
      alpha: this.transparentBackground,
      depth: true,
      // Stencil ring for x-ray hover/selection silhouette (see drawHighlightOutline).
      stencil: true,
      premultipliedAlpha: this.transparentBackground,
      // false: cheaper swap-chain on high-Hz displays; pick uses an offscreen FBO.
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 not available');
    this.gl = gl;
    this.meshProg = link(gl, VERT, FRAG);
    this.lineProg = link(gl, LINE_VERT, LINE_FRAG);
    this.pointProg = link(gl, POINT_VERT, POINT_FRAG);
    this.meshUniforms = meshUniforms(gl, this.meshProg);
    this.lineUniforms = lineUniforms(gl, this.lineProg);
    this.pointUniforms = pointUniforms(gl, this.pointProg);

    this.vao = gl.createVertexArray()!;
    this.posBuf = gl.createBuffer()!;
    this.nrmBuf = gl.createBuffer()!;
    this.pickBuf = gl.createBuffer()!;
    this.idxBuf = gl.createBuffer()!;

    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.nrmBuf);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pickBuf);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.idxBuf);
    gl.bindVertexArray(null);

    this.edgeVao = gl.createVertexArray()!;
    this.edgeBuf = gl.createBuffer()!;
    this.bindThickLineVao(this.edgeVao, this.edgeBuf);

    this.gridVao = gl.createVertexArray()!;
    this.gridBuf = gl.createBuffer()!;
    this.bindThickLineVao(this.gridVao, this.gridBuf);

    this.contourVao = gl.createVertexArray()!;
    this.contourBuf = gl.createBuffer()!;
    this.bindThickLineVao(this.contourVao, this.contourBuf);

    this.activeContourVao = gl.createVertexArray()!;
    this.activeContourBuf = gl.createBuffer()!;
    this.bindThickLineVao(this.activeContourVao, this.activeContourBuf);

    this.previewVao = gl.createVertexArray()!;
    this.previewBuf = gl.createBuffer()!;
    this.bindThickLineVao(this.previewVao, this.previewBuf);

    this.ghostVao = gl.createVertexArray()!;
    this.ghostPosBuf = gl.createBuffer()!;
    this.ghostNrmBuf = gl.createBuffer()!;
    this.ghostIdxBuf = gl.createBuffer()!;
    gl.bindVertexArray(this.ghostVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ghostPosBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ghostNrmBuf);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    // pick attribute unused for ghost — bind dummy zeros via pickBuf of main? Use disabled attrib with constant.
    gl.disableVertexAttribArray(2);
    gl.vertexAttrib1f(2, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ghostIdxBuf);
    gl.bindVertexArray(null);

    this.handleVao = gl.createVertexArray()!;
    this.handleBuf = gl.createBuffer()!;
    gl.bindVertexArray(this.handleVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.handleBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this.snapVao = gl.createVertexArray()!;
    this.snapBuf = gl.createBuffer()!;
    gl.bindVertexArray(this.snapVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.snapBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this.editLineVao = gl.createVertexArray()!;
    this.editLineBuf = gl.createBuffer()!;
    this.bindThickLineVao(this.editLineVao, this.editLineBuf);
    this.refLineVao = gl.createVertexArray()!;
    this.refLineBuf = gl.createBuffer()!;
    this.bindThickLineVao(this.refLineVao, this.refLineBuf);
    this.gridAxisLineVao = gl.createVertexArray()!;
    this.gridAxisLineBuf = gl.createBuffer()!;
    this.bindThickLineVao(this.gridAxisLineVao, this.gridAxisLineBuf);
    this.gridAxisBubbleVao = gl.createVertexArray()!;
    this.gridAxisBubbleBuf = gl.createBuffer()!;
    this.bindThickLineVao(this.gridAxisBubbleVao, this.gridAxisBubbleBuf);
    this.constructionLineVao = gl.createVertexArray()!;
    this.constructionLineBuf = gl.createBuffer()!;
    this.bindThickLineVao(this.constructionLineVao, this.constructionLineBuf);
    this.planSymbolVao = gl.createVertexArray()!;
    this.planSymbolBuf = gl.createBuffer()!;
    this.bindThickLineVao(this.planSymbolVao, this.planSymbolBuf);
    this.sectionCutLineVao = gl.createVertexArray()!;
    this.sectionCutLineBuf = gl.createBuffer()!;
    this.bindThickLineVao(this.sectionCutLineVao, this.sectionCutLineBuf);
    this.sectionCutFillVao = gl.createVertexArray()!;
    this.sectionCutFillBuf = gl.createBuffer()!;
    this.bindThickLineVao(this.sectionCutFillVao, this.sectionCutFillBuf);
    this.spaceLineVao = gl.createVertexArray()!;
    this.spaceLineBuf = gl.createBuffer()!;
    this.bindThickLineVao(this.spaceLineVao, this.spaceLineBuf);
    this.viewAnnotationLineVao = gl.createVertexArray()!;
    this.viewAnnotationLineBuf = gl.createBuffer()!;
    this.bindThickLineVao(this.viewAnnotationLineVao, this.viewAnnotationLineBuf);

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    // Two-sided solids: avoid empty/see-through walls if winding disagrees with the view.
    gl.disable(gl.CULL_FACE);
    // Match --chrome-viewport (#1c1c1c) so the canvas sits in the industrial shell.
    gl.clearColor(28 / 255, 28 / 255, 28 / 255, 1);

    this.bindEvents();
    // Harness / debug access (Playwright camera checks).
    (this.canvas as HTMLCanvasElement & { __apexRenderer?: ViewportRenderer }).__apexRenderer =
      this;
    this.loop();
  }

  /** Interleaved thick-line attributes: p0.xyz, p1.xyz, side, end. */
  private bindThickLineVao(vao: WebGLVertexArrayObject, buf: WebGLBuffer): void {
    const gl = this.gl;
    const stride = THICK_LINE_STRIDE_BYTES;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 12);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, 24);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, stride, 28);
    gl.bindVertexArray(null);
  }

  /** Upload segment endpoint pairs; returns triangle vertex count. */
  private uploadThickLines(buf: WebGLBuffer, segments: ArrayLike<number>): number {
    const chunked = subdivideLineSegments(segments, MAX_THICK_SEGMENT_LEN);
    const expanded = expandLineSegments(chunked);
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, buf);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, expanded, this.gl.DYNAMIC_DRAW);
    return expanded.length / THICK_LINE_FLOATS_PER_VERT;
  }

  getCamera(): CameraState {
    return { ...this.camera, target: [...this.camera.target] as [number, number, number] };
  }

  /** Replace camera pose fields (tests / view presets). Keeps unspecified fields. */
  setCamera(state: Partial<CameraState>): void {
    if (state.target) {
      this.camera.target = [state.target[0], state.target[1], state.target[2]];
    }
    if (state.distance != null) this.camera.distance = state.distance;
    if (this.viewNavigation === 'plan') {
      // Plan pose is axis-locked; callers may still pass distance/target.
      this.camera.yaw = 0;
      this.camera.pitch = PLAN_PITCH;
    } else {
      if (state.yaw != null) this.camera.yaw = state.yaw;
      if (state.pitch != null) {
        this.camera.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, state.pitch));
      }
    }
    this.frameMats = null;
  }

  /** Rolling FPS from the render loop (display-synced via rAF). */
  /**
   * PNG data URL of the next rendered frame (the drawing buffer is not
   * preserved, so read it inside the same animation frame as the draw).
   */
  snapshotDataUrl(): Promise<string> {
    return new Promise((resolve) => {
      requestAnimationFrame(() => resolve(this.canvas.toDataURL('image/png')));
    });
  }

  getFps(): number {
    return this.fps;
  }

  getProjection(): ProjectionMode {
    return this.projection;
  }

  setProjection(mode: ProjectionMode): void {
    if (this.viewNavigation === 'plan') return;
    this.projection = mode;
  }

  getViewNavigation(): ViewNavigationMode {
    return this.viewNavigation;
  }

  setPlanCutHeight(elevation: number, fadeBand = 0.35): void {
    this.planCutY = elevation;
    this.planCutFade = Math.max(fadeBand, 0.05);
  }

  getPlanCutHeight(): number {
    return this.planCutY;
  }

  /**
   * Enter locked top-down plan (orthographic, −Y view) or restore the saved 3D camera.
   */
  setViewNavigation(mode: ViewNavigationMode): void {
    if (mode === this.viewNavigation) return;
    if (mode === 'plan') {
      this.saved3dView = {
        camera: {
          target: [...this.camera.target] as [number, number, number],
          distance: this.camera.distance,
          yaw: this.camera.yaw,
          pitch: this.camera.pitch,
        },
        projection: this.projection,
      };
      this.projection = 'orthographic';
      this.viewNavigation = 'plan';
      this.camera.yaw = 0;
      this.camera.pitch = PLAN_PITCH;
      this.camera.target[1] = this.planCutY;
      this.touchOrbitEnabled = false;
      this.refreshPlanBubbleGeometry(true);
      this.frameMats = null;
      return;
    }
    this.viewNavigation = '3d';
    this.touchOrbitEnabled = true;
    if (this.saved3dView) {
      const saved = this.saved3dView;
      this.saved3dView = null;
      this.camera = {
        target: [...saved.camera.target] as [number, number, number],
        distance: saved.camera.distance,
        yaw: saved.camera.yaw,
        pitch: saved.camera.pitch,
      };
      this.projection = saved.projection;
    }
    this.uploadGridAxisBubbles(this.gridAxisBubbleRaw);
    this.frameMats = null;
  }

  /** Fit the camera to the current scene bounds (3D) or XZ extents at the cut (plan). */
  isPlanNavigation(): boolean {
    return this.viewNavigation === 'plan';
  }

  /** Whether a pick id belongs to a floor slab (rooms sit on slabs in plan). */
  isSlabPick(pickId: number): boolean {
    return this.slabPickIds.includes(pickId);
  }

  fitViewExtents(): void {
    if (!this.sceneAabb) return;
    const aabb = this.sceneAabb;
    if (this.viewNavigation === 'plan') {
      const cx = (aabb.min[0] + aabb.max[0]) * 0.5;
      const cz = (aabb.min[2] + aabb.max[2]) * 0.5;
      this.camera.target = [cx, this.planCutY, cz];
      this.camera.yaw = 0;
      this.camera.pitch = PLAN_PITCH;
      const aspect = this.canvas.clientWidth / Math.max(1, this.canvas.clientHeight);
      this.camera.distance = planFitDistance(aabb, aspect, CAMERA_FOVY);
      this.frameMats = null;
      this.refreshPlanBubbleGeometry(true);
      return;
    }
    this.fitToAabb(aabb.min, aabb.max);
  }

  /** Restore the default home camera pose (keeps projection mode). */
  resetCamera(): void {
    if (this.viewNavigation === 'plan') {
      this.camera.yaw = 0;
      this.camera.pitch = PLAN_PITCH;
      this.camera.target[1] = this.planCutY;
      this.fitViewExtents();
      this.frameMats = null;
      return;
    }
    this.camera = {
      target: [...DEFAULT_CAMERA.target] as [number, number, number],
      distance: DEFAULT_CAMERA.distance,
      yaw: DEFAULT_CAMERA.yaw,
      pitch: DEFAULT_CAMERA.pitch,
    };
    this.frameMats = null;
  }

  setScene(data: SceneMeshData): void {
    const gl = this.gl;
    const positions =
      data.positions instanceof Float32Array ? data.positions : new Float32Array(data.positions);
    const normals =
      data.normals instanceof Float32Array ? data.normals : new Float32Array(data.normals);
    const indices =
      data.indices instanceof Uint32Array ? data.indices : new Uint32Array(data.indices);
    const edgesRaw = data.edgePositions ?? [];
    const edges =
      edgesRaw instanceof Float32Array ? edgesRaw : new Float32Array(edgesRaw as ArrayLike<number>);

    const triCount = indices.length / 3;
    const pickPerVertex = new Float32Array(positions.length / 3);
    for (let t = 0; t < triCount; t++) {
      const pid = Number(data.pickIds[t] ?? 0);
      pickPerVertex[indices[t * 3]] = pid;
      pickPerVertex[indices[t * 3 + 1]] = pid;
      pickPerVertex[indices[t * 3 + 2]] = pid;
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.nrmBuf);
    gl.bufferData(gl.ARRAY_BUFFER, normals, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pickBuf);
    gl.bufferData(gl.ARRAY_BUFFER, pickPerVertex, gl.DYNAMIC_DRAW);
    // ELEMENT_ARRAY_BUFFER binding lives on the VAO — update while it is bound.
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.idxBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.DYNAMIC_DRAW);
    gl.bindVertexArray(null);
    this.indexCount = indices.length;

    const uploadedEdges = this.uploadThickLines(this.edgeBuf, edges);
    if (this.edgesSuppressedForHide) {
      this.savedEdgeCount = uploadedEdges;
      this.edgeCount = 0;
    } else {
      this.edgeCount = uploadedEdges;
    }

    this.selectedPickIds = data.selectedPickIds.slice(0, 32);

    this.slabPickIds = (data.slabPickIds ?? []).slice(0, 32);
    const meshAabb = aabbFromPositions(positions);
    const fitAabb =
      sanitizeAabb(data.fitBounds ?? null) ??
      sanitizeAabb(meshAabb ? { min: meshAabb.min, max: meshAabb.max } : null);
    if (fitAabb) {
      this.sceneAabb = fitAabb;
      const sx = fitAabb.max[0] - fitAabb.min[0];
      const sy = fitAabb.max[1] - fitAabb.min[1];
      const sz = fitAabb.max[2] - fitAabb.min[2];
      this.sceneExtent = Math.max(sx, sy, sz, 2);
      if (meshAabb) {
        this.expandGridToInclude(meshAabb.min[0], meshAabb.max[0], meshAabb.min[2], meshAabb.max[2]);
      }
      // Opt-in only — never yank the camera unless the caller asked.
      if (data.fitCamera === true) {
        if (this.viewNavigation === 'plan') this.fitViewExtents();
        else this.fitToAabb(fitAabb.min, fitAabb.max);
      }
    } else {
      this.sceneAabb = null;
      this.sceneExtent = 10;
    }
  }

  fitToAabb(min: [number, number, number], max: [number, number, number]): void {
    const aabb = sanitizeAabb({ min, max });
    if (!aabb) return;
    const center = aabbCenter(aabb);
    this.camera.target = center;
    this.camera.distance = perspectiveFitDistance(aabb);
    const sx = aabb.max[0] - aabb.min[0];
    const sy = aabb.max[1] - aabb.min[1];
    const sz = aabb.max[2] - aabb.min[2];
    this.sceneExtent = Math.max(sx, sy, sz, 2);
  }

  setSelectedPickIds(ids: number[]): void {
    this.selectedPickIds = ids.slice(0, 32);
  }

  /**
   * Hide live solids (and temporarily CAD edges) while a path-anchor ghost
   * replaces the edited join cluster. Pass `[]` to restore.
   */
  setHiddenPickIds(ids: number[]): void {
    this.hiddenPickIds = ids.slice(0, 32);
    if (this.hiddenPickIds.length > 0) {
      if (!this.edgesSuppressedForHide) {
        this.savedEdgeCount = this.edgeCount;
        this.edgesSuppressedForHide = true;
      }
      this.edgeCount = 0;
    } else if (this.edgesSuppressedForHide) {
      this.edgeCount = this.savedEdgeCount;
      this.edgesSuppressedForHide = false;
      this.savedEdgeCount = 0;
    }
  }

  /** Olive pre-highlight under the cursor (distinct from selection orange). */
  setHoveredPickIds(ids: number[]): void {
    this.hoveredPickIds = ids.slice(0, 8);
  }

  /**
   * Work-plane levels: active level gets a semi-transparent grid; every level
   * gets a contour matching the shared XZ grid bounds.
   */
  setLevelPlanes(levels: LevelPlaneView[]): void {
    this.levelPlanes = levels.slice();
    this.refreshLevelVisuals();
  }

  getGridBounds(): { minX: number; maxX: number; minZ: number; maxZ: number } {
    return { ...this.gridBounds };
  }

  private refreshLevelVisuals(): void {
    const { minX, maxX, minZ, maxZ } = this.gridBounds;
    const active = this.levelPlanes.find((l) => l.active) ?? null;
    if (active) {
      const grid = buildGridRect(minX, maxX, minZ, maxZ, GRID_STEP, active.elevation);
      this.gridCount = this.uploadThickLines(this.gridBuf, grid);
      const contour = buildRectContour(minX, maxX, minZ, maxZ, active.elevation);
      this.activeContourCount = this.uploadThickLines(this.activeContourBuf, contour);
    } else {
      this.gridCount = 0;
      this.activeContourCount = 0;
    }

    const segs: number[] = [];
    for (const level of this.levelPlanes) {
      if (level.active) continue;
      const c = buildRectContour(minX, maxX, minZ, maxZ, level.elevation);
      for (let i = 0; i < c.length; i++) segs.push(c[i]);
    }
    this.contourCount =
      segs.length > 0 ? this.uploadThickLines(this.contourBuf, new Float32Array(segs)) : 0;
  }

  /**
   * Grow shared XZ grid bounds to cover the given region, plus GRID_MARGIN_CELLS.
   * Fixed GRID_STEP (1 m) — does not change with zoom. Never shrinks.
   */
  expandGridToInclude(
    minX: number,
    maxX: number,
    minZ: number,
    maxZ: number,
    marginCells = GRID_MARGIN_CELLS,
  ): void {
    const step = GRID_STEP;
    const margin = marginCells * step;
    const nextMinX = Math.min(this.gridBounds.minX, Math.floor((minX - margin) / step) * step);
    const nextMaxX = Math.max(this.gridBounds.maxX, Math.ceil((maxX + margin) / step) * step);
    const nextMinZ = Math.min(this.gridBounds.minZ, Math.floor((minZ - margin) / step) * step);
    const nextMaxZ = Math.max(this.gridBounds.maxZ, Math.ceil((maxZ + margin) / step) * step);
    if (
      nextMinX === this.gridBounds.minX &&
      nextMaxX === this.gridBounds.maxX &&
      nextMinZ === this.gridBounds.minZ &&
      nextMaxZ === this.gridBounds.maxZ
    ) {
      return;
    }
    this.gridBounds = { minX: nextMinX, maxX: nextMaxX, minZ: nextMinZ, maxZ: nextMaxZ };
    const span = Math.max(nextMaxX - nextMinX, nextMaxZ - nextMinZ, 2);
    this.sceneExtent = Math.max(this.sceneExtent, span);
    this.refreshLevelVisuals();
  }

  /**
   * Double-click target for activating a level.
   * Prefer a screen-space hit on the outer contour; otherwise accept a ray hit
   * on the level plane inside the shared grid bounds (closest plane wins).
   */
  hitLevelContour(clientX: number, clientY: number, pixelRadius = 16): string | null {
    const { minX, maxX, minZ, maxZ } = this.gridBounds;
    let bestId: string | null = null;
    let bestDist = pixelRadius;

    for (const level of this.levelPlanes) {
      const y = level.elevation;
      const corners: Array<[number, number, number]> = [
        [minX, y, minZ],
        [maxX, y, minZ],
        [maxX, y, maxZ],
        [minX, y, maxZ],
      ];
      for (let i = 0; i < 4; i++) {
        const a = this.worldToClient(corners[i]);
        const b = this.worldToClient(corners[(i + 1) % 4]);
        if (!a || !b) continue;
        const d = distPointToSegment2d(clientX, clientY, a[0], a[1], b[0], b[1]);
        if (d <= bestDist) {
          bestDist = d;
          bestId = level.id;
        }
      }
    }
    if (bestId) return bestId;

    // Contour often sits outside the current frustum — fall back to the plane.
    const { eye } = this.cameraMatrices();
    let bestDepth = Number.POSITIVE_INFINITY;
    for (const level of this.levelPlanes) {
      const hit = this.screenToGround(clientX, clientY, level.elevation);
      if (!hit) continue;
      if (hit[0] < minX || hit[0] > maxX || hit[2] < minZ || hit[2] > maxZ) continue;
      const depth = Math.hypot(hit[0] - eye[0], hit[1] - eye[1], hit[2] - eye[2]);
      if (depth < bestDepth) {
        bestDepth = depth;
        bestId = level.id;
      }
    }
    return bestId;
  }

  /** Grow the ground grid so every given point stays on it. */
  private includePoints(points: Vec3[]): void {
    if (points.length === 0) return;
    const xs = points.map((p) => p[0]);
    const zs = points.map((p) => p[2]);
    this.expandGridToInclude(Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs));
  }

  /** Construction polyline through the picks made so far (or clear with null). */
  setPreviewLine(points: Vec3[] | null): void {
    if (!points || points.length < 2) {
      this.previewCount = 0;
      return;
    }
    this.includePoints(points);
    // Overlay draw already keeps the axis visible — no world-Y lift (avoids float).
    this.previewCount = this.uploadThickLines(this.previewBuf, segmentsThrough(points));
  }

  /** Semi-transparent ghost solid while placing (or clear with null). */
  setGhostMesh(
    mesh: { positions: Float32Array; normals: Float32Array; indices: Uint32Array } | null,
  ): void {
    const gl = this.gl;
    if (!mesh || mesh.indices.length === 0) {
      this.ghostIndexCount = 0;
      return;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ghostPosBuf);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ghostNrmBuf);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.normals, gl.DYNAMIC_DRAW);
    gl.bindVertexArray(this.ghostVao);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ghostIdxBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.DYNAMIC_DRAW);
    gl.bindVertexArray(null);
    this.ghostIndexCount = mesh.indices.length;
  }

  /**
   * Construction line plus a draggable handle per anchor.
   *
   * Takes the element's anchors as-is, so a 1-pick column, a 2-pick wall and a
   * 3-pick arc all get the right gizmo without the renderer knowing the type.
   */
  /** Always-visible markers for document reference points and planes. */
  setReferenceGizmos(segments: Vec3[] | null): void {
    if (!segments || segments.length < 2) {
      this.refLineCount = 0;
      return;
    }
    this.includePoints(segments);
    this.refLineCount = this.uploadThickLines(this.refLineBuf, flatten(segments));
  }

  /** Always-visible plan grid axes: extended segment plus end bubbles. */
  setGridAxisOverlays(
    lines: Vec3[] | null,
    bubbles: Vec3[] | null,
  ): void {
    if (!lines || lines.length < 2) {
      this.gridAxisLineCount = 0;
    } else {
      this.includePoints(lines);
      this.gridAxisLineCount = this.uploadThickLines(
        this.gridAxisLineBuf,
        // Each axis contributes its own [start, end] pair — never chain them.
        flatten(lines),
      );
    }
    if (!bubbles || bubbles.length < 2) {
      this.gridAxisBubbleRaw = null;
      this.gridAxisBubbleCount = 0;
      return;
    }
    this.includePoints(bubbles);
    this.gridAxisBubbleRaw = flatten(bubbles);
    this.uploadGridAxisBubbles(this.gridAxisBubbleRaw);
  }

  private uploadGridAxisBubbles(data: Float32Array | null): void {
    if (!data || data.length < 6) {
      this.gridAxisBubbleCount = 0;
      return;
    }
    this.gridAxisBubbleCount = this.uploadThickLines(this.gridAxisBubbleBuf, data);
  }

  /** Rescale grid bubble circles to a constant screen size in plan view. */
  private refreshPlanBubbleGeometry(force = false): void {
    if (this.viewNavigation !== 'plan' || !this.gridAxisBubbleRaw) return;
    if (
      !force &&
      Math.abs(this.lastPlanBubbleDistance - this.camera.distance) <
        this.camera.distance * 0.002
    ) {
      return;
    }
    this.lastPlanBubbleDistance = this.camera.distance;
    const halfH = this.camera.distance * Math.tan(CAMERA_FOVY / 2);
    const worldR =
      (PLAN_BUBBLE_RADIUS_PX / Math.max(this.canvas.clientHeight, 1)) * 2 * halfH;
    const scaled = rescaleGridBubbleSegments(this.gridAxisBubbleRaw, worldR);
    this.uploadGridAxisBubbles(scaled);
  }

  /** Construction lines — olive, distinct from pink grids and cyan refs. */
  setConstructionLineOverlays(lines: Vec3[] | null): void {
    if (!lines || lines.length < 2) {
      this.constructionLineCount = 0;
      return;
    }
    this.includePoints(lines);
    this.constructionLineCount = this.uploadThickLines(
      this.constructionLineBuf,
      flatten(lines),
    );
  }

  /** Door swing arcs / window glazing (segment pairs); drawn in Plan only. */
  setPlanSymbols(lines: Vec3[] | null): void {
    if (!lines || lines.length < 2) {
      this.planSymbolCount = 0;
      return;
    }
    this.planSymbolCount = this.uploadThickLines(this.planSymbolBuf, flatten(lines));
  }

  /** Section-cut MVP: cut line plus optional vertical fill-hint outline. */
  setSectionCutOverlays(lines: Vec3[] | null, fill: Vec3[] | null): void {
    if (!lines || lines.length < 2) {
      this.sectionCutLineCount = 0;
    } else {
      this.includePoints(lines);
      this.sectionCutLineCount = this.uploadThickLines(
        this.sectionCutLineBuf,
        flatten(lines),
      );
    }
    if (!fill || fill.length < 2) {
      this.sectionCutFillCount = 0;
      return;
    }
    this.includePoints(fill);
    this.sectionCutFillCount = this.uploadThickLines(this.sectionCutFillBuf, flatten(fill));
  }

  /** Closed space boundaries — teal edge pairs (distinct from grids / cuts). */
  setSpaceOverlays(lines: Vec3[] | null): void {
    if (!lines || lines.length < 2) {
      this.spaceLineCount = 0;
      return;
    }
    this.includePoints(lines);
    this.spaceLineCount = this.uploadThickLines(this.spaceLineBuf, flatten(lines));
  }

  /** Saved-view annotations (dimensions, notes) — gold overlay. */
  setViewAnnotationOverlays(lines: Vec3[] | null): void {
    if (!lines || lines.length < 2) {
      this.viewAnnotationLineCount = 0;
      return;
    }
    this.includePoints(lines);
    this.viewAnnotationLineCount = this.uploadThickLines(
      this.viewAnnotationLineBuf,
      flatten(lines),
    );
  }

  /**
   * Edit handles plus the lines between them. `segments` (pairs of points)
   * replaces the default polyline through the anchors, e.g. a slab's shape
   * outline and creases.
   */
  setEditGizmo(anchors: Vec3[] | null, segments?: Vec3[]): void {
    const gl = this.gl;
    if (!anchors || anchors.length === 0) {
      this.editLineCount = 0;
      this.handleCount = 0;
      this.editHandles = null;
      return;
    }
    this.includePoints(anchors);

    // Seat on the level plane; overlay + point eye-pull keep the gizmo readable.
    this.editLineCount = segments
      ? segments.length >= 2
        ? this.uploadThickLines(this.editLineBuf, flatten(segments))
        : 0
      : anchors.length >= 2
        ? this.uploadThickLines(this.editLineBuf, segmentsThrough(anchors))
        : 0;

    gl.bindBuffer(gl.ARRAY_BUFFER, this.handleBuf);
    gl.bufferData(gl.ARRAY_BUFFER, flatten(anchors), gl.DYNAMIC_DRAW);
    this.handleCount = anchors.length;
    this.editHandles = anchors.map((p) => [...p] as Vec3);
  }

  /** Small dot at the Shift-snap target (or clear with null). */
  setSnapMarker(point: [number, number, number] | null): void {
    if (!point) {
      this.snapCount = 0;
      return;
    }
    // Seat on the work plane — same as the wall axis (overlay + eye-pull keep it visible).
    const data = new Float32Array([point[0], point[1], point[2]]);
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.snapBuf);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, data, this.gl.DYNAMIC_DRAW);
    this.snapCount = 1;
  }

  /** Project world point to CSS client coordinates (viewport-relative). */
  worldToClient(p: [number, number, number]): [number, number] | null {
    const local = this.worldToCanvas(p);
    if (!local) return null;
    const rect = this.canvas.getBoundingClientRect();
    return [rect.left + local[0], rect.top + local[1]];
  }

  /** Project world point to coordinates relative to this canvas (top-left origin). */
  worldToCanvas(p: [number, number, number]): [number, number] | null {
    const { viewProj } = this.cameraMatrices();
    const x = viewProj[0] * p[0] + viewProj[4] * p[1] + viewProj[8] * p[2] + viewProj[12];
    const y = viewProj[1] * p[0] + viewProj[5] * p[1] + viewProj[9] * p[2] + viewProj[13];
    const w = viewProj[3] * p[0] + viewProj[7] * p[1] + viewProj[11] * p[2] + viewProj[15];
    if (Math.abs(w) < 1e-8) return null;
    const ndcX = x / w;
    const ndcY = y / w;
    const rect = this.canvas.getBoundingClientRect();
    return [((ndcX + 1) * 0.5) * rect.width, ((1 - ndcY) * 0.5) * rect.height];
  }

  /** Hit-test edit handles in screen space; returns the anchor index. */
  hitEditHandle(clientX: number, clientY: number, pixelRadius = 12): number | null {
    if (!this.editHandles) return null;
    let best: number | null = null;
    let bestDistance = pixelRadius;
    this.editHandles.forEach((anchor, index) => {
      const screen = this.worldToClient(anchor);
      if (!screen) return;
      const distance = Math.hypot(clientX - screen[0], clientY - screen[1]);
      if (distance <= bestDistance) {
        bestDistance = distance;
        best = index;
      }
    });
    return best;
  }

  /**
   * Screen-space pick for plan grid axes (extended line, bubbles, anchors).
   * Returns the closest axis within the pixel thresholds.
   */
  hitGridAxis(
    clientX: number,
    clientY: number,
    axes: GridAxisPickTarget[],
    lineRadius = 14,
    pointRadius = 12,
  ): { id: string; distance: number } | null {
    const toScreen = (point: Vec3) => this.worldToClient(point);
    let best: { id: string; distance: number } | null = null;

    for (const axis of axes) {
      const lineDist =
        axis.line_segments.length >= 2
          ? minDistToSegmentPairs(clientX, clientY, axis.line_segments, toScreen)
          : Number.POSITIVE_INFINITY;
      const bubbleDist =
        axis.bubble_segments.length >= 2
          ? minDistToSegmentPairs(clientX, clientY, axis.bubble_segments, toScreen)
          : Number.POSITIVE_INFINITY;
      const anchorDist = minDistToAnchors(clientX, clientY, axis.anchors, toScreen);
      const segmentDist = Math.min(lineDist, bubbleDist);
      const distance = Math.min(
        segmentDist <= lineRadius ? segmentDist : Number.POSITIVE_INFINITY,
        anchorDist <= pointRadius ? anchorDist : Number.POSITIVE_INFINITY,
      );
      if (distance === Number.POSITIVE_INFINITY) continue;
      if (!best || distance < best.distance) {
        best = { id: axis.id, distance };
      }
    }
    return best;
  }

  /**
   * Screen-space pick for two-point plan annotations (construction lines, section cuts).
   */
  hitPlanSegment(
    clientX: number,
    clientY: number,
    targets: PlanSegmentPickTarget[],
    lineRadius = 14,
    pointRadius = 12,
  ): { id: string; distance: number } | null {
    const toScreen = (point: Vec3) => this.worldToClient(point);
    let best: { id: string; distance: number } | null = null;

    for (const target of targets) {
      const lineDist =
        target.line_segments.length >= 2
          ? minDistToSegmentPairs(clientX, clientY, target.line_segments, toScreen)
          : Number.POSITIVE_INFINITY;
      const extra = target.extra_segments ?? [];
      const extraDist =
        extra.length >= 2
          ? minDistToSegmentPairs(clientX, clientY, extra, toScreen)
          : Number.POSITIVE_INFINITY;
      const anchorDist = minDistToAnchors(clientX, clientY, target.anchors, toScreen);
      const segmentDist = Math.min(lineDist, extraDist);
      const distance = Math.min(
        segmentDist <= lineRadius ? segmentDist : Number.POSITIVE_INFINITY,
        anchorDist <= pointRadius ? anchorDist : Number.POSITIVE_INFINITY,
      );
      if (distance === Number.POSITIVE_INFINITY) continue;
      if (!best || distance < best.distance) {
        best = { id: target.id, distance };
      }
    }
    return best;
  }

  /**
   * Screen-space pick for reference points and planes (gizmo outline + anchors).
   * Returns the closest reference within the pixel thresholds.
   */
  hitReference(
    clientX: number,
    clientY: number,
    references: ReferencePickTarget[],
    lineRadius = 14,
    pointRadius = 16,
  ): { id: string; distance: number } | null {
    const toScreen = (point: Vec3) => this.worldToClient(point);
    let best: { id: string; distance: number } | null = null;

    for (const reference of references) {
      const segmentDist =
        reference.gizmo_segments.length >= 2
          ? minDistToSegmentPairs(clientX, clientY, reference.gizmo_segments, toScreen)
          : Number.POSITIVE_INFINITY;
      const anchorDist = minDistToAnchors(clientX, clientY, reference.anchors, toScreen);
      const distance = Math.min(
        segmentDist <= lineRadius ? segmentDist : Number.POSITIVE_INFINITY,
        anchorDist <= pointRadius ? anchorDist : Number.POSITIVE_INFINITY,
      );
      if (distance === Number.POSITIVE_INFINITY) continue;
      if (!best || distance < best.distance) {
        best = { id: reference.id, distance };
      }
    }
    return best;
  }

  /** Ray-plane hit on Y=elevation. */
  screenToGround(clientX: number, clientY: number, elevation = 0): [number, number, number] | null {
    const rect = this.canvas.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * 2 - 1;
    const y = -(((clientY - rect.top) / rect.height) * 2 - 1);
    const { viewProjInv } = this.cameraMatrices();
    const nearPt = this.unproject(x, y, -1, viewProjInv);
    const farPt = this.unproject(x, y, 1, viewProjInv);
    const dir = [farPt[0] - nearPt[0], farPt[1] - nearPt[1], farPt[2] - nearPt[2]] as [
      number,
      number,
      number,
    ];
    if (Math.abs(dir[1]) < 1e-8) return null;
    // Use the unprojected near point as the ray origin so orthographic (parallel)
    // rays hit correctly; for perspective, near→far lies on the same view ray.
    const t = (elevation - nearPt[1]) / dir[1];
    if (t < 0) return null;
    return [nearPt[0] + dir[0] * t, elevation, nearPt[2] + dir[2] * t];
  }

  private pickExclude = new Float32Array(8);
  private pickExcludeCount = 0;

  /**
   * Every pick id under the cursor, nearest first (up to 8). Each pass hides
   * the ids already found, so solids buried under a wall or slab still show.
   */
  pickAll(clientX: number, clientY: number): number[] {
    const out: number[] = [];
    try {
      while (out.length < 8) {
        this.pickExclude.fill(0);
        out.forEach((id, i) => (this.pickExclude[i] = id));
        this.pickExcludeCount = out.length;
        const id = this.pick(clientX, clientY);
        if (id == null || out.includes(id)) break;
        out.push(id);
      }
    } finally {
      this.pickExcludeCount = 0;
    }
    return out;
  }

  pick(clientX: number, clientY: number): number | null {
    const gl = this.gl;
    if (this.indexCount === 0) return null;
    this.ensurePickBuffer();
    const rect = this.canvas.getBoundingClientRect();
    const px = Math.floor(((clientX - rect.left) / rect.width) * this.pickW);
    const py = Math.floor((1 - (clientY - rect.top) / rect.height) * this.pickH);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFbo);
    gl.viewport(0, 0, this.pickW, this.pickH);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    this.drawMeshes(true);
    const pixel = new Uint8Array(4);
    gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    const id = pixel[0] | (pixel[1] << 8) | (pixel[2] << 16) | (pixel[3] << 24);
    const uid = id >>> 0;
    return uid === 0 ? null : uid;
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.eventAbort.abort();
    const c = this.canvas as HTMLCanvasElement & { __apexRenderer?: ViewportRenderer };
    if (c.__apexRenderer === this) delete c.__apexRenderer;
  }

  /**
   * True once after a touch camera gesture (orbit / pan / pinch).
   * App should skip the following click so place/select do not fire.
   */
  consumeCameraGesture(): boolean {
    const consumed = this.cameraGestureConsumed;
    this.cameraGestureConsumed = false;
    return consumed;
  }

  /** Disable three-finger orbit while placing a wall or dragging handles. */
  setTouchOrbitEnabled(enabled: boolean): void {
    this.touchOrbitEnabled = enabled;
    if (!enabled && this.touchGesture === 'orbit') {
      this.touchGesture = 'none';
    }
  }

  setSheetPresentation(enabled: boolean): void {
    this.sheetPresentation = enabled;
    if (enabled) {
      this.touchOrbitEnabled = false;
    }
    this.frameMats = null;
  }

  /** True-scale ortho frustum for a sheet viewport (mm on paper, model metres). */
  setSheetPlanFrustum(
    widthMm: number,
    heightMm: number,
    scaleDenominator: number,
    anchorXM: number,
    anchorZM: number,
    cutY: number,
  ): void {
    const mmPerM = 1000 / Math.max(1, scaleDenominator);
    const halfH_m = heightMm / 2 / mmPerM;
    const halfW_m = widthMm / 2 / mmPerM;
    const aspect = this.canvas.clientWidth / Math.max(1, this.canvas.clientHeight);
    const halfHNeeded = Math.max(halfH_m, halfW_m / aspect);
    const tanHalfFov = Math.tan(CAMERA_FOVY / 2);
    this.camera.distance = Math.max(halfHNeeded / tanHalfFov, 0.01);
    this.camera.target = [anchorXM, cutY, anchorZM];
    this.camera.yaw = 0;
    this.camera.pitch = PLAN_PITCH;
    this.planCutY = cutY;
    this.frameMats = null;
  }

  private bindEvents(): void {
    const signal = this.eventAbort.signal;
    const opt = { signal };
    const passiveFalse = { passive: false as const, signal };

    this.canvas.addEventListener('pointerdown', (e) => {
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });

      if (
        this.sheetPresentation &&
        (e.pointerType === 'mouse' || e.pointerType === 'pen')
      ) {
        return;
      }

      if (e.pointerType === 'touch') {
        const n = this.touchPointerCount();
        if (n >= 3) {
          e.preventDefault();
          if (this.touchOrbitEnabled) this.beginTouchOrbit();
          else this.beginPinchPan();
          return;
        }
        if (n >= 2) {
          e.preventDefault();
          this.beginPinchPan();
          return;
        }
        // Single touch: tap for App place/select — no camera gesture.
        this.touchGesture = 'none';
        return;
      }

      if (e.button === 1) {
        // Middle button: double-click resets camera. Browsers do not fire
        // dblclick for MMB, so detect it from timing + distance.
        e.preventDefault();
        const now = performance.now();
        const dt = now - this.lastMmbAt;
        const dist = Math.hypot(e.clientX - this.lastMmbX, e.clientY - this.lastMmbY);
        this.lastMmbAt = now;
        this.lastMmbX = e.clientX;
        this.lastMmbY = e.clientY;
        if (dt > 0 && dt <= MMB_DBLCLICK_MS && dist <= MMB_DBLCLICK_PX) {
          this.resetCamera();
          this.dragMode = null;
          this.lastMmbAt = 0;
          return;
        }
        this.beginDrag('pan', e);
        return;
      }
      if (e.button === 2) {
        if (this.sheetPresentation) return;
        // Plan: always pan. 3D: Alt+RMB pans; plain RMB orbits.
        e.preventDefault();
        const mode =
          this.viewNavigation === 'plan' || e.altKey ? 'pan' : 'orbit';
        this.beginDrag(mode, e);
        return;
      }
    }, opt);
    this.canvas.addEventListener('auxclick', (e) => {
      // Suppress browser middle-click autoscroll / open-link quirks.
      if (e.button === 1) e.preventDefault();
    }, opt);
    this.canvas.addEventListener('pointermove', (e) => {
      if (this.pointers.has(e.pointerId)) {
        this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
      }

      if (e.pointerType === 'touch') {
        const n = this.touchPointerCount();
        if (n >= 3 && this.touchOrbitEnabled) {
          e.preventDefault();
          if (this.touchGesture !== 'orbit') this.beginTouchOrbit();
          this.updateTouchOrbit();
          return;
        }
        if (n >= 2) {
          e.preventDefault();
          if (this.touchGesture !== 'pinchpan') this.beginPinchPan();
          this.updatePinchPan();
          return;
        }
      }

      if (!this.dragMode) return;
      // Keep browser middle-button autoscroll / page pan from stealing the gesture.
      e.preventDefault();
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      if (this.dragMode === 'pan') {
        this.panInView(dx, dy);
        return;
      }
      this.applyOrbitDelta(dx, dy);
    }, opt);
    const endPointer = (e: PointerEvent) => {
      const endedGesture = this.touchGesture;
      const isTouch = e.pointerType === 'touch';
      // Mouse/pen use one pointer id for all buttons; a pointerup for button 0
      // while RMB/MMB is still held must not end an active camera drag.
      const partialMouseRelease =
        !isTouch && e.type === 'pointerup' && e.buttons !== 0;

      if (!partialMouseRelease) {
        this.pointers.delete(e.pointerId);
      }

      const n = this.touchPointerCount();
      if (n >= 3 && this.touchOrbitEnabled) {
        this.beginTouchOrbit();
      } else if (n >= 2) {
        this.beginPinchPan();
      } else {
        this.touchGesture = 'none';
      }

      if (!partialMouseRelease) {
        if (this.pointers.size === 0) {
          this.dragMode = null;
        } else if (!isTouch) {
          this.dragMode = null;
        }
      }

      // Keep the suppress-click flag briefly so the synthetic click (if any) is
      // ignored, then clear it — some touch paths never emit click.
      if (
        (endedGesture === 'orbit' || endedGesture === 'pinchpan') &&
        this.pointers.size === 0
      ) {
        this.cameraGestureConsumed = true;
        window.setTimeout(() => {
          this.cameraGestureConsumed = false;
        }, 50);
      }
    };
    this.canvas.addEventListener('pointerup', endPointer, opt);
    this.canvas.addEventListener('pointercancel', endPointer, opt);
    this.canvas.addEventListener('lostpointercapture', (e) => {
      if (e.pointerType === 'mouse' || e.pointerType === 'pen') {
        this.dragMode = null;
      }
    }, opt);
    this.canvas.addEventListener(
      'wheel',
      (e) => {
        if (this.sheetPresentation) return;
        e.preventDefault();
        this.applyWheelZoom(e.clientX, e.clientY, 1 + e.deltaY * 0.001);
      },
      passiveFalse,
    );
    // iOS Safari / Chrome-on-WebKit: page pinch-zoom and two-finger scroll are
    // not fully blocked by touch-action alone. Non-passive touch + Safari
    // gesture* events keep those gestures on the canvas camera only.
    this.canvas.addEventListener(
      'touchstart',
      (e) => {
        // Multi-touch: block browser page zoom/pan. Leave single-finger alone
        // so taps still synthesize clicks for place/select.
        if (e.touches.length >= 2) e.preventDefault();
      },
      passiveFalse,
    );
    this.canvas.addEventListener(
      'touchmove',
      (e) => {
        e.preventDefault();
      },
      passiveFalse,
    );
    const blockSafariGesture = (e: Event) => {
      e.preventDefault();
    };
    this.canvas.addEventListener('gesturestart', blockSafariGesture, opt);
    this.canvas.addEventListener('gesturechange', blockSafariGesture, opt);
    this.canvas.addEventListener('gestureend', blockSafariGesture, opt);
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault(), opt);
  }

  private touchPointerCount(): number {
    let n = 0;
    for (const p of this.pointers.values()) {
      if (p.type === 'touch') n += 1;
    }
    return n;
  }

  private beginTouchOrbit(): void {
    this.touchGesture = 'orbit';
    this.dragMode = null;
    this.cameraGestureConsumed = true;
    const c = this.pointerCentroid();
    this.lastCentroidX = c.x;
    this.lastCentroidY = c.y;
  }

  private updateTouchOrbit(): void {
    const c = this.pointerCentroid();
    const dx = c.x - this.lastCentroidX;
    const dy = c.y - this.lastCentroidY;
    this.lastCentroidX = c.x;
    this.lastCentroidY = c.y;
    this.applyOrbitDelta(dx, dy);
  }

  private beginPinchPan(): void {
    this.touchGesture = 'pinchpan';
    this.dragMode = null;
    this.cameraGestureConsumed = true;
    const c = this.pointerCentroid();
    this.lastCentroidX = c.x;
    this.lastCentroidY = c.y;
    this.pinchStartSpan = this.pointerSpan();
    this.pinchStartDistance = this.camera.distance;
  }

  private updatePinchPan(): void {
    const c = this.pointerCentroid();
    const dx = c.x - this.lastCentroidX;
    const dy = c.y - this.lastCentroidY;
    this.lastCentroidX = c.x;
    this.lastCentroidY = c.y;
    this.panInView(dx, dy);

    const span = this.pointerSpan();
    if (this.pinchStartSpan > 4 && span > 4) {
      // Spread fingers → zoom in (shorter camera distance).
      const factor = this.pinchStartSpan / span;
      const minDist = MIN_CAMERA_DISTANCE;
      const maxDist = maxCameraDistance(this.sceneExtent);
      this.camera.distance = Math.max(
        minDist,
        Math.min(maxDist, this.pinchStartDistance * factor),
      );
    }
  }

  private pointerCentroid(): { x: number; y: number } {
    let x = 0;
    let y = 0;
    for (const p of this.pointers.values()) {
      x += p.x;
      y += p.y;
    }
    const n = Math.max(1, this.pointers.size);
    return { x: x / n, y: y / n };
  }

  private pointerSpan(): number {
    const pts = [...this.pointers.values()];
    if (pts.length < 2) return 0;
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  }

  /**
   * Turntable orbit by screen delta (same sensitivity as RMB drag).
   * No-op in plan navigation / sheet presentation.
   */
  orbitByDelta(dx: number, dy: number): void {
    if (this.viewNavigation === 'plan' || this.sheetPresentation) return;
    this.applyOrbitDelta(dx, dy);
    this.frameMats = null;
  }

  private applyOrbitDelta(dx: number, dy: number): void {
    this.camera.yaw -= dx * 0.005;
    this.camera.pitch = Math.max(
      -PITCH_LIMIT,
      Math.min(PITCH_LIMIT, this.camera.pitch + dy * 0.005),
    );
  }

  private applyZoomFactor(factor: number): void {
    const minDist = MIN_CAMERA_DISTANCE;
    const maxDist = maxCameraDistance(this.sceneExtent);
    this.camera.distance = Math.max(
      minDist,
      Math.min(maxDist, this.camera.distance * factor),
    );
    this.frameMats = null;
  }

  /** Wheel zoom anchored on the world point under the cursor. */
  private applyWheelZoom(clientX: number, clientY: number, factor: number): void {
    if (Math.abs(factor - 1) < 1e-6) return;
    this.frameMats = null;
    const anchor = this.unprojectOnViewPlane(clientX, clientY);
    this.applyZoomFactor(factor);
    if (!anchor) return;
    const after = this.unprojectOnViewPlane(clientX, clientY);
    if (!after) return;
    this.camera.target[0] += anchor[0] - after[0];
    this.camera.target[1] += anchor[1] - after[1];
    this.camera.target[2] += anchor[2] - after[2];
    this.frameMats = null;
  }

  private beginDrag(mode: 'pan' | 'orbit', e: PointerEvent): void {
    this.dragMode = mode;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.canvas.setPointerCapture(e.pointerId);
  }

  /**
   * Screen-space grab pan (Revit / Blender): the world point under the cursor
   * stays under the cursor. Uses the same viewProjInv as picking so facade
   * (pitch≈0) vertical drag and underside views stay consistent with the image.
   * Caller has already advanced lastX/lastY to the new pointer position.
   */
  private panInView(dx: number, dy: number): void {
    if (dx === 0 && dy === 0) return;
    // Matrices must match the pose *before* this delta (not a stale rAF cache).
    this.frameMats = null;
    const prev = this.unprojectOnViewPlane(this.lastX - dx, this.lastY - dy);
    const next = this.unprojectOnViewPlane(this.lastX, this.lastY);
    if (!prev || !next) return;
    this.camera.target[0] += prev[0] - next[0];
    this.camera.target[1] += prev[1] - next[1];
    this.camera.target[2] += prev[2] - next[2];
    this.frameMats = null;
  }

  /**
   * World hit of a screen ray on the plane through the look-at, facing the camera
   * (view plane). Shared path with rendering/picking via viewProjInv.
   */
  private unprojectOnViewPlane(
    clientX: number,
    clientY: number,
  ): [number, number, number] | null {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return null;
    const x = ((clientX - rect.left) / rect.width) * 2 - 1;
    const y = -(((clientY - rect.top) / rect.height) * 2 - 1);
    const { viewProjInv, eye } = this.buildCameraMatrices();
    const nearPt = this.unproject(x, y, -1, viewProjInv);
    const farPt = this.unproject(x, y, 1, viewProjInv);
    const dir = [farPt[0] - nearPt[0], farPt[1] - nearPt[1], farPt[2] - nearPt[2]];
    const target = this.camera.target;
    // Plane through target with normal = eye − target (faces the camera).
    const nx = eye[0] - target[0];
    const ny = eye[1] - target[1];
    const nz = eye[2] - target[2];
    const denom = dir[0] * nx + dir[1] * ny + dir[2] * nz;
    if (Math.abs(denom) < 1e-12) return null;
    const t = ((target[0] - nearPt[0]) * nx + (target[1] - nearPt[1]) * ny + (target[2] - nearPt[2]) * nz) / denom;
    return [nearPt[0] + dir[0] * t, nearPt[1] + dir[1] * t, nearPt[2] + dir[2] * t];
  }

  private eyePosition(): [number, number, number] {
    const { target, distance, yaw, pitch } = this.camera;
    // Exact above-target eye — avoid cos(π/2) float noise leaving a Z offset.
    if (this.viewNavigation === 'plan') {
      return [target[0], target[1] + distance, target[2]];
    }
    const cp = Math.cos(pitch);
    return [
      target[0] + distance * Math.sin(yaw) * cp,
      target[1] + distance * Math.sin(pitch),
      target[2] + distance * Math.cos(yaw) * cp,
    ];
  }

  private cameraMatrices() {
    if (this.frameMats) return this.frameMats;
    return this.buildCameraMatrices();
  }

  private buildCameraMatrices(): CameraMatrices {
    this.resize();
    const plan = this.viewNavigation === 'plan';
    if (plan) {
      this.camera.yaw = 0;
      this.camera.pitch = PLAN_PITCH;
      this.refreshPlanBubbleGeometry();
    }
    const aspect = this.canvas.clientWidth / Math.max(1, this.canvas.clientHeight);
    // Depth range follows the view (and a soft scene cap), never the raw grid
    // AABB — kilometre walls used to force enormous near/far and trash precision.
    const viewSpan = Math.max(this.camera.distance * 2, 40);
    const radius = Math.max(
      this.camera.distance * 2,
      Math.min(this.sceneExtent, this.camera.distance * 40),
      40,
    );
    // Ortho half-extents match the perspective frustum at `distance` so wheel zoom
    // and mode switches keep the same framing.
    const halfH = this.camera.distance * Math.tan(CAMERA_FOVY / 2);
    const halfW = halfH * aspect;

    let near: number;
    let far: number;
    if (this.projection === 'orthographic') {
      // Symmetric eye-space Z about the camera. A positive near plane (even 5cm)
      // still slices pitched ground/walls in axonometric views; negative near puts
      // that plane behind the eye so nothing in front is near-clipped.
      const depth = Math.max(
        this.camera.distance + radius,
        viewSpan * 2,
        halfH * 4,
        halfW * 4,
        200,
      );
      near = -depth;
      far = depth;
    } else {
      // Keep near < distance so close zoom does not clip the look-at point when
      // the scene radius is huge (distance - radius would be largely negative).
      near = Math.max(MIN_CAMERA_DISTANCE * 0.1, Math.min(0.05, this.camera.distance * 0.25));
      far = this.camera.distance + radius;
    }

    const proj =
      this.projection === 'orthographic'
        ? mat4Ortho(-halfW, halfW, -halfH, halfH, near, far)
        : mat4Perspective(CAMERA_FOVY, aspect, near, far);
    // Plan: eye is directly above the target; world-Y up is parallel to the view
    // axis, so use −Z as view-up (matches yaw=0: +X right, −Z screen-up).
    const eye = this.eyePosition();
    const view = mat4LookAt(eye, this.camera.target, plan ? PLAN_UP : [0, 1, 0]);
    const viewProj = mat4Multiply(proj, view);
    const viewProjInv = invertMat4(viewProj) ?? mat4Identity();
    return { eye, view, proj, viewProj, viewProjInv };
  }

  private unproject(x: number, y: number, z: number, inv: Float32Array): [number, number, number] {
    const vin = [x, y, z, 1];
    const out = [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) {
      out[i] = inv[i] * vin[0] + inv[4 + i] * vin[1] + inv[8 + i] * vin[2] + inv[12 + i] * vin[3];
    }
    const w = out[3] || 1;
    return [out[0] / w, out[1] / w, out[2] / w];
  }

  private resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.floor(this.canvas.clientWidth * dpr);
    const h = Math.floor(this.canvas.clientHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.gl.viewport(0, 0, w, h);
  }

  private ensurePickBuffer(): void {
    const gl = this.gl;
    const w = this.canvas.width;
    const h = this.canvas.height;
    if (this.pickFbo && this.pickW === w && this.pickH === h) return;
    if (this.pickFbo) gl.deleteFramebuffer(this.pickFbo);
    if (this.pickTex) gl.deleteTexture(this.pickTex);
    if (this.pickDepth) gl.deleteRenderbuffer(this.pickDepth);

    this.pickTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.pickTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    this.pickDepth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.pickDepth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);

    this.pickFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.pickTex, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.pickDepth);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.pickW = w;
    this.pickH = h;
  }

  private uploadSlabPickUniforms(u: MeshUniforms): void {
    const gl = this.gl;
    this.scratchSlabPicks.fill(0);
    for (let i = 0; i < this.slabPickIds.length && i < 32; i++) {
      this.scratchSlabPicks[i] = this.slabPickIds[i]!;
    }
    gl.uniform1i(u.uSlabPickCount, Math.min(this.slabPickIds.length, 32));
    gl.uniform1fv(u.uSlabPicks, this.scratchSlabPicks);
  }

  private drawMeshes(pickPass: boolean): void {
    const gl = this.gl;
    if (this.indexCount === 0) return;
    const { viewProj } = this.cameraMatrices();
    const u = this.meshUniforms;
    gl.useProgram(this.meshProg);
    gl.uniformMatrix4fv(u.uMVP, false, viewProj);
    gl.uniformMatrix4fv(u.uModel, false, MAT4_IDENTITY);
    gl.uniformMatrix3fv(u.uNormalMat, false, this.scratchNormalMat);
    gl.uniform3fv(u.uLightDir, this.scratchLight);
    gl.uniform3fv(u.uSkyColor, this.scratchSky);
    gl.uniform3fv(u.uGroundColor, this.scratchGround);
    this.scratchPicks.fill(0);
    for (let i = 0; i < this.selectedPickIds.length && i < 32; i++) {
      this.scratchPicks[i] = this.selectedPickIds[i];
    }
    gl.uniform1fv(u.uSelectedPicks, this.scratchPicks);
    gl.uniform1i(u.uSelectedCount, this.selectedPickIds.length);
    gl.uniform1f(u.uSelectedPick, this.selectedPickIds[0] ?? 0);
    this.scratchHoverPicks.fill(0);
    for (let i = 0; i < this.hoveredPickIds.length && i < 8; i++) {
      this.scratchHoverPicks[i] = this.hoveredPickIds[i]!;
    }
    gl.uniform1fv(u.uHoverPicks, this.scratchHoverPicks);
    gl.uniform1i(u.uHoverCount, pickPass ? 0 : this.hoveredPickIds.length);
    this.scratchHiddenPicks.fill(0);
    for (let i = 0; i < this.hiddenPickIds.length && i < 32; i++) {
      this.scratchHiddenPicks[i] = this.hiddenPickIds[i]!;
    }
    gl.uniform1fv(u.uHiddenPicks, this.scratchHiddenPicks);
    gl.uniform1i(u.uHiddenPickCount, this.hiddenPickIds.length);
    gl.uniform1i(u.uPickPass, pickPass ? 1 : 0);
    gl.uniform1fv(u.uPickExclude, this.pickExclude);
    gl.uniform1i(u.uPickExcludeCount, pickPass ? this.pickExcludeCount : 0);
    gl.uniform1i(u.uGlassPass, 0);
    gl.uniform1i(u.uOutlinePass, 0);
    gl.uniform1f(u.uOutlinePx, 0);
    gl.uniform2f(u.uResolution, this.canvas.width, this.canvas.height);
    gl.uniform1i(u.uPlanMode, this.viewNavigation === 'plan' ? 1 : 0);
    gl.uniform1f(u.uCutY, this.planCutY);
    gl.uniform1f(u.uCutFade, this.planCutFade);
    this.uploadSlabPickUniforms(u);

    gl.bindVertexArray(this.vao);
    gl.enable(gl.DEPTH_TEST);
    // Classic CAD: push filled surfaces back so coplanar outlines win depth.
    if (!pickPass) {
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(1, 1);
    }

    const planLayered =
      !pickPass && this.viewNavigation === 'plan' && this.slabPickIds.length > 0;

    if (pickPass) {
      gl.disable(gl.BLEND);
      gl.depthMask(true);
      gl.uniform1i(u.uMeshLayer, 0);
      gl.uniform1i(u.uSelectionMode, 0);
      gl.uniform1f(u.uOpacity, 1.0);
      gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);
    } else if (planLayered) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      gl.uniform1i(u.uSelectionMode, 0);
      gl.uniform1f(u.uOpacity, 1.0);
      gl.uniform1i(u.uMeshLayer, 1);
      gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);
      gl.disable(gl.BLEND);
      gl.depthMask(true);
      gl.uniform1i(u.uMeshLayer, 2);
      gl.uniform1f(u.uOpacity, 1.0);
      gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);
      gl.uniform1i(u.uMeshLayer, 0);
    } else if (this.selectedPickIds.length > 0) {
      gl.uniform1i(u.uMeshLayer, 0);
      // Opaque walls first (skip selection).
      gl.disable(gl.BLEND);
      gl.depthMask(true);
      gl.uniform1i(u.uSelectionMode, 1);
      gl.uniform1f(u.uOpacity, 1.0);
      gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);

      // Selected wall(s): translucent so construction / multi-select reads clearly.
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      gl.uniform1i(u.uSelectionMode, 2);
      gl.uniform1f(u.uOpacity, 0.38);
      gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);

      gl.depthMask(true);
      gl.disable(gl.BLEND);
    } else {
      gl.disable(gl.BLEND);
      gl.depthMask(true);
      gl.uniform1i(u.uMeshLayer, 0);
      gl.uniform1i(u.uSelectionMode, 0);
      gl.uniform1f(u.uOpacity, 1.0);
      gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);
    }

    // Olive pre-highlight overlay (Select hover / Tab cycle). Selection orange wins.
    if (!pickPass && this.hoveredPickIds.length > 0) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      gl.uniform1i(u.uMeshLayer, 0);
      gl.uniform1i(u.uSelectionMode, 3);
      gl.uniform1f(u.uOpacity, 0.58);
      gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }

    if (!pickPass) {
      // Glass last: translucent, depth-tested, no depth writes.
      gl.uniform1i(u.uMeshLayer, 0);
      gl.uniform1i(u.uSelectionMode, 0);
      gl.uniform1f(u.uOpacity, 1.0);
      gl.uniform1i(u.uGlassPass, 1);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
      gl.uniform1i(u.uGlassPass, 0);
      gl.disable(gl.POLYGON_OFFSET_FILL);
    }
    gl.bindVertexArray(null);
  }

  /**
   * X-ray silhouette for hover + selection: stencil-mask the projected mesh,
   * then draw a screen-space-expanded ring with depth test off so the outline
   * reads through occluding walls/objects. Uses existing pick-id tagging only.
   */
  private drawHighlightOutline(): void {
    const gl = this.gl;
    if (this.indexCount === 0) return;
    if (this.selectedPickIds.length === 0 && this.hoveredPickIds.length === 0) return;

    const { viewProj } = this.cameraMatrices();
    const u = this.meshUniforms;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const plan = this.viewNavigation === 'plan';
    // Thick enough to read as a stroke through busy CAD edges; plan a bit fatter.
    const outlinePx = (plan ? 4.5 : 3.25) * dpr;

    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.POLYGON_OFFSET_FILL);

    gl.enable(gl.STENCIL_TEST);
    gl.clearStencil(0);
    gl.clear(gl.STENCIL_BUFFER_BIT);

    gl.useProgram(this.meshProg);
    gl.uniformMatrix4fv(u.uMVP, false, viewProj);
    gl.uniformMatrix4fv(u.uModel, false, MAT4_IDENTITY);
    gl.uniformMatrix3fv(u.uNormalMat, false, this.scratchNormalMat);
    this.scratchPicks.fill(0);
    for (let i = 0; i < this.selectedPickIds.length && i < 32; i++) {
      this.scratchPicks[i] = this.selectedPickIds[i]!;
    }
    gl.uniform1fv(u.uSelectedPicks, this.scratchPicks);
    gl.uniform1i(u.uSelectedCount, this.selectedPickIds.length);
    gl.uniform1f(u.uSelectedPick, this.selectedPickIds[0] ?? 0);
    this.scratchHoverPicks.fill(0);
    for (let i = 0; i < this.hoveredPickIds.length && i < 8; i++) {
      this.scratchHoverPicks[i] = this.hoveredPickIds[i]!;
    }
    gl.uniform1fv(u.uHoverPicks, this.scratchHoverPicks);
    gl.uniform1i(u.uHoverCount, this.hoveredPickIds.length);
    gl.uniform1i(u.uPickPass, 0);
    gl.uniform1i(u.uPickExcludeCount, 0);
    gl.uniform1i(u.uGlassPass, 0);
    gl.uniform1i(u.uSelectionMode, 0);
    gl.uniform1f(u.uOpacity, 1.0);
    gl.uniform1i(u.uPlanMode, plan ? 1 : 0);
    gl.uniform1f(u.uCutY, this.planCutY);
    gl.uniform1f(u.uCutFade, this.planCutFade);
    gl.uniform1i(u.uMeshLayer, 0);
    gl.uniform2f(u.uResolution, this.canvas.width, this.canvas.height);
    gl.uniform1f(u.uOutlinePx, outlinePx);
    this.uploadSlabPickUniforms(u);

    gl.bindVertexArray(this.vao);

    // Pass 1: write stencil = 1 for the unexpanded silhouette (no color).
    gl.colorMask(false, false, false, false);
    gl.stencilFunc(gl.ALWAYS, 1, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
    gl.stencilMask(0xff);
    gl.uniform1i(u.uOutlinePass, 1);
    gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);

    // Pass 2: expanded mesh only where stencil != 1 → outer ring stroke.
    gl.colorMask(true, true, true, true);
    gl.stencilFunc(gl.NOTEQUAL, 1, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
    gl.uniform1i(u.uOutlinePass, 2);
    gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);

    // Pass 3: soft body wash (still depth-off) so faces buried under roofs/walls
    // keep a readable tint, not only a thin silhouette ring.
    gl.disable(gl.STENCIL_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform1i(u.uOutlinePass, 3);
    gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);
    gl.disable(gl.BLEND);

    gl.bindVertexArray(null);
    gl.uniform1i(u.uOutlinePass, 0);
    gl.stencilMask(0xff);
    gl.depthMask(true);
    gl.enable(gl.DEPTH_TEST);
  }

  private drawGhost(): void {
    const gl = this.gl;
    if (this.ghostIndexCount === 0) return;
    const { viewProj } = this.cameraMatrices();
    const u = this.meshUniforms;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.enable(gl.DEPTH_TEST);
    gl.useProgram(this.meshProg);
    gl.uniformMatrix4fv(u.uMVP, false, viewProj);
    gl.uniformMatrix4fv(u.uModel, false, MAT4_IDENTITY);
    gl.uniformMatrix3fv(u.uNormalMat, false, this.scratchNormalMat);
    gl.uniform3fv(u.uLightDir, this.scratchLight);
    gl.uniform3fv(u.uSkyColor, this.scratchGhostSky);
    gl.uniform3fv(u.uGroundColor, this.scratchGhostGround);
    gl.uniform1f(u.uSelectedPick, 0);
    gl.uniform1i(u.uPickPass, 0);
    gl.uniform1i(u.uSelectionMode, 0);
    gl.uniform1i(u.uOutlinePass, 0);
    gl.uniform1f(u.uOpacity, 0.35);
    gl.uniform1i(u.uPlanMode, this.viewNavigation === 'plan' ? 1 : 0);
    gl.uniform1f(u.uCutY, this.planCutY);
    gl.uniform1f(u.uCutFade, this.planCutFade);
    gl.uniform1i(u.uMeshLayer, 0);
    this.uploadSlabPickUniforms(u);

    gl.bindVertexArray(this.ghostVao);
    gl.vertexAttrib1f(2, 0);
    gl.drawElements(gl.TRIANGLES, this.ghostIndexCount, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);

    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }

  private drawLines(
    vao: WebGLVertexArrayObject,
    count: number,
    color: [number, number, number, number],
    widthPx = 1.5,
    overlayOrOpts: boolean | LineDrawOpts = false,
  ): void {
    if (count === 0) return;
    const opts: LineDrawOpts =
      typeof overlayOrOpts === 'boolean' ? { overlay: overlayOrOpts } : overlayOrOpts;
    const overlay = opts.overlay === true;
    const dashPeriodPx = opts.dashPeriodPx ?? 0;
    const gl = this.gl;
    const { viewProj } = this.cameraMatrices();
    const u = this.lineUniforms;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const useBlend = overlay || color[3] < 0.999 || dashPeriodPx > 0;
    if (overlay) {
      gl.disable(gl.DEPTH_TEST);
    } else {
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(opts.depthFunc ?? gl.LEQUAL);
      // Dashed/occluded passes must not clobber solid depth; opaque edges still write.
      gl.depthMask(dashPeriodPx > 0 ? false : !useBlend);
    }
    if (useBlend) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    } else {
      gl.disable(gl.BLEND);
    }
    gl.useProgram(this.lineProg);
    gl.uniformMatrix4fv(u.uMVP, false, viewProj);
    gl.uniform2f(u.uResolution, this.canvas.width, this.canvas.height);
    gl.uniform1f(u.uLineWidthPx, widthPx * dpr);
    gl.uniform4f(u.uColor, color[0], color[1], color[2], color[3]);
    gl.uniform1f(u.uDashPeriodPx, dashPeriodPx * dpr);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, count);
    gl.bindVertexArray(null);
    if (useBlend) gl.disable(gl.BLEND);
    if (overlay) gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
  }

  /**
   * Construction axis: solid where in front of scene depth, dashed where
   * occluded by opaque walls (classic CAD hidden-line treatment).
   */
  private drawOccludedAxis(
    vao: WebGLVertexArrayObject,
    count: number,
    color: [number, number, number, number],
    widthPx: number,
  ): void {
    if (count === 0) return;
    const gl = this.gl;
    // Visible segments (pass depth).
    this.drawLines(vao, count, color, widthPx, {
      depthFunc: gl.LEQUAL,
      dashPeriodPx: 0,
    });
    // Hidden segments (fail depth) — screen-space dashes.
    this.drawLines(vao, count, color, widthPx, {
      depthFunc: gl.GREATER,
      dashPeriodPx: 12,
    });
  }

  private drawHandles(): void {
    if (this.handleCount === 0) return;
    const gl = this.gl;
    const { viewProj, eye } = this.cameraMatrices();
    const u = this.pointUniforms;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.scratchEye[0] = eye[0];
    this.scratchEye[1] = eye[1];
    this.scratchEye[2] = eye[2];
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(this.pointProg);
    gl.uniformMatrix4fv(u.uMVP, false, viewProj);
    gl.uniform3fv(u.uEye, this.scratchEye);
    gl.uniform1f(u.uPointSize, 8 * dpr);
    gl.uniform4f(u.uColor, 0.95, 0.72, 0.28, 1);
    gl.bindVertexArray(this.handleVao);
    gl.drawArrays(gl.POINTS, 0, this.handleCount);
    gl.bindVertexArray(null);
    gl.enable(gl.DEPTH_TEST);
  }

  private drawSnapMarker(): void {
    if (this.snapCount === 0) return;
    const gl = this.gl;
    const { viewProj, eye } = this.cameraMatrices();
    const u = this.pointUniforms;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.scratchEye[0] = eye[0];
    this.scratchEye[1] = eye[1];
    this.scratchEye[2] = eye[2];
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(this.pointProg);
    gl.uniformMatrix4fv(u.uMVP, false, viewProj);
    gl.uniform3fv(u.uEye, this.scratchEye);
    gl.uniform1f(u.uPointSize, 5 * dpr);
    gl.uniform4f(u.uColor, 0.98, 0.92, 0.78, 1);
    gl.bindVertexArray(this.snapVao);
    gl.drawArrays(gl.POINTS, 0, this.snapCount);
    gl.bindVertexArray(null);
    gl.enable(gl.DEPTH_TEST);
  }

  private loop = (): void => {
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    if (this.fpsWindowStart === 0) this.fpsWindowStart = now;
    this.fpsFrames += 1;
    if (now - this.fpsWindowStart >= 500) {
      this.fps = Math.round((this.fpsFrames * 1000) / (now - this.fpsWindowStart));
      this.fpsFrames = 0;
      this.fpsWindowStart = now;
    }

    const gl = this.gl;
    this.frameMats = this.buildCameraMatrices();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.disable(gl.BLEND);
    gl.depthMask(true);

    if (this.sheetPresentation) {
      if (this.transparentBackground) {
        gl.clearColor(0, 0, 0, 0);
      } else {
        gl.clearColor(1, 1, 1, 1);
      }
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      const lineColor: [number, number, number, number] = [0.15, 0.15, 0.15, 1];
      this.drawLines(this.edgeVao, this.edgeCount, lineColor, 2.2, { overlay: true });
      this.drawLines(this.viewAnnotationLineVao, this.viewAnnotationLineCount, lineColor, 2.0, {
        overlay: true,
      });
      this.frameMats = null;
      return;
    }

    // Match --chrome-viewport (#1c1c1c) so the canvas sits in the industrial shell.
    gl.clearColor(28 / 255, 28 / 255, 28 / 255, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    // Active level grid (semi-transparent) — no separate Y=0 ground grid.
    // Warm/neutral charcoal on #1c1c1c clear (not cool blue).
    this.drawLines(this.gridVao, this.gridCount, [0.44, 0.43, 0.40, 0.38], 0.8);
    this.drawMeshes(false);
    // Outlines at true depth; solids were polygon-offset back.
    const plan = this.viewNavigation === 'plan';
    const edgeWidth = plan ? 3.2 : 2.0;
    const edgeColor: [number, number, number, number] = plan
      ? [0.04, 0.05, 0.06, 1]
      : [0.08, 0.09, 0.1, 1];
    this.drawLines(this.edgeVao, this.edgeCount, edgeColor, edgeWidth);
    this.drawGhost();
    // Level contours (inactive dim, active brighter) — double-click to activate.
    this.drawLines(this.contourVao, this.contourCount, [0.5, 0.56, 0.64, 0.45], 2.0, true);
    this.drawLines(
      this.activeContourVao,
      this.activeContourCount,
      [0.72, 0.84, 0.98, 0.8],
      2.4,
      true,
    );
    // Axis / preview: solid where visible, dashed where behind opaque walls.
    this.drawOccludedAxis(this.previewVao, this.previewCount, [0.95, 0.7, 0.3, 1], 3.0);
    this.drawOccludedAxis(this.editLineVao, this.editLineCount, [0.95, 0.72, 0.28, 1], 3.0);
    this.drawOccludedAxis(this.refLineVao, this.refLineCount, [0.35, 0.82, 0.95, 0.95], 2.5);
    this.drawOccludedAxis(this.gridAxisLineVao, this.gridAxisLineCount, [0.92, 0.55, 0.78, 0.98], 3.2);
    this.drawOccludedAxis(this.gridAxisBubbleVao, this.gridAxisBubbleCount, [0.92, 0.55, 0.78, 0.98], 2.4);
    // Construction lines: olive (distinct from pink grid / cyan refs).
    this.drawOccludedAxis(
      this.constructionLineVao,
      this.constructionLineCount,
      [0.62, 0.72, 0.38, 0.95],
      2.6,
    );
    if (plan) {
      // Plan symbols are 2D drafting on top of the cut: never dash them where
      // they sit "behind" the wall tops (that read as dashed walls).
      this.drawLines(this.planSymbolVao, this.planSymbolCount, [0.88, 0.9, 0.94, 0.95], 1.8, {
        overlay: true,
      });
    }
    // Section cut: amber line + dimmer fill hint.
    this.drawOccludedAxis(this.sectionCutLineVao, this.sectionCutLineCount, [0.95, 0.58, 0.28, 0.98], 3.4);
    this.drawOccludedAxis(this.sectionCutFillVao, this.sectionCutFillCount, [0.95, 0.58, 0.28, 0.45], 1.6);
    // Spaces: teal closed boundary — a plan concept, so not drawn in 3D.
    if (plan) {
      this.drawLines(this.spaceLineVao, this.spaceLineCount, [0.35, 0.78, 0.88, 0.95], 2.8, {
        overlay: true,
      });
      this.drawLines(this.viewAnnotationLineVao, this.viewAnnotationLineCount, [0.98, 0.82, 0.35, 0.98], 2.6, {
        overlay: true,
      });
    } else {
      this.drawOccludedAxis(
        this.viewAnnotationLineVao,
        this.viewAnnotationLineCount,
        [0.98, 0.82, 0.35, 0.98],
        2.6,
      );
    }
    // Hover/selection x-ray outline on top of scene geometry + CAD edges.
    this.drawHighlightOutline();
    this.drawHandles();
    this.drawSnapMarker();
    this.frameMats = null;
  };
}

/** Scale each grid bubble circle (24 segments) to a target world radius. */
function rescaleGridBubbleSegments(raw: Float32Array, targetRadius: number): Float32Array {
  const out = new Float32Array(raw.length);
  const r = Math.max(targetRadius, 0.05);
  if (raw.length < GRID_BUBBLE_FLOATS) {
    return raw.slice();
  }
  for (let offset = 0; offset + GRID_BUBBLE_FLOATS <= raw.length; offset += GRID_BUBBLE_FLOATS) {
    let cx = 0;
    let cy = 0;
    let cz = 0;
    let count = 0;
    for (let i = offset; i < offset + GRID_BUBBLE_FLOATS; i += 3) {
      cx += raw[i];
      cy += raw[i + 1];
      cz += raw[i + 2];
      count += 1;
    }
    if (count === 0) continue;
    cx /= count;
    cy /= count;
    cz /= count;
    let avgR = 0;
    for (let i = offset; i < offset + GRID_BUBBLE_FLOATS; i += 3) {
      const dx = raw[i] - cx;
      const dz = raw[i + 2] - cz;
      avgR += Math.hypot(dx, dz);
    }
    avgR /= count;
    const scale = avgR > 1e-6 ? r / avgR : 1;
    for (let i = offset; i < offset + GRID_BUBBLE_FLOATS; i += 3) {
      out[i] = cx + (raw[i] - cx) * scale;
      out[i + 1] = cy + (raw[i + 1] - cy) * scale;
      out[i + 2] = cz + (raw[i + 2] - cz) * scale;
    }
  }
  return out;
}

function invertMat4(m: Float32Array): Float32Array | null {
  const out = new Float32Array(16);
  const a00 = m[0],
    a01 = m[1],
    a02 = m[2],
    a03 = m[3];
  const a10 = m[4],
    a11 = m[5],
    a12 = m[6],
    a13 = m[7];
  const a20 = m[8],
    a21 = m[9],
    a22 = m[10],
    a23 = m[11];
  const a30 = m[12],
    a31 = m[13],
    a32 = m[14],
    a33 = m[15];

  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;

  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return null;
  det = 1 / det;

  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return out;
}
