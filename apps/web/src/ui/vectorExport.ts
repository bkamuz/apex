import type { VectorDrawing2d } from '../types';

/** Raster placed on the page (e.g. a 3D viewport), in drawing units, bottom-left origin. */
export interface PlacedImage {
  x: number;
  y: number;
  width: number;
  height: number;
  /** PNG or JPEG data URL. */
  dataUrl: string;
}

export interface DrawingPageOptions {
  title?: string;
  /** Fixed page extents in drawing units (sheet paper size); else fit the content. */
  page?: { width: number; height: number };
  images?: PlacedImage[];
}

interface Stroke {
  /** Paper millimetres. */
  width: number;
  color: string;
  /** Paper millimetres. */
  dash?: number[];
}

/** Lineweights by layer (ISO 128 pen set, paper mm). */
export function strokeForLayer(layer: string): Stroke {
  if (layer.endsWith('_CUT')) return { width: 0.5, color: '#000' };
  switch (layer) {
    case 'SHEET':
      return { width: 0.1, color: '#bbb' };
    case 'SHEET_FRAME':
      return { width: 0.7, color: '#000' };
    case 'TITLE_BLOCK':
    case 'VIEW_TITLE':
      return { width: 0.35, color: '#000' };
    case 'GRID':
      return { width: 0.13, color: '#555', dash: [6, 1.5, 0.8, 1.5] };
    case 'GRID_BUBBLE':
      return { width: 0.25, color: '#222' };
    case 'OPENING':
    case 'STAIR':
      return { width: 0.25, color: '#111' };
    case 'DIMENSION':
      return { width: 0.13, color: '#111' };
    default:
      return { width: 0.18, color: '#333' };
  }
}

const DIM_STROKE: Stroke = { width: 0.18, color: '#111' };
const TICK_STROKE: Stroke = { width: 0.35, color: '#000' };
const WALL_FILL = '#262626';

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

type Box = { minX: number; minY: number; maxX: number; maxY: number };

function contentBounds(drawing: VectorDrawing2d): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const visit = (x: number, y: number) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const line of drawing.lines) {
    visit(line.a[0], line.a[1]);
    visit(line.b[0], line.b[1]);
  }
  for (const text of drawing.texts) visit(text.position[0], text.position[1]);
  for (const dim of drawing.dimensions) {
    visit(dim.dim_a[0], dim.dim_a[1]);
    visit(dim.dim_b[0], dim.dim_b[1]);
    visit(dim.text_position[0], dim.text_position[1]);
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 100, maxY: 100 };
  const pad = Math.max((maxX - minX) * 0.02, (maxY - minY) * 0.02, 1);
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

/** One paper millimetre expressed in drawing units. */
function paperMm(drawing: VectorDrawing2d): number {
  return drawing.units === 'millimetres' ? 1 : drawing.scale_denominator / 1000;
}

/**
 * Display list shared by the SVG and PDF writers, already flipped to a
 * top-left origin page so text is never mirrored.
 */
interface Page {
  width: number;
  height: number;
  /** Drawing units per paper mm. */
  mm: number;
  unit: 'mm' | 'm';
  fills: { pts: [number, number][] }[];
  strokes: { a: [number, number]; b: [number, number]; s: Stroke }[];
  texts: { x: number; y: number; size: number; text: string; centered: boolean; angle: number; bold: boolean }[];
  images: { x: number; y: number; width: number; height: number; dataUrl: string }[];
}

function buildPage(drawing: VectorDrawing2d, opts: DrawingPageOptions): Page {
  const box: Box = opts.page
    ? { minX: 0, minY: 0, maxX: opts.page.width, maxY: opts.page.height }
    : contentBounds(drawing);
  const mm = paperMm(drawing);
  const P = (p: [number, number]): [number, number] => [p[0] - box.minX, box.maxY - p[1]];
  const page: Page = {
    width: box.maxX - box.minX,
    height: box.maxY - box.minY,
    mm,
    unit: drawing.units === 'millimetres' ? 'mm' : 'm',
    fills: [],
    strokes: [],
    texts: [],
    images: [],
  };
  for (const f of drawing.fills ?? []) page.fills.push({ pts: f.ring.map(P) });
  for (const line of drawing.lines) {
    page.strokes.push({ a: P(line.a), b: P(line.b), s: strokeForLayer(line.layer) });
  }
  for (const dim of drawing.dimensions) {
    const a = P(dim.dim_a);
    const b = P(dim.dim_b);
    page.strokes.push({ a: P(dim.extension_a), b: a, s: DIM_STROKE });
    page.strokes.push({ a: P(dim.extension_b), b, s: DIM_STROKE });
    // Dimension line runs 2 mm past each extension line, with 45° ticks.
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const over = 2 * mm;
    page.strokes.push({
      a: [a[0] - ux * over, a[1] - uy * over],
      b: [b[0] + ux * over, b[1] + uy * over],
      s: DIM_STROKE,
    });
    const t = 1.5 * mm;
    // 45° tick: along + across direction.
    const tx = (ux - uy) * Math.SQRT1_2 * t;
    const ty = (uy + ux) * Math.SQRT1_2 * t;
    for (const c of [a, b]) {
      page.strokes.push({ a: [c[0] - tx, c[1] - ty], b: [c[0] + tx, c[1] + ty], s: TICK_STROKE });
    }
    // Text sits on the dimension line's outer side, reading from below/right.
    let angle = (Math.atan2(dy, dx) * 180) / Math.PI;
    if (angle > 90) angle -= 180;
    if (angle <= -90) angle += 180;
    const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const rad = (angle * Math.PI) / 180;
    const off = 1.2 * mm;
    page.texts.push({
      x: mid[0] + Math.sin(rad) * off,
      y: mid[1] - Math.cos(rad) * off,
      size: 2.5 * mm,
      text: dim.text,
      centered: true,
      angle,
      bold: false,
    });
  }
  for (const text of drawing.texts) {
    const [x, y] = P(text.position);
    page.texts.push({
      x,
      y,
      size: text.height,
      text: text.text,
      centered: text.centered === true,
      angle: 0,
      bold: text.layer === 'VIEW_TITLE' || text.layer === 'ROOM_NAME' || text.layer === 'GRID_BUBBLE',
    });
  }
  for (const img of opts.images ?? []) {
    const [x, y] = P([img.x, img.y + img.height]);
    page.images.push({ x, y, width: img.width, height: img.height, dataUrl: img.dataUrl });
  }
  return page;
}

const fmt = (n: number) => (Math.round(n * 1000) / 1000).toString();

/** Shared vector → SVG (same geometry as DXF export), page at true size. */
export function drawingToSvg(drawing: VectorDrawing2d, titleOrOpts?: string | DrawingPageOptions): string {
  const opts: DrawingPageOptions =
    typeof titleOrOpts === 'string' ? { title: titleOrOpts } : (titleOrOpts ?? {});
  const page = buildPage(drawing, opts);
  const mm = page.mm;
  let body = '';
  for (const img of page.images) {
    body += `<image x="${fmt(img.x)}" y="${fmt(img.y)}" width="${fmt(img.width)}" height="${fmt(img.height)}" href="${img.dataUrl}" preserveAspectRatio="xMidYMid meet"/>`;
  }
  if (page.fills.length) {
    body += `<g fill="${WALL_FILL}" stroke="none">`;
    for (const f of page.fills) {
      body += `<polygon points="${f.pts.map((p) => `${fmt(p[0])},${fmt(p[1])}`).join(' ')}"/>`;
    }
    body += '</g>';
  }
  for (const { a, b, s } of page.strokes) {
    const dash = s.dash ? ` stroke-dasharray="${s.dash.map((d) => fmt(d * mm)).join(' ')}"` : '';
    body += `<line x1="${fmt(a[0])}" y1="${fmt(a[1])}" x2="${fmt(b[0])}" y2="${fmt(b[1])}" stroke="${s.color}" stroke-width="${fmt(s.width * mm)}" stroke-linecap="round"${dash}/>`;
  }
  for (const t of page.texts) {
    const anchor = t.centered ? ' text-anchor="middle" dominant-baseline="central"' : '';
    const rot = t.angle ? ` transform="rotate(${fmt(t.angle)} ${fmt(t.x)} ${fmt(t.y)})"` : '';
    const weight = t.bold ? ' font-weight="bold"' : '';
    body += `<text x="${fmt(t.x)}" y="${fmt(t.y)}" font-size="${fmt(t.size)}"${anchor}${rot}${weight}>${escapeXml(t.text)}</text>`;
  }
  const titleTag = opts.title ? `<title>${escapeXml(opts.title)}</title>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(page.width)}${page.unit}" height="${fmt(page.height)}${page.unit}" viewBox="0 0 ${fmt(page.width)} ${fmt(page.height)}" font-family="Helvetica, Arial, sans-serif" fill="#111">
  ${titleTag}
  <rect x="0" y="0" width="${fmt(page.width)}" height="${fmt(page.height)}" fill="#ffffff"/>
  ${body}
</svg>`;
}

// ---------------------------------------------------------------- PDF

function dataUrlBytes(dataUrl: string): Uint8Array {
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function jpegSize(bytes: Uint8Array): { w: number; h: number } {
  let i = 2;
  while (i < bytes.length) {
    if (bytes[i] !== 0xff) return { w: 0, h: 0 };
    const marker = bytes[i + 1]!;
    const len = (bytes[i + 2]! << 8) | bytes[i + 3]!;
    if (marker >= 0xc0 && marker <= 0xc3) {
      return { h: (bytes[i + 5]! << 8) | bytes[i + 6]!, w: (bytes[i + 7]! << 8) | bytes[i + 8]! };
    }
    i += 2 + len;
  }
  return { w: 0, h: 0 };
}

function pdfString(text: string): string {
  // WinAnsi: keep Latin-1, map common extras, escape delimiters.
  let out = '';
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    let byte: number;
    if (ch === '—' || ch === '–') byte = 0x96;
    else if (c < 256) byte = c;
    else byte = 0x3f;
    if (ch === '(' || ch === ')' || ch === '\\') out += '\\' + ch;
    else if (byte < 32 || byte > 126) out += '\\' + byte.toString(8).padStart(3, '0');
    else out += String.fromCharCode(byte);
  }
  return out;
}

/** Approximate Helvetica advance (em) for centring. */
function textWidthEm(text: string): number {
  let w = 0;
  for (const ch of text) w += /[iljtf.,:;'| ]/.test(ch) ? 0.3 : /[A-Z0-9mwMW]/.test(ch) ? 0.66 : 0.53;
  return w;
}

/**
 * Minimal vector PDF writer (PDF 1.4): lines, filled polygons, Helvetica text,
 * JPEG images. Page size equals the drawing page; 1 unit = 1 mm when the
 * drawing is in millimetres.
 */
export function drawingToPdf(drawing: VectorDrawing2d, opts: DrawingPageOptions = {}): Uint8Array {
  const page = buildPage(drawing, opts);
  // PDF user space: points, bottom-left origin.
  // Points per drawing unit; model-unit drawings print at their view scale.
  const k = page.unit === 'mm' ? 72 / 25.4 : (72 / 25.4) * (1000 / drawing.scale_denominator);
  const W = page.width * k;
  const H = page.height * k;
  const X = (x: number) => fmt(x * k);
  const Y = (y: number) => fmt(H - y * k);
  const ops: string[] = [];
  const images: { name: string; bytes: Uint8Array; w: number; h: number }[] = [];
  page.images.forEach((img, i) => {
    if (!img.dataUrl.startsWith('data:image/jpeg')) return;
    const bytes = dataUrlBytes(img.dataUrl);
    const { w, h } = jpegSize(bytes);
    if (!w || !h) return;
    const name = `Im${i}`;
    images.push({ name, bytes, w, h });
    ops.push(`q ${fmt(img.width * k)} 0 0 ${fmt(img.height * k)} ${X(img.x)} ${fmt(H - (img.y + img.height) * k)} cm /${name} Do Q`);
  });
  if (page.fills.length) {
    ops.push('0.15 0.15 0.15 rg');
    for (const f of page.fills) {
      ops.push(f.pts.map((p, i) => `${X(p[0])} ${Y(p[1])} ${i ? 'l' : 'm'}`).join(' ') + ' h f');
    }
  }
  ops.push('1 J');
  let cur = '';
  for (const { a, b, s } of page.strokes) {
    const g = s.color === '#000' ? 0 : parseInt(s.color.slice(1, 2), 16) / 15;
    const state = `${fmt(g)} G ${fmt(s.width * page.mm * k)} w [${(s.dash ?? []).map((d) => fmt(d * page.mm * k)).join(' ')}] 0 d`;
    if (state !== cur) {
      ops.push(state);
      cur = state;
    }
    ops.push(`${X(a[0])} ${Y(a[1])} m ${X(b[0])} ${Y(b[1])} l S`);
  }
  ops.push('0.07 g');
  for (const t of page.texts) {
    const size = t.size * k;
    const font = t.bold ? '/F2' : '/F1';
    const rad = (-t.angle * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    let dx = 0;
    let dy = 0;
    if (t.centered) {
      dx = -textWidthEm(t.text) * size * 0.5;
      dy = -size * 0.35;
    }
    const x = t.x * k;
    const y = H - t.y * k;
    const tx = x + dx * cos - dy * sin;
    const ty = y + dx * sin + dy * cos;
    ops.push(
      `BT ${font} ${fmt(size)} Tf ${fmt(cos)} ${fmt(sin)} ${fmt(-sin)} ${fmt(cos)} ${fmt(tx)} ${fmt(ty)} Tm (${pdfString(t.text)}) Tj ET`,
    );
  }
  const content = ops.join('\n');

  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (data: string | Uint8Array) => {
    const bytes = typeof data === 'string' ? enc.encode(data) : data;
    chunks.push(bytes);
    length += bytes.length;
  };
  const obj = (n: number, body: string | (string | Uint8Array)[]) => {
    offsets[n] = length;
    push(`${n} 0 obj\n`);
    if (typeof body === 'string') push(body);
    else body.forEach(push);
    push('\nendobj\n');
  };
  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const imgBase = 7;
  const xobjects = images.map((im, i) => `/${im.name} ${imgBase + i} 0 R`).join(' ');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  obj(
    3,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${fmt(W)} ${fmt(H)}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> /XObject << ${xobjects} >> >> >>`,
  );
  const contentBytes = enc.encode(content);
  obj(4, [`<< /Length ${contentBytes.length} >>\nstream\n`, contentBytes, '\nendstream']);
  obj(5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  obj(6, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  images.forEach((im, i) => {
    obj(imgBase + i, [
      `<< /Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${im.bytes.length} >>\nstream\n`,
      im.bytes,
      '\nendstream',
    ]);
  });
  const count = imgBase + images.length;
  const xref = length;
  let table = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let n = 1; n < count; n += 1) table += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  push(table);
  push(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(length);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** Flatten a (possibly transparent) PNG data URL onto white and re-encode as JPEG. */
export async function toJpegDataUrl(dataUrl: string, quality = 0.92): Promise<string> {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext('2d');
  if (!ctx) return dataUrl;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, 0, 0);
  return c.toDataURL('image/jpeg', quality);
}

export function openSvgForPrint(svg: string): void {
  const win = window.open('', '_blank');
  if (!win) return;
  win.document.write(
    `<!DOCTYPE html><html><head><title>Print</title></head><body style="margin:0">${svg}</body></html>`,
  );
  win.document.close();
  win.focus();
  win.print();
}

export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadTextFile(filename: string, content: string, mime: string): void {
  downloadBlob(filename, new Blob([content], { type: mime }));
}
