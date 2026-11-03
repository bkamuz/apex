/**
 * Plan (2D) drawing style per theme — the one place to change how plans read.
 *
 * Light: drawing on paper (#f7f7f5), black cut poche, dark lines.
 * Dark: Revit/ArchiCAD-dark convention — dark background with light-grey
 * poche and light lines, so plan and the dark UI/3D stay one theme.
 * Hatches will later plug in through `cutFillFor`.
 */
import type { ResolvedTheme, Rgba } from '../theme/theme';
export type { Rgba } from '../theme/theme';

export interface PlanStyle {
  paper: Rgba;
  /** Default cut poche (walls, columns, anything sliced by the cut plane). */
  cutFill: Rgba;
  /** Per-category overrides — empty for now (everything solid). */
  cutFillByCategory: Record<string, Rgba>;
  /** Slabs seen below the cut (projection): flat neutral fill, no lighting. */
  slabFill: Rgba;
  gridLine: Rgba;
  edge: Rgba;
  symbol: Rgba;
  space: Rgba;
  contour: Rgba;
  activeContour: Rgba;
  gridAxis: Rgba;
}

export const PLAN_STYLES: Record<ResolvedTheme, PlanStyle> = {
  light: {
    paper: [0xf4 / 255, 0xf5 / 255, 0xf7 / 255, 1], // bimpunk scene (light)
    cutFill: [0, 0, 0, 1],
    cutFillByCategory: {},
    slabFill: [0xde / 255, 0xe1 / 255, 0xe6 / 255, 1],
    gridLine: [0.55, 0.55, 0.53, 0.35],
    edge: [0.05, 0.05, 0.05, 1],
    symbol: [0.1, 0.1, 0.1, 1],
    space: [0.45, 0.5, 0.52, 0.7],
    contour: [0.45, 0.45, 0.45, 0.5],
    activeContour: [0.3, 0.3, 0.3, 0.7],
    gridAxis: [0.38, 0.39, 0.41, 0.95],
  },
  dark: {
    paper: [0x17 / 255, 0x1a / 255, 0x21 / 255, 1], // bimpunk scene (dark)
    cutFill: [0xd5 / 255, 0xd9 / 255, 0xe1 / 255, 1], // bimpunk accent: light poche
    cutFillByCategory: {},
    slabFill: [0x22 / 255, 0x26 / 255, 0x2f / 255, 1],
    gridLine: [0.44, 0.43, 0.4, 0.38],
    edge: [0xe7 / 255, 0xe9 / 255, 0xee / 255, 1],
    symbol: [0.86, 0.87, 0.9, 1],
    space: [0.5, 0.58, 0.62, 0.7],
    contour: [0.55, 0.55, 0.55, 0.5],
    activeContour: [0.7, 0.7, 0.7, 0.7],
    gridAxis: [0.62, 0.63, 0.65, 0.95],
  },
};

/** Back-compat alias: the light (paper) plan style. */
export const PLAN_STYLE = PLAN_STYLES.light;

/** Cut fill for an element category (seam for future hatches/materials). */
export function cutFillFor(category?: string, theme: ResolvedTheme = 'light'): Rgba {
  const st = PLAN_STYLES[theme];
  return (category && st.cutFillByCategory[category]) || st.cutFill;
}

/** Parse `#rgb`/`#rrggbb` (e.g. from `--plan-cut-fill`) into linear-ish 0..1 RGBA. */
export function parseHexColor(value: string | null | undefined): Rgba | null {
  const v = (value ?? "").trim();
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v);
  if (!m) return null;
  const hex = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
  const n = parseInt(hex, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1];
}

/** Revit-style "Thin Lines": every line is one device pixel. */
export function effectiveLineWidthPx(
  widthCssPx: number,
  dpr: number,
  hairline: boolean,
): number {
  return hairline ? 1 : widthCssPx * dpr;
}

const HAIRLINE_KEY = "apex.hairline";

export function loadHairline(
  storage: Pick<Storage, "getItem"> | undefined,
): boolean {
  try {
    return storage?.getItem(HAIRLINE_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveHairline(
  storage: Pick<Storage, "setItem"> | undefined,
  on: boolean,
): void {
  try {
    storage?.setItem(HAIRLINE_KEY, on ? "1" : "0");
  } catch {
    /* storage unavailable */
  }
}

/**
 * Two-key sequence matcher (Revit "TL"): `feed(key, timeMs)` returns true when
 * the sequence completes within `windowMs`.
 */
export function createKeySequence(sequence: string, windowMs = 900) {
  const seq = sequence.toLowerCase();
  let typed = "";
  let last = -Infinity;
  return {
    feed(key: string, timeMs: number): boolean {
      const k = key.toLowerCase();
      if (k.length !== 1) {
        typed = "";
        return false;
      }
      if (timeMs - last > windowMs) typed = "";
      last = timeMs;
      typed += k;
      if (!seq.startsWith(typed)) typed = seq.startsWith(k) ? k : "";
      if (typed === seq) {
        typed = "";
        return true;
      }
      return false;
    },
    /** True while a prefix of the sequence is pending (swallow the key). */
    pending(): boolean {
      return typed.length > 0;
    },
  };
}
