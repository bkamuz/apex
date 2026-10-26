import { Resvg } from '@resvg/resvg-js';

/** Rasterise an SVG drawing to PNG on a white background (no browser). */
export async function rasterizeSvg(svg: string, width: number): Promise<Buffer> {
  const resvg = new Resvg(svg, {
    background: 'white',
    fitTo: { mode: 'width', value: Math.max(64, Math.min(8192, Math.round(width))) },
    font: { loadSystemFonts: true, defaultFontFamily: 'DejaVu Sans' },
  });
  return Buffer.from(resvg.render().asPng());
}
