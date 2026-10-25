import type { PaperOrientation, PaperSize } from '../types';

export const ISO_PAPER_SIZES: { value: PaperSize; label: string }[] = [
  { value: 'A4', label: 'A4' },
  { value: 'A3', label: 'A3' },
  { value: 'A2', label: 'A2' },
  { value: 'A1', label: 'A1' },
  { value: 'A0', label: 'A0' },
  { value: 'custom', label: 'Custom (mm)' },
];

export const PAPER_ORIENTATIONS: { value: PaperOrientation; label: string }[] = [
  { value: 'landscape', label: 'Landscape' },
  { value: 'portrait', label: 'Portrait' },
];

export function paperSizeToWasm(paper: PaperSize): string {
  return paper === 'custom' ? 'CUSTOM' : paper.toUpperCase();
}

/** Normalize paper size from scene DTO (handles legacy `a2` snake_case). */
export function paperSizeFromDto(raw: PaperSize | string): PaperSize {
  const key = String(raw).toLowerCase();
  switch (key) {
    case 'a4':
      return 'A4';
    case 'a3':
      return 'A3';
    case 'a2':
      return 'A2';
    case 'a1':
      return 'A1';
    case 'a0':
      return 'A0';
    case 'custom':
      return 'custom';
    default:
      return 'A4';
  }
}
