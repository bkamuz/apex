import type { VectorDrawing2d } from '../types';
import { drawingToSvg, type DrawingPageOptions } from './vectorExport';

/** Vector sheet export via shared drawing pipeline (same geometry as DXF). */
export function exportSheetSvgFromDrawing(
  sheetNumber: string,
  drawing: VectorDrawing2d,
  opts: Omit<DrawingPageOptions, 'title'> = {},
): string {
  return drawingToSvg(drawing, { ...opts, title: `Sheet ${sheetNumber}` });
}

