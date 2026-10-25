import type { VectorDrawing2d } from '../types';

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function bounds(drawing: VectorDrawing2d): { minX: number; minY: number; maxX: number; maxY: number } {
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
  for (const text of drawing.texts) {
    visit(text.position[0], text.position[1]);
  }
  for (const dim of drawing.dimensions) {
    visit(dim.dim_a[0], dim.dim_a[1]);
    visit(dim.dim_b[0], dim.dim_b[1]);
    visit(dim.text_position[0], dim.text_position[1]);
  }
  if (!Number.isFinite(minX)) {
    return { minX: 0, minY: 0, maxX: 100, maxY: 100 };
  }
  const pad = Math.max((maxX - minX) * 0.02, (maxY - minY) * 0.02, 1);
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

/** Shared vector → SVG (same geometry as DXF export). */
export function drawingToSvg(drawing: VectorDrawing2d, title?: string): string {
  const { minX, minY, maxX, maxY } = bounds(drawing);
  const w = maxX - minX;
  const h = maxY - minY;
  const unit = drawing.units === 'millimetres' ? 'mm' : 'm';

  let body = '';
  for (const line of drawing.lines) {
    body += `<line x1="${line.a[0]}" y1="${line.a[1]}" x2="${line.b[0]}" y2="${line.b[1]}" stroke="#222" stroke-width="0.2" data-layer="${escapeXml(line.layer)}"/>`;
  }
  for (const dim of drawing.dimensions) {
    body += `<line x1="${dim.extension_a[0]}" y1="${dim.extension_a[1]}" x2="${dim.dim_a[0]}" y2="${dim.dim_a[1]}" stroke="#196" stroke-width="0.15"/>`;
    body += `<line x1="${dim.extension_b[0]}" y1="${dim.extension_b[1]}" x2="${dim.dim_b[0]}" y2="${dim.dim_b[1]}" stroke="#196" stroke-width="0.15"/>`;
    body += `<line x1="${dim.dim_a[0]}" y1="${dim.dim_a[1]}" x2="${dim.dim_b[0]}" y2="${dim.dim_b[1]}" stroke="#196" stroke-width="0.15"/>`;
    body += `<text x="${dim.text_position[0]}" y="${dim.text_position[1]}" font-size="2.5" fill="#060">${escapeXml(dim.text)}</text>`;
  }
  for (const text of drawing.texts) {
    body += `<text x="${text.position[0]}" y="${text.position[1]}" font-size="${text.height}" fill="#111">${escapeXml(text.text)}</text>`;
  }

  const titleTag = title ? `<title>${escapeXml(title)}</title>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}${unit}" height="${h}${unit}" viewBox="${minX} ${minY} ${w} ${h}">
  ${titleTag}
  <rect x="${minX}" y="${minY}" width="${w}" height="${h}" fill="#ffffff"/>
  <g transform="scale(1 -1) translate(0 ${-(minY + maxY)})">
  ${body}
  </g>
</svg>`;
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

export function downloadTextFile(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
