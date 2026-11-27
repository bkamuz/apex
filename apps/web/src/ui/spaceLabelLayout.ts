/** Screen-space room tag. `text` is the string actually drawn. */
export interface SpaceLabelBox {
  left: number;
  top: number;
  text: string;
  /** Room width in CSS pixels. The tag wraps inside it. */
  maxWidth?: number;
}

const CHAR_PX = 6.6;
const LINE_PX = 14;
const PAD_X = 10;
const PAD_Y = 8;

export function spaceLabelsOverlap(a: SpaceLabelBox, b: SpaceLabelBox): boolean {
  const as = boxSize(a);
  const bs = boxSize(b);
  return (
    Math.abs(b.left - a.left) < (as.w + bs.w) * 0.5 + 4 &&
    Math.abs(b.top - a.top) < (as.h + bs.h) * 0.5 + 2
  );
}

function boxSize(label: SpaceLabelBox): { w: number; h: number } {
  const cap = label.maxWidth ?? 168;
  const inner = Math.max(20, cap - PAD_X);
  const textW = Math.max(1, label.text.length) * CHAR_PX;
  const w = Math.min(cap, textW + PAD_X);
  const lines = Math.max(1, Math.ceil(textW / inner));
  return { w, h: lines * LINE_PX + PAD_Y };
}

/**
 * Nudge room tags that would paint on top of each other. Each tag stays near
 * its anchor so it still reads as that room.
 */
export function separateSpaceLabels(labels: SpaceLabelBox[], maxShift = 48): void {
  if (labels.length < 2) return;
  const origin = labels.map((label) => ({ left: label.left, top: label.top }));
  for (let pass = 0; pass < 6; pass += 1) {
    let moved = false;
    for (let i = 0; i < labels.length; i += 1) {
      for (let j = i + 1; j < labels.length; j += 1) {
        const a = labels[i];
        const b = labels[j];
        if (!spaceLabelsOverlap(a, b)) continue;
        const as = boxSize(a);
        const bs = boxSize(b);
        const dx = b.left - a.left;
        const dy = b.top - a.top;
        const overlapX = (as.w + bs.w) * 0.5 + 4 - Math.abs(dx);
        const overlapY = (as.h + bs.h) * 0.5 + 2 - Math.abs(dy);
        if (overlapX < overlapY) {
          const sign = dx === 0 ? (i < j ? 1 : -1) : Math.sign(dx);
          const push = overlapX * 0.5 + 0.5;
          a.left -= sign * push;
          b.left += sign * push;
        } else {
          const sign = dy === 0 ? 1 : Math.sign(dy);
          const push = overlapY * 0.5 + 0.5;
          a.top -= sign * push;
          b.top += sign * push;
        }
        moved = true;
      }
    }
    if (!moved) break;
  }
  for (let i = 0; i < labels.length; i += 1) {
    const label = labels[i];
    const home = origin[i];
    label.left = clamp(label.left, home.left - maxShift, home.left + maxShift);
    label.top = clamp(label.top, home.top - maxShift, home.top + maxShift);
  }
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}
