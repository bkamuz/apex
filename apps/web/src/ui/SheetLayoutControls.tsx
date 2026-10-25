import type { PaperOrientation, PaperSize, SheetDto } from '../types';
import { ISO_PAPER_SIZES, PAPER_ORIENTATIONS, paperSizeFromDto } from './sheetLayoutOptions';

interface Props {
  paper: PaperSize;
  orientation: PaperOrientation;
  customWidthMm: number;
  customHeightMm: number;
  onPaperChange: (paper: PaperSize) => void;
  onOrientationChange: (orientation: PaperOrientation) => void;
  onCustomWidthChange: (mm: number) => void;
  onCustomHeightChange: (mm: number) => void;
  testIdPrefix?: string;
}

export function SheetLayoutControls({
  paper,
  orientation,
  customWidthMm,
  customHeightMm,
  onPaperChange,
  onOrientationChange,
  onCustomWidthChange,
  onCustomHeightChange,
  testIdPrefix = 'sheet',
}: Props) {
  const prefix = testIdPrefix;
  return (
    <div className="sheet-layout-controls">
      <label>
        Paper
        <select
          data-testid={`${prefix}-paper-size`}
          value={paper}
          onChange={(e) => onPaperChange(e.target.value as PaperSize)}
        >
          {ISO_PAPER_SIZES.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Orientation
        <select
          data-testid={`${prefix}-paper-orientation`}
          value={orientation}
          onChange={(e) => onOrientationChange(e.target.value as PaperOrientation)}
        >
          {PAPER_ORIENTATIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>
      {paper === 'custom' ? (
        <>
          <label>
            W (mm)
            <input
              type="number"
              min={10}
              data-testid={`${prefix}-custom-width-mm`}
              value={customWidthMm}
              onChange={(e) => onCustomWidthChange(Number(e.target.value))}
            />
          </label>
          <label>
            H (mm)
            <input
              type="number"
              min={10}
              data-testid={`${prefix}-custom-height-mm`}
              value={customHeightMm}
              onChange={(e) => onCustomHeightChange(Number(e.target.value))}
            />
          </label>
        </>
      ) : null}
    </div>
  );
}

export function sheetLayoutFromDto(sheet: SheetDto): {
  paper: PaperSize;
  orientation: PaperOrientation;
  customWidthMm: number;
  customHeightMm: number;
} {
  return {
    paper: paperSizeFromDto(sheet.paper),
    orientation: sheet.orientation,
    customWidthMm: sheet.custom_width_mm ?? 420,
    customHeightMm: sheet.custom_height_mm ?? 297,
  };
}
