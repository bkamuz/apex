/** Flat-buffer WebGL2 renderer — solid + CAD edges, pick by triangle id. */

export interface SceneMeshData {
  positions: ArrayLike<number>;
  normals: ArrayLike<number>;
  indices: ArrayLike<number>;
  pickIds: ArrayLike<number>;
  edgePositions?: ArrayLike<number>;
  selectedPickId: number | null;
  fitCamera?: boolean;
}

export interface CameraState {
  target: [number, number, number];
  distance: number;
  yaw: number;
  pitch: number;
}

const DEFAULT_CAMERA: CameraState = {
  target: [0, 1.2, 0],
  distance: 18,
  yaw: 0.7,
  pitch: 0.55,
};

const MMB_DBLCLICK_MS = 400;
const MMB_DBLCLICK_PX = 8;

export const GRID_STEP = 1.0;
/** Extra cells beyond scene/placement bounds when growing the ground grid. */
export const GRID_MARGIN_CELLS = 4;
const GRID_DEFAULT_HALF = 20;
/** Orbit pitch clamp (radians). Symmetric so the camera can go under the model. */
const PITCH_LIMIT = 1.45; // ~83°, keeps cos(pitch) away from 0

/** Center of a wall on its placement plane (XZ at base Y), not mid-height. */
export function wallPlacementCenter(
  start: [number, number, number],
  end: [number, number, number],
): [number, number, number] {
  return [
    (start[0] + end[0]) * 0.5,
    Math.min(start[1], end[1]),
    (start[2] + end[2]) * 0.5,
  ];
}

type Vec3 = [number, number, number];

function vSub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function vAdd(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function vScale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

function vDot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function vLen(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

function vNormalize(a: Vec3): Vec3 | null {
  const l = vLen(a);
  if (l < 1e-8) return null;
  return [a[0] / l, a[1] / l, a[2] / l];
}

function vCross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** Rotate `point` around `pivot` by `angle` radians about unit `axis` (Rodrigues). */
function rotateAroundAxis(point: Vec3, pivot: Vec3, axis: Vec3, angle: number): Vec3 {
  const v = vSub(point, pivot);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const cross = vCross(axis, v);
  const dot = vDot(axis, v);
  return vAdd(
    pivot,
    vAdd(vAdd(vScale(v, cos), vScale(cross, sin)), vScale(axis, dot * (1 - cos))),
  );
}

const VERT = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in float aPick;
uniform mat4 uMVP;
uniform mat4 uModel;
uniform mat3 uNormalMat;
uniform vec3 uEye;
uniform float uSolidBias;
out vec3 vNormal;
out vec3 vWorld;
flat out float vPick;
void main(){
  vec3 p = aPos;
  // Push solid slightly away from the camera (world meters). CAD edges stay at
  // true positions and win coplanar z-fights, while back edges remain behind
  // the front face even when zoomed out (fixed NDC bias fails there).
  vec3 toEye = uEye - aPos;
  float dist = length(toEye);
  if (dist > 1e-5 && uSolidBias > 0.0) {
    p -= (toEye / dist) * uSolidBias;
  }
  vec4 world = uModel * vec4(p, 1.0);
  vWorld = world.xyz;
  vNormal = normalize(uNormalMat * aNormal);
  vPick = aPick;
  gl_Position = uMVP * vec4(p, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
in vec3 vNormal;
in vec3 vWorld;
flat in float vPick;
uniform vec3 uLightDir;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
uniform float uSelectedPick;
uniform bool uPickPass;
uniform float uOpacity;
uniform int uSelectionMode; // 0=all, 1=opaque others, 2=selected only
out vec4 outColor;
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
  bool selected = abs(vPick - uSelectedPick) < 0.5 && uSelectedPick > 0.0;
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
layout(location=0) in vec3 aPos;
uniform mat4 uMVP;
uniform vec3 uEye;
uniform float uWorldBias;
void main(){
  // Optional tiny pull toward camera (meters). Prefer solid-away bias instead;
  // keep this near zero for CAD edges so zoomed-out back edges stay occluded.
  vec3 toEye = uEye - aPos;
  float dist = length(toEye);
  vec3 p = aPos;
  if (dist > 1e-5 && uWorldBias > 0.0) {
    p += (toEye / dist) * uWorldBias;
  }
  gl_Position = uMVP * vec4(p, 1.0);
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
  private sceneExtent = 10;
  private selectedPickId: number | null = null;
  /** When set, RMB orbit rotates the view around this placement-plane point. */
  private orbitPivot: [number, number, number] | null = null;
  /** Locked for the whole gesture so MMB never falls through into orbit/zoom. */
  private dragMode: 'pan' | 'orbit' | null = null;
  private lastX = 0;
  private lastY = 0;
  private lastMmbAt = 0;
  private lastMmbX = 0;
  private lastMmbY = 0;
  private raf = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      antialias: true,
      alpha: false,
      depth: true,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
    });
    if (!gl) throw new Error('WebGL2 not available');
    this.gl = gl;
    this.meshProg = link(gl, VERT, FRAG);
    this.lineProg = link(gl, LINE_VERT, LINE_FRAG);
    this.pointProg = link(gl, POINT_VERT, POINT_FRAG);

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
    gl.bindVertexArray(this.edgeVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.edgeBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this.gridVao = gl.createVertexArray()!;
    this.gridBuf = gl.createBuffer()!;
    gl.bindVertexArray(this.gridVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.gridBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.uploadGrid();

    this.previewVao = gl.createVertexArray()!;
    this.previewBuf = gl.createBuffer()!;
    gl.bindVertexArray(this.previewVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.previewBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

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
    gl.bindVertexArray(this.editLineVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.editLineBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

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

  getCamera(): CameraState {
    return { ...this.camera, target: [...this.camera.target] as [number, number, number] };
  }

  /** Restore the default home camera (does not clear selection / orbit pivot). */
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

    gl.bindBuffer(gl.ARRAY_BUFFER, this.edgeBuf);
    gl.bufferData(gl.ARRAY_BUFFER, edges, gl.DYNAMIC_DRAW);
    this.edgeCount = edges.length / 3;

    this.selectedPickId = data.selectedPickId;

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

  setSelectedPickId(id: number | null): void {
    this.selectedPickId = id;
  }

  /**
   * Set/clear the selection orbit pivot. Does not move the camera — only
   * changes what point RMB orbit rotates around.
   */
  setOrbitPivot(point: [number, number, number] | null): void {
    this.orbitPivot = point ? [point[0], point[1], point[2]] : null;
  }

  /** Rotate eye + look-at around `orbitPivot` (yaw around world Y, pitch around view right). */
  private orbitAroundPivot(yawDelta: number, pitchDelta: number): void {
    const pivot = this.orbitPivot;
    if (!pivot) return;

    let eye = this.eyePosition();
    let target: Vec3 = [...this.camera.target];
    const up: Vec3 = [0, 1, 0];

    eye = rotateAroundAxis(eye, pivot, up, yawDelta);
    target = rotateAroundAxis(target, pivot, up, yawDelta);

    const forward = vNormalize(vSub(target, eye));
    let right = forward ? vNormalize(vCross(forward, up)) : null;
    if (!right) {
      // Looking along ±Y — fall back to yaw-based right.
      right = [Math.cos(this.camera.yaw), 0, -Math.sin(this.camera.yaw)];
    }

    // Clamp pitch using the eye's elevation around the pivot.
    const toEye = vSub(eye, pivot);
    const elevDist = vLen(toEye);
    const elev =
      elevDist > 1e-8 ? Math.asin(Math.max(-1, Math.min(1, toEye[1] / elevDist))) : 0;
    let pitch = pitchDelta;
    if (elev + pitch > PITCH_LIMIT) pitch = PITCH_LIMIT - elev;
    if (elev + pitch < -PITCH_LIMIT) pitch = -PITCH_LIMIT - elev;

    if (Math.abs(pitch) > 1e-8) {
      eye = rotateAroundAxis(eye, pivot, right, pitch);
      target = rotateAroundAxis(target, pivot, right, pitch);
    }

    this.applyEyeAndTarget(eye, target);
  }

  /** Write spherical camera state from an explicit eye + look-at. */
  private applyEyeAndTarget(eye: Vec3, target: Vec3): void {
    this.camera.target = [target[0], target[1], target[2]];
    const dx = eye[0] - target[0];
    const dy = eye[1] - target[1];
    const dz = eye[2] - target[2];
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 1e-6) return;
    this.camera.distance = dist;
    this.camera.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, Math.asin(dy / dist)));
    this.camera.yaw = Math.atan2(dx, dz);
  }

  private uploadGrid(): void {
    const gl = this.gl;
    const { minX, maxX, minZ, maxZ } = this.gridBounds;
    const grid = buildGridRect(minX, maxX, minZ, maxZ, GRID_STEP);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.gridBuf);
    gl.bufferData(gl.ARRAY_BUFFER, grid, gl.DYNAMIC_DRAW);
    this.gridCount = grid.length / 3;
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
    const gl = this.gl;
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
    gl.bindBuffer(gl.ARRAY_BUFFER, this.previewBuf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    this.previewCount = 2;
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
    gl.bindBuffer(gl.ARRAY_BUFFER, this.editLineBuf);
    gl.bufferData(gl.ARRAY_BUFFER, line, gl.DYNAMIC_DRAW);
    this.editLineCount = 2;

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
    const { eye, viewProjInv } = this.cameraMatrices();
    const nearPt = this.unproject(x, y, -1, viewProjInv);
    const farPt = this.unproject(x, y, 1, viewProjInv);
    const dir = [farPt[0] - nearPt[0], farPt[1] - nearPt[1], farPt[2] - nearPt[2]] as [
      number,
      number,
      number,
    ];
    if (Math.abs(dir[1]) < 1e-8) return null;
    const t = (elevation - eye[1]) / dir[1];
    if (t < 0) return null;
    return [eye[0] + dir[0] * t, elevation, eye[2] + dir[2] * t];
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
      if (this.orbitPivot) {
        // Rotate the whole view around the selection placement center — do not
        // snap the look-at to that center (avoids framing jumps on select).
        this.orbitAroundPivot(-dx * 0.005, dy * 0.005);
      } else {
        this.camera.yaw -= dx * 0.005;
        this.camera.pitch = Math.max(
          -PITCH_LIMIT,
          Math.min(PITCH_LIMIT, this.camera.pitch + dy * 0.005),
        );
      }
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
        const minDist = Math.max(this.sceneExtent * 0.35, 2);
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
    this.camera.target[0] -= (right[0] * dx + forward[0] * dy) * scale;
    this.camera.target[2] -= (right[2] * dx + forward[2] * dy) * scale;
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
    this.resize();
    const aspect = this.canvas.clientWidth / Math.max(1, this.canvas.clientHeight);
    // Keep near/far ratio modest for depth precision when zoomed out.
    const near = Math.max(0.05, this.camera.distance * 0.04);
    const far = Math.max(this.camera.distance * 12, this.sceneExtent * 4, near + 20);
    const proj = mat4Perspective((50 * Math.PI) / 180, aspect, near, far);
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
    const { viewProj, eye } = this.cameraMatrices();
    gl.useProgram(this.meshProg);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.meshProg, 'uMVP'), false, viewProj);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.meshProg, 'uModel'), false, mat4Identity());
    gl.uniformMatrix3fv(
      gl.getUniformLocation(this.meshProg, 'uNormalMat'),
      false,
      new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
    );
    gl.uniform3fv(gl.getUniformLocation(this.meshProg, 'uEye'), new Float32Array(eye));
    // Pick pass must stay unbiased for accurate hits.
    gl.uniform1f(gl.getUniformLocation(this.meshProg, 'uSolidBias'), pickPass ? 0.0 : 0.012);
    gl.uniform3fv(gl.getUniformLocation(this.meshProg, 'uLightDir'), new Float32Array([0.45, 0.85, 0.35]));
    gl.uniform3fv(gl.getUniformLocation(this.meshProg, 'uSkyColor'), new Float32Array([0.92, 0.94, 0.98]));
    gl.uniform3fv(gl.getUniformLocation(this.meshProg, 'uGroundColor'), new Float32Array([0.28, 0.3, 0.34]));
    gl.uniform1f(gl.getUniformLocation(this.meshProg, 'uSelectedPick'), this.selectedPickId ?? 0);
    gl.uniform1i(gl.getUniformLocation(this.meshProg, 'uPickPass'), pickPass ? 1 : 0);

    gl.bindVertexArray(this.vao);
    gl.enable(gl.DEPTH_TEST);

    if (pickPass) {
      gl.disable(gl.BLEND);
      gl.depthMask(true);
      gl.uniform1i(gl.getUniformLocation(this.meshProg, 'uSelectionMode'), 0);
      gl.uniform1f(gl.getUniformLocation(this.meshProg, 'uOpacity'), 1.0);
      gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);
    } else if (this.selectedPickId != null && this.selectedPickId > 0) {
      // Opaque walls first (skip selection).
      gl.disable(gl.BLEND);
      gl.depthMask(true);
      gl.uniform1i(gl.getUniformLocation(this.meshProg, 'uSelectionMode'), 1);
      gl.uniform1f(gl.getUniformLocation(this.meshProg, 'uOpacity'), 1.0);
      gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);

      // Selected wall: translucent so the construction line reads clearly.
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      gl.uniform1i(gl.getUniformLocation(this.meshProg, 'uSelectionMode'), 2);
      gl.uniform1f(gl.getUniformLocation(this.meshProg, 'uOpacity'), 0.38);
      gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);

      gl.depthMask(true);
      gl.disable(gl.BLEND);
    } else {
      gl.disable(gl.BLEND);
      gl.depthMask(true);
      gl.uniform1i(gl.getUniformLocation(this.meshProg, 'uSelectionMode'), 0);
      gl.uniform1f(gl.getUniformLocation(this.meshProg, 'uOpacity'), 1.0);
      gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);
    }

    gl.bindVertexArray(null);
  }

  private drawGhost(): void {
    const gl = this.gl;
    if (this.ghostIndexCount === 0) return;
    const { viewProj, eye } = this.cameraMatrices();
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.enable(gl.DEPTH_TEST);
    gl.useProgram(this.meshProg);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.meshProg, 'uMVP'), false, viewProj);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.meshProg, 'uModel'), false, mat4Identity());
    gl.uniformMatrix3fv(
      gl.getUniformLocation(this.meshProg, 'uNormalMat'),
      false,
      new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
    );
    gl.uniform3fv(gl.getUniformLocation(this.meshProg, 'uEye'), new Float32Array(eye));
    gl.uniform1f(gl.getUniformLocation(this.meshProg, 'uSolidBias'), 0.0);
    gl.uniform3fv(gl.getUniformLocation(this.meshProg, 'uLightDir'), new Float32Array([0.45, 0.85, 0.35]));
    gl.uniform3fv(gl.getUniformLocation(this.meshProg, 'uSkyColor'), new Float32Array([0.95, 0.9, 0.75]));
    gl.uniform3fv(gl.getUniformLocation(this.meshProg, 'uGroundColor'), new Float32Array([0.45, 0.35, 0.2]));
    gl.uniform1f(gl.getUniformLocation(this.meshProg, 'uSelectedPick'), 0);
    gl.uniform1i(gl.getUniformLocation(this.meshProg, 'uPickPass'), 0);
    gl.uniform1i(gl.getUniformLocation(this.meshProg, 'uSelectionMode'), 0);
    gl.uniform1f(gl.getUniformLocation(this.meshProg, 'uOpacity'), 0.35);

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
    worldBiasMeters = 0.01,
  ): void {
    if (count === 0) return;
    const gl = this.gl;
    const { viewProj, eye } = this.cameraMatrices();
    gl.disable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.useProgram(this.lineProg);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.lineProg, 'uMVP'), false, viewProj);
    gl.uniform3fv(gl.getUniformLocation(this.lineProg, 'uEye'), new Float32Array(eye));
    gl.uniform1f(gl.getUniformLocation(this.lineProg, 'uWorldBias'), worldBiasMeters);
    gl.uniform4f(gl.getUniformLocation(this.lineProg, 'uColor'), color[0], color[1], color[2], color[3]);
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.LINES, 0, count);
    gl.bindVertexArray(null);
  }

  private drawHandles(): void {
    if (this.handleCount === 0) return;
    const gl = this.gl;
    const { viewProj, eye } = this.cameraMatrices();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(this.pointProg);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.pointProg, 'uMVP'), false, viewProj);
    gl.uniform3fv(gl.getUniformLocation(this.pointProg, 'uEye'), new Float32Array(eye));
    gl.uniform1f(gl.getUniformLocation(this.pointProg, 'uPointSize'), 8 * dpr);
    gl.uniform4f(gl.getUniformLocation(this.pointProg, 'uColor'), 0.95, 0.72, 0.28, 1);
    gl.bindVertexArray(this.handleVao);
    gl.drawArrays(gl.POINTS, 0, this.handleCount);
    gl.bindVertexArray(null);
    gl.enable(gl.DEPTH_TEST);
  }

  private loop = (): void => {
    this.raf = requestAnimationFrame(this.loop);
    const gl = this.gl;
    this.resize();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.clearColor(0.09, 0.1, 0.12, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    // Grid: tiny bias only (lies on ground plane).
    this.drawLines(this.gridVao, this.gridCount, [0.22, 0.24, 0.28, 1], 0.002);
    this.drawMeshes(false);
    // CAD edges at true depth (solids are pushed away) — no toward-camera bias.
    this.drawLines(this.edgeVao, this.edgeCount, [0.12, 0.13, 0.15, 1], 0.0);
    this.drawGhost();
    this.drawLines(this.previewVao, this.previewCount, [0.95, 0.7, 0.3, 1], 0.01);
    this.drawLines(this.editLineVao, this.editLineCount, [0.95, 0.72, 0.28, 1], 0.01);
    this.drawHandles();
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
