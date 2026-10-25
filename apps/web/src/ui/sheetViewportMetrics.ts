/** Must match `VIEWPORT_TITLE_BAND_MM` in `crates/apex-core/src/sheet_scale.rs`. */
export const SHEET_VIEWPORT_TITLE_BAND_MM = 8;

export const SHEET_MM_TO_PX = 2.5;

export function sheetViewportDrawableHeightMm(totalHeightMm: number): number {
  return Math.max(1, totalHeightMm - SHEET_VIEWPORT_TITLE_BAND_MM);
}
