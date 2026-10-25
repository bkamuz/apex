import type { VectorDrawing2d } from '../types';
import { drawingToSvg } from './vectorExport';

/** Vector sheet export via shared drawing pipeline (same geometry as DXF). */
export function exportSheetSvgFromDrawing(sheetNumber: string, drawing: VectorDrawing2d): string {
  return drawingToSvg(drawing, `Sheet ${sheetNumber}`);
}

