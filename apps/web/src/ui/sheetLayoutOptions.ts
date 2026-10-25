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
