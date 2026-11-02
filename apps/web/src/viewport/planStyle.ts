/**
 * Plan (2D) drawing style — the one place to change how plans read.
 *
 * Decision: plan views render like a drawing on paper (light background,
 * black cut poche, dark lines). The shell stays dark; only the plan canvas
 * turns into "paper". Hatches will later plug in through `cutFillFor`.
 */
export type Rgba = [number, number, number, number];

export const PLAN_STYLE = {
  paper: [0.97, 0.97, 0.96, 1] as Rgba,
  /** Default cut poche (walls, columns, anything sliced by the cut plane). */
  cutFill: [0, 0, 0, 1] as Rgba,
  /** Per-category overrides — empty for now (everything solid black). */
  cutFillByCategory: {} as Record<string, Rgba>,
  gridLine: [0.55, 0.55, 0.53, 0.35] as Rgba,
  edge: [0.05, 0.05, 0.05, 1] as Rgba,
  symbol: [0.1, 0.1, 0.1, 1] as Rgba,
  space: [0.45, 0.5, 0.52, 0.7] as Rgba,
  contour: [0.45, 0.45, 0.45, 0.5] as Rgba,
  activeContour: [0.3, 0.3, 0.3, 0.7] as Rgba,
  gridAxis: [0.38, 0.39, 0.41, 0.95] as Rgba,
};

/** Cut fill for an element category (seam for future hatches/materials). */
export function cutFillFor(category?: string): Rgba {
  return (
    (category && PLAN_STYLE.cutFillByCategory[category]) || PLAN_STYLE.cutFill
  );
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
