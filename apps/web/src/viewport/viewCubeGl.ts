/**
 * WebGL2 view-cube: six textured quads with perspective-correct sampling.
 * Labels are baked axis-aligned into face textures (true face UV) so baselines
 * stay parallel to each face's width edges under any camera.
 */
import { FACE_LABEL, type ViewCubeFace } from './viewCube';

const FACE_TEX = 256;

const FACE_FILL: Record<ViewCubeFace, string> = {
  front: '#636360',
  back: '#4e4e4c',
  right: '#585856',
  left: '#585856',
  top: '#6a6a66',
  bottom: '#454543',
};

const FACE_FILL_HOVER = '#5a7d4e';

const FACES: readonly ViewCubeFace[] = ['front', 'back', 'right', 'left', 'top', 'bottom'];

/** Two triangles from BL,BR,TR,TL (each corner [x,y,z]). UV: (0,0)=BL … (1,1)=TR. */
function quad(
  bl: readonly [number, number, number],
  br: readonly [number, number, number],
  tr: readonly [number, number, number],
  tl: readonly [number, number, number],
): Float32Array {
  // v=0 at face bottom; canvas upload uses UNPACK_FLIP_Y so glyph tops → high V.
  return new Float32Array([
    bl[0], bl[1], bl[2], 0, 0, br[0], br[1], br[2], 1, 0, tr[0], tr[1], tr[2], 1, 1,
    bl[0], bl[1], bl[2], 0, 0, tr[0], tr[1], tr[2], 1, 1, tl[0], tl[1], tl[2], 0, 1,
  ]);
}

/**
 * Quad verts CCW from outside, Y-up.
 * Width = left→right from outside; height = bottom→top (or toward face "up").
 */
function faceMesh(face: ViewCubeFace): Float32Array {
  switch (face) {
    case 'front': // +Z — width +X, height +Y
      return quad([-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]);
    case 'back': // -Z — width −X (outside left→right), height +Y
      return quad([1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]);
    case 'right': // +X — width −Z, height +Y
      return quad([1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]);
    case 'left': // -X — width +Z, height +Y
      return quad([-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]);
    case 'top': // +Y — width +X, "up" toward −Z (back) so readable from front
      return quad([-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]);
    case 'bottom': // -Y — width +X, "up" toward +Z (front) so readable from front
      return quad([-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]);
    default: {
      const _exhaustive: never = face;
      return _exhaustive;
    }
  }
}

/** Bake an axis-aligned label into a square canvas (face UV space). */
function bakeFaceCanvas(face: ViewCubeFace, hover: boolean): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = FACE_TEX;
  canvas.height = FACE_TEX;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = hover ? FACE_FILL_HOVER : FACE_FILL[face];
  ctx.fillRect(0, 0, FACE_TEX, FACE_TEX);
  ctx.strokeStyle = hover ? '#6f9460' : '#111111';
  ctx.lineWidth = 8;
  ctx.strokeRect(4, 4, FACE_TEX - 8, FACE_TEX - 8);

  const label = FACE_LABEL[face];
  let fontPx = 56;
  ctx.font = `700 ${fontPx}px "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif`;
  while (ctx.measureText(label).width > FACE_TEX * 0.78 && fontPx > 22) {
    fontPx -= 1;
    ctx.font = `700 ${fontPx}px "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif`;
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(12,12,12,0.95)';
  ctx.lineWidth = Math.max(4, fontPx * 0.2);
  ctx.strokeText(label, FACE_TEX / 2, FACE_TEX / 2);
  ctx.fillStyle = hover ? '#e8f0e4' : '#f2f2f2';
  ctx.fillText(label, FACE_TEX / 2, FACE_TEX / 2);
  return canvas;
}

const VERT = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec2 aUv;
uniform mat4 uMVP;
out vec2 vUv;
void main(){
  vUv = aUv;
  gl_Position = uMVP * vec4(aPos, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
out vec4 outColor;
void main(){
  outColor = texture(uTex, vUv);
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
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(p);
    gl.deleteProgram(p);
    throw new Error(info ?? 'program link failed');
  }
  return p;
}

/** Symmetric ortho frustum (CAD view cubes avoid strong perspective warp). */
function mat4Ortho(half: number, aspect: number, near: number, far: number): Float32Array {
  const r = half * aspect;
  const t = half;
  const out = new Float32Array(16);
  out[0] = 1 / r;
  out[5] = 1 / t;
  out[10] = -2 / (far - near);
  out[14] = -(far + near) / (far - near);
  out[15] = 1;
  return out;
}

/** Column-major lookAt matching ViewportRenderer / gl-matrix. */
function mat4LookAt(
  eye: [number, number, number],
  center: [number, number, number],
  up: [number, number, number],
): Float32Array {
  const zx = eye[0] - center[0];
  const zy = eye[1] - center[1];
  const zz = eye[2] - center[2];
  let len = Math.hypot(zx, zy, zz) || 1;
  const z0 = zx / len;
  const z1 = zy / len;
  const z2 = zz / len;
  let xx = up[1] * z2 - up[2] * z1;
  let xy = up[2] * z0 - up[0] * z2;
  let xz = up[0] * z1 - up[1] * z0;
  len = Math.hypot(xx, xy, xz) || 1;
  xx /= len;
  xy /= len;
  xz /= len;
  const yx = z1 * xz - z2 * xy;
  const yy = z2 * xx - z0 * xz;
  const yz = z0 * xy - z1 * xx;
  const out = new Float32Array(16);
  out[0] = xx;
  out[1] = yx;
  out[2] = z0;
  out[3] = 0;
  out[4] = xy;
  out[5] = yy;
  out[6] = z1;
  out[7] = 0;
  out[8] = xz;
  out[9] = yz;
  out[10] = z2;
  out[11] = 0;
  out[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
  out[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
  out[14] = -(z0 * eye[0] + z1 * eye[1] + z2 * eye[2]);
  out[15] = 1;
  return out;
}

function mat4Multiply(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

export class ViewCubeGl {
  private readonly gl: WebGL2RenderingContext;
  private readonly prog: WebGLProgram;
  private readonly uMVP: WebGLUniformLocation;
  private readonly uTex: WebGLUniformLocation;
  private readonly vao: WebGLVertexArrayObject;
  private readonly buf: WebGLBuffer;
  private readonly texNormal = new Map<ViewCubeFace, WebGLTexture>();
  private readonly texHover = new Map<ViewCubeFace, WebGLTexture>();
  private hoverFaces = new Set<ViewCubeFace>();
  private disposed = false;

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: true,
      premultipliedAlpha: true,
      preserveDrawingBuffer: true,
    });
    if (!gl) throw new Error('WebGL2 not available for view cube');
    this.gl = gl;
    this.prog = link(gl, VERT, FRAG);
    this.uMVP = gl.getUniformLocation(this.prog, 'uMVP')!;
    this.uTex = gl.getUniformLocation(this.prog, 'uTex')!;

    this.vao = gl.createVertexArray()!;
    this.buf = gl.createBuffer()!;
    const meshes = FACES.map((f) => faceMesh(f));
    const packed = new Float32Array(meshes.reduce((n, m) => n + m.length, 0));
    let off = 0;
    for (const m of meshes) {
      packed.set(m, off);
      off += m.length;
    }
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, packed, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 20, 12);
    gl.bindVertexArray(null);

    for (const face of FACES) {
      this.texNormal.set(face, this.uploadCanvas(bakeFaceCanvas(face, false)));
      this.texHover.set(face, this.uploadCanvas(bakeFaceCanvas(face, true)));
    }

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.clearColor(0, 0, 0, 0);
  }

  /** Upload HTMLCanvasElement so UNPACK_FLIP_Y_WEBGL applies (unlike raw ArrayBufferView). */
  private uploadCanvas(canvas: HTMLCanvasElement): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  setHoverFaces(faces: readonly ViewCubeFace[]): void {
    this.hoverFaces = new Set(faces);
  }

  /** Draw cube for camera yaw/pitch (same eye convention as ViewportRenderer). */
  draw(cssW: number, cssH: number, yaw: number, pitch: number): void {
    if (this.disposed) return;
    const gl = this.gl;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (gl.canvas.width !== w || gl.canvas.height !== h) {
      gl.canvas.width = w;
      gl.canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const cp = Math.cos(pitch);
    const dist = 5;
    const eye: [number, number, number] = [
      Math.sin(yaw) * cp * dist,
      Math.sin(pitch) * dist,
      Math.cos(yaw) * cp * dist,
    ];
    // Near ±90° pitch, world-Y up is nearly parallel to the view axis — use yaw-stable up
    // matching ViewportRenderer lookAt at the pitch clamp (view-up → −yaw horiz. when above).
    const up: [number, number, number] =
      Math.abs(cp) < 0.02
        ? pitch > 0
          ? [-Math.sin(yaw), 0, -Math.cos(yaw)]
          : [Math.sin(yaw), 0, Math.cos(yaw)]
        : [0, 1, 0];
    const view = mat4LookAt(eye, [0, 0, 0], up);
    // Tight frustum so the unit cube fills most of the widget.
    const proj = mat4Ortho(1.35, cssW / Math.max(1, cssH), 0.1, 20);
    const mvp = mat4Multiply(proj, view);

    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(this.uMVP, false, mvp);
    gl.uniform1i(this.uTex, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindVertexArray(this.vao);

    let base = 0;
    for (const face of FACES) {
      const tex = this.hoverFaces.has(face) ? this.texHover.get(face)! : this.texNormal.get(face)!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.drawArrays(gl.TRIANGLES, base, 6);
      base += 6;
    }
    gl.bindVertexArray(null);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.gl;
    for (const t of this.texNormal.values()) gl.deleteTexture(t);
    for (const t of this.texHover.values()) gl.deleteTexture(t);
    gl.deleteBuffer(this.buf);
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.prog);
  }
}
