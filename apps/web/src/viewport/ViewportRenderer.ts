/** Flat-buffer WebGL2 renderer — solid + CAD edges, pick by triangle id. */

export interface SceneMeshData {
  positions: ArrayLike<number>;
  normals: ArrayLike<number>;
  indices: ArrayLike<number>;
  pickIds: ArrayLike<number>;
  edgePositions?: ArrayLike<number>;
  selectedPickIds: number[];
  fitCamera?: boolean;
}

export interface CameraState {
  target: [number, number, number];
  distance: number;
  yaw: number;
  pitch: number;
}

export type ProjectionMode = 'perspective' | 'orthographic';

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
/** Orbit pitch clamp (radians). Symmetric so the camera can go under the model. */
const PITCH_LIMIT = 1.45; // ~83°, keeps cos(pitch) away from 0
/** Closest wheel-zoom distance (metres). Independent of scene size so huge walls still allow mm inspection. */
const MIN_CAMERA_DISTANCE = 0.001;

const VERT = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in float aPick;
uniform mat4 uMVP;
uniform mat4 uModel;
uniform mat3 uNormalMat;
out vec3 vNormal;
out vec3 vWorld;
flat out float vPick;
void main(){
  vec4 world = uModel * vec4(aPos, 1.0);
  vWorld = world.xyz;
  vNormal = normalize(uNormalMat * aNormal);
  vPick = aPick;
  gl_Position = uMVP * vec4(aPos, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
in vec3 vNormal;
in vec3 vWorld;
flat in float vPick;
uniform vec3 uLightDir;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
uniform float uSelectedPick; // unused when count>0; kept for layout stability
uniform float uSelectedPicks[32];
uniform int uSelectedCount;
uniform bool uPickPass;
uniform float uOpacity;
uniform int uSelectionMode; // 0=all, 1=opaque others, 2=selected only
out vec4 outColor;

bool isSelectedPick(float pick) {
  for (int i = 0; i < 32; i++) {
    if (i >= uSelectedCount) break;
    if (abs(pick - uSelectedPicks[i]) < 0.5) return true;
  }
  return false;
}

void main(){
  if (uPickPass) {
    uint id = uint(vPick);
    float r = float((id >> 0u) & 255u) / 255.0;
    float g = float((id >> 8u) & 255u) / 255.0;
    float b = float((id >> 16u) & 255u) / 255.0;
    float a = float((id >> 24u) & 255u) / 255.0;
    outColor = vec4(r, g, b, a);
    return;
  }
  bool selected = isSelectedPick(vPick);
  if (uSelectionMode == 1 && selected) discard;
  if (uSelectionMode == 2 && !selected) discard;
  vec3 n = normalize(vNormal);
  // Two-sided: thin walls stay lit when viewed from either side.
  float ndl = abs(dot(n, normalize(uLightDir)));
  float hemi = abs(n.y) * 0.5 + 0.5;
  vec3 ambient = mix(uGroundColor, uSkyColor, hemi);
  float wrap = ndl * 0.65 + 0.35;
  vec3 base = selected ? vec3(0.86, 0.52, 0.22) : vec3(0.72, 0.76, 0.80);
  vec3 color = base * (ambient * 0.45 + vec3(wrap) * 0.7);
  outColor = vec4(color, uOpacity);
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

void main() {
  vec4 c0 = uMVP * vec4(aPos0, 1.0);
  vec4 c1 = uMVP * vec4(aPos1, 1.0);

  // Screen direction from clip (stable across differing w). Falls back when the
  // segment collapses on screen (looking along the edge).
  vec2 clipDir = c1.xy * c0.w - c0.xy * c1.w;
  float clipLen = length(clipDir);
  vec2 dir = clipLen > 1e-8 ? clipDir / clipLen : vec2(1.0, 0.0);
  vec2 perp = vec2(-dir.y, dir.x);

  vec4 clip = mix(c0, c1, aEnd);
  // Constant pixel width independent of zoom / projection.
  vec2 pixelToNdc = 2.0 / max(uResolution, vec2(1.0));
  clip.xy += perp * aSide * (0.5 * uLineWidthPx) * pixelToNdc * clip.w;
  gl_Position = clip;
}`;

const LINE_FRAG = `#version 300 es
precision highp float;
uniform vec4 uColor;
out vec4 outColor;
void main(){ outColor = uColor; }`;

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
  uPickPass: WebGLUniformLocation | null;
  uOpacity: WebGLUniformLocation | null;
  uSelectionMode: WebGLUniformLocation | null;
};

type LineUniforms = {
  uMVP: WebGLUniformLocation | null;
  uResolution: WebGLUniformLocation | null;
  uLineWidthPx: WebGLUniformLocation | null;
  uColor: WebGLUniformLocation | null;
};

type PointUniforms = {
  uMVP: WebGLUniformLocation | null;
  uEye: WebGLUniformLocation | null;
  uPointSize: WebGLUniformLocation | null;
  uColor: WebGLUniformLocation | null;
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
    uPickPass: gl.getUniformLocation(prog, 'uPickPass'),
    uOpacity: gl.getUniformLocation(prog, 'uOpacity'),
    uSelectionMode: gl.getUniformLocation(prog, 'uSelectionMode'),
  };
}

function lineUniforms(gl: WebGL2RenderingContext, prog: WebGLProgram): LineUniforms {
  return {
    uMVP: gl.getUniformLocation(prog, 'uMVP'),
    uResolution: gl.getUniformLocation(prog, 'uResolution'),
    uLineWidthPx: gl.getUniformLocation(prog, 'uLineWidthPx'),
    uColor: gl.getUniformLocation(prog, 'uColor'),
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

/** Axis-aligned ground grid covering [minX,maxX] × [minZ,maxZ] (inclusive). */
function buildGridRect(
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number,
  step: number,
): Float32Array {
  const x0 = Math.floor(minX / step) * step;
  const x1 = Math.ceil(maxX / step) * step;
  const z0 = Math.floor(minZ / step) * step;
  const z1 = Math.ceil(maxZ / step) * step;
  const lines: number[] = [];
  for (let z = z0; z <= z1 + step * 0.5; z += step) {
    lines.push(x0, 0, z, x1, 0, z);
  }
  for (let x = x0; x <= x1 + step * 0.5; x += step) {
    lines.push(x, 0, z0, x, 0, z1);
  }
  return new Float32Array(lines);
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
  private gridBounds = {
    minX: -GRID_DEFAULT_HALF,
    maxX: GRID_DEFAULT_HALF,
    minZ: -GRID_DEFAULT_HALF,
    maxZ: GRID_DEFAULT_HALF,
  };
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
  private editLineVao: WebGLVertexArrayObject;
  private editLineBuf: WebGLBuffer;
  private editLineCount = 0;
  private editHandles: {
    start: [number, number, number];
    end: [number, number, number];
  } | null = null;
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
  private sceneExtent = 10;
  private selectedPickIds: number[] = [];
  /** Locked for the whole gesture so MMB never falls through into orbit/zoom. */
  private dragMode: 'pan' | 'orbit' | null = null;
  private lastX = 0;
  private lastY = 0;
  private lastMmbAt = 0;
  private lastMmbX = 0;
  private lastMmbY = 0;
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

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      antialias: true,
      alpha: false,
      depth: true,
      stencil: false,
      premultipliedAlpha: false,
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
    this.uploadGrid();

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

    this.editLineVao = gl.createVertexArray()!;
    this.editLineBuf = gl.createBuffer()!;
    this.bindThickLineVao(this.editLineVao, this.editLineBuf);

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    // Two-sided solids: avoid empty/see-through walls if winding disagrees with the view.
    gl.disable(gl.CULL_FACE);
    gl.clearColor(0.09, 0.1, 0.12, 1);

    this.bindEvents();
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
    const expanded = expandLineSegments(segments);
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, buf);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, expanded, this.gl.DYNAMIC_DRAW);
    return expanded.length / THICK_LINE_FLOATS_PER_VERT;
  }

  getCamera(): CameraState {
    return { ...this.camera, target: [...this.camera.target] as [number, number, number] };
  }

  /** Rolling FPS from the render loop (display-synced via rAF). */
  getFps(): number {
    return this.fps;
  }

  getProjection(): ProjectionMode {
    return this.projection;
  }

  setProjection(mode: ProjectionMode): void {
    this.projection = mode;
  }

  /** Restore the default home camera pose (keeps projection mode). */
  resetCamera(): void {
    this.camera = {
      target: [...DEFAULT_CAMERA.target] as [number, number, number],
      distance: DEFAULT_CAMERA.distance,
      yaw: DEFAULT_CAMERA.yaw,
      pitch: DEFAULT_CAMERA.pitch,
    };
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

    this.edgeCount = this.uploadThickLines(this.edgeBuf, edges);

    this.selectedPickIds = data.selectedPickIds.slice(0, 32);

    const aabb = aabbFromPositions(positions);
    if (aabb) {
      const sx = aabb.max[0] - aabb.min[0];
      const sy = aabb.max[1] - aabb.min[1];
      const sz = aabb.max[2] - aabb.min[2];
      this.sceneExtent = Math.max(sx, sy, sz, 2);
      this.expandGridToInclude(aabb.min[0], aabb.max[0], aabb.min[2], aabb.max[2]);
      // Opt-in only — never yank the camera unless the caller asked.
      if (data.fitCamera === true) {
        this.fitToAabb(aabb.min, aabb.max);
      }
    } else {
      this.sceneExtent = 10;
    }
  }

  fitToAabb(min: [number, number, number], max: [number, number, number]): void {
    const cx = (min[0] + max[0]) * 0.5;
    const cy = (min[1] + max[1]) * 0.5;
    const cz = (min[2] + max[2]) * 0.5;
    const sx = Math.max(max[0] - min[0], 0.5);
    const sy = Math.max(max[1] - min[1], 0.5);
    const sz = Math.max(max[2] - min[2], 0.5);
    const radius = Math.hypot(sx, sy, sz) * 0.5;
    this.camera.target = [cx, cy, cz];
    this.camera.distance = Math.max(radius * 2.6, 6);
    this.sceneExtent = Math.max(sx, sy, sz, 2);
  }

  setSelectedPickIds(ids: number[]): void {
    this.selectedPickIds = ids.slice(0, 32);
  }

  private uploadGrid(): void {
    const { minX, maxX, minZ, maxZ } = this.gridBounds;
    const grid = buildGridRect(minX, maxX, minZ, maxZ, GRID_STEP);
    this.gridCount = this.uploadThickLines(this.gridBuf, grid);
  }

  /**
   * Grow the ground grid to cover the given XZ bounds, plus GRID_MARGIN_CELLS
   * on each side that needs expansion. Never shrinks.
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
    const span = Math.max(
      nextMaxX - nextMinX,
      nextMaxZ - nextMinZ,
      2,
    );
    this.sceneExtent = Math.max(this.sceneExtent, span);
    this.uploadGrid();
  }

  /** Preview wall centerline while placing (or clear with null). */
  setPreviewLine(
    start: [number, number, number] | null,
    end: [number, number, number] | null,
  ): void {
    if (!start || !end) {
      this.previewCount = 0;
      return;
    }
    this.expandGridToInclude(
      Math.min(start[0], end[0]),
      Math.max(start[0], end[0]),
      Math.min(start[2], end[2]),
      Math.max(start[2], end[2]),
    );
    const data = new Float32Array([
      start[0],
      start[1] + 0.02,
      start[2],
      end[0],
      end[1] + 0.02,
      end[2],
    ]);
    this.previewCount = this.uploadThickLines(this.previewBuf, data);
  }

  /** Semi-transparent ghost solid while placing a wall. */
  setGhostWall(
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

  /** Construction line + endpoint handles for the selected wall. */
  setEditGizmo(
    start: [number, number, number] | null,
    end: [number, number, number] | null,
  ): void {
    const gl = this.gl;
    if (!start || !end) {
      this.editLineCount = 0;
      this.handleCount = 0;
      this.editHandles = null;
      return;
    }
    this.expandGridToInclude(
      Math.min(start[0], end[0]),
      Math.max(start[0], end[0]),
      Math.min(start[2], end[2]),
      Math.max(start[2], end[2]),
    );
    const y = 0.03;
    const line = new Float32Array([
      start[0],
      start[1] + y,
      start[2],
      end[0],
      end[1] + y,
      end[2],
    ]);
    this.editLineCount = this.uploadThickLines(this.editLineBuf, line);

    const handles = new Float32Array([
      start[0],
      start[1] + y,
      start[2],
      end[0],
      end[1] + y,
      end[2],
    ]);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.handleBuf);
    gl.bufferData(gl.ARRAY_BUFFER, handles, gl.DYNAMIC_DRAW);
    this.handleCount = 2;
    this.editHandles = { start: [...start] as [number, number, number], end: [...end] as [number, number, number] };
  }

  /** Project world point to CSS client coordinates (relative to canvas). */
  worldToClient(p: [number, number, number]): [number, number] | null {
    const { viewProj } = this.cameraMatrices();
    const x = viewProj[0] * p[0] + viewProj[4] * p[1] + viewProj[8] * p[2] + viewProj[12];
    const y = viewProj[1] * p[0] + viewProj[5] * p[1] + viewProj[9] * p[2] + viewProj[13];
    const w = viewProj[3] * p[0] + viewProj[7] * p[1] + viewProj[11] * p[2] + viewProj[15];
    if (Math.abs(w) < 1e-8) return null;
    const ndcX = x / w;
    const ndcY = y / w;
    const rect = this.canvas.getBoundingClientRect();
    return [rect.left + ((ndcX + 1) * 0.5) * rect.width, rect.top + ((1 - ndcY) * 0.5) * rect.height];
  }

  /** Hit-test edit handles in screen space. */
  hitEditHandle(
    clientX: number,
    clientY: number,
    pixelRadius = 12,
  ): 'start' | 'end' | null {
    if (!this.editHandles) return null;
    const s = this.worldToClient([
      this.editHandles.start[0],
      this.editHandles.start[1] + 0.03,
      this.editHandles.start[2],
    ]);
    const e = this.worldToClient([
      this.editHandles.end[0],
      this.editHandles.end[1] + 0.03,
      this.editHandles.end[2],
    ]);
    if (!s || !e) return null;
    const ds = Math.hypot(clientX - s[0], clientY - s[1]);
    const de = Math.hypot(clientX - e[0], clientY - e[1]);
    if (ds <= pixelRadius && ds <= de) return 'start';
    if (de <= pixelRadius) return 'end';
    return null;
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
  }

  private bindEvents(): void {
    this.canvas.addEventListener('pointerdown', (e) => {
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
        // Alt+RMB pans (same as MMB); plain RMB orbits.
        this.beginDrag(e.altKey ? 'pan' : 'orbit', e);
      }
    });
    this.canvas.addEventListener('auxclick', (e) => {
      // Suppress browser middle-click autoscroll / open-link quirks.
      if (e.button === 1) e.preventDefault();
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.dragMode) return;
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      if (this.dragMode === 'pan') {
        // Ground-plane pan only (world XZ). Never change target Y / distance.
        this.panOnGround(dx, dy);
        return;
      }
      this.camera.yaw -= dx * 0.005;
      this.camera.pitch = Math.max(
        -PITCH_LIMIT,
        Math.min(PITCH_LIMIT, this.camera.pitch + dy * 0.005),
      );
    });
    const endDrag = () => {
      this.dragMode = null;
    };
    this.canvas.addEventListener('pointerup', endDrag);
    this.canvas.addEventListener('pointercancel', endDrag);
    this.canvas.addEventListener('lostpointercapture', endDrag);
    this.canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        // Wheel while middle-dragging is often accidental (or feels like zoom
        // during pan) — ignore until the pan gesture ends.
        if (this.dragMode === 'pan') return;
        // Do not scale the min by sceneExtent — a long wall used to lock zoom out
        // at tens/hundreds of metres and block close inspection.
        const minDist = MIN_CAMERA_DISTANCE;
        const maxDist = Math.max(this.sceneExtent * 12, 80);
        this.camera.distance = Math.max(
          minDist,
          Math.min(maxDist, this.camera.distance * (1 + e.deltaY * 0.001)),
        );
      },
      { passive: false },
    );
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private beginDrag(mode: 'pan' | 'orbit', e: PointerEvent): void {
    this.dragMode = mode;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.canvas.setPointerCapture(e.pointerId);
  }

  /** Translate look-at on the placement plane (X/Z). Screen Y → forward on ground, not world up. */
  private panOnGround(dx: number, dy: number): void {
    const right = this.cameraRight();
    const forward = this.cameraForwardXZ();
    const scale = this.camera.distance * 0.0015;
    // Grab-style: drag down (dy > 0) moves the scene down on screen → target toward camera
    // on the ground (-forward). Same sign convention as horizontal (`-= right * dx`).
    this.camera.target[0] -= (right[0] * dx - forward[0] * dy) * scale;
    this.camera.target[2] -= (right[2] * dx - forward[2] * dy) * scale;
  }

  private cameraRight(): [number, number, number] {
    const { yaw } = this.camera;
    return [Math.cos(yaw), 0, -Math.sin(yaw)];
  }

  /** Unit look direction projected onto the ground plane (Y-up world). */
  private cameraForwardXZ(): [number, number, number] {
    const { yaw } = this.camera;
    return [-Math.sin(yaw), 0, -Math.cos(yaw)];
  }

  private eyePosition(): [number, number, number] {
    const { target, distance, yaw, pitch } = this.camera;
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
    const aspect = this.canvas.clientWidth / Math.max(1, this.canvas.clientHeight);
    const gridSpan = Math.max(
      this.gridBounds.maxX - this.gridBounds.minX,
      this.gridBounds.maxZ - this.gridBounds.minZ,
      this.sceneExtent,
    );
    const radius = Math.max(this.camera.distance * 2, gridSpan, this.sceneExtent * 4, 40);
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
        gridSpan * 2,
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
    const eye = this.eyePosition();
    const view = mat4LookAt(eye, this.camera.target, [0, 1, 0]);
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
    gl.uniform1i(u.uPickPass, pickPass ? 1 : 0);

    gl.bindVertexArray(this.vao);
    gl.enable(gl.DEPTH_TEST);
    // Classic CAD: push filled surfaces back so coplanar outlines win depth.
    if (!pickPass) {
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(1, 1);
    }

    if (pickPass) {
      gl.disable(gl.BLEND);
      gl.depthMask(true);
      gl.uniform1i(u.uSelectionMode, 0);
      gl.uniform1f(u.uOpacity, 1.0);
      gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);
    } else if (this.selectedPickIds.length > 0) {
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
      gl.uniform1i(u.uSelectionMode, 0);
      gl.uniform1f(u.uOpacity, 1.0);
      gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);
    }

    if (!pickPass) gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.bindVertexArray(null);
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
    gl.uniform1f(u.uOpacity, 0.35);

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
  ): void {
    if (count === 0) return;
    const gl = this.gl;
    const { viewProj } = this.cameraMatrices();
    const u = this.lineUniforms;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    gl.disable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.useProgram(this.lineProg);
    gl.uniformMatrix4fv(u.uMVP, false, viewProj);
    gl.uniform2f(u.uResolution, this.canvas.width, this.canvas.height);
    gl.uniform1f(u.uLineWidthPx, widthPx * dpr);
    gl.uniform4f(u.uColor, color[0], color[1], color[2], color[3]);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, count);
    gl.bindVertexArray(null);
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
    gl.clearColor(0.09, 0.1, 0.12, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    // Grid: tiny bias only (lies on ground plane).
    this.drawLines(this.gridVao, this.gridCount, [0.22, 0.24, 0.28, 1], 1.25);
    this.drawMeshes(false);
    // Outlines at true depth; solids were polygon-offset back.
    this.drawLines(this.edgeVao, this.edgeCount, [0.08, 0.09, 0.1, 1], 2.0);
    this.drawGhost();
    this.drawLines(this.previewVao, this.previewCount, [0.95, 0.7, 0.3, 1], 2.25);
    this.drawLines(this.editLineVao, this.editLineCount, [0.95, 0.72, 0.28, 1], 2.25);
    this.drawHandles();
    this.frameMats = null;
  };
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
