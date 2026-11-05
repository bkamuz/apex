/**
 * Theme system: one source of truth for Light / Dark (and System follow).
 *
 * - UI chrome reads CSS variables keyed by `:root[data-theme="light"|"dark"]`
 *   (styles/app.css).
 * - Renderers read `VIEWPORT_THEMES[resolved]` and `PLAN_STYLES[resolved]`
 *   (viewport/planStyle.ts); `applyTheme` flips both at once, no reload.
 */
export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";
export type Rgba = [number, number, number, number];
export type Rgb = [number, number, number];

export const THEME_PREFERENCES: readonly ThemePreference[] = [
  "system",
  "light",
  "dark",
];
export const THEME_STORAGE_KEY = "apex.theme";

export function resolveTheme(
  pref: ThemePreference,
  systemDark: boolean,
): ResolvedTheme {
  if (pref === "light" || pref === "dark") return pref;
  return systemDark ? "dark" : "light";
}

export function loadThemePreference(
  storage: Pick<Storage, "getItem"> | undefined,
): ThemePreference {
  try {
    const v = storage?.getItem(THEME_STORAGE_KEY);
    return v === "light" || v === "dark" || v === "system" ? v : "system";
  } catch {
    return "system";
  }
}

export function saveThemePreference(
  storage: Pick<Storage, "setItem"> | undefined,
  pref: ThemePreference,
): void {
  try {
    storage?.setItem(THEME_STORAGE_KEY, pref);
  } catch {
    /* storage unavailable */
  }
}

/** 3D viewport palette (plan palette lives in planStyle.ts). */
export interface ViewportTheme {
  clear: Rgb;
  grid: Rgba;
  edge: Rgba;
  contour: Rgba;
  activeContour: Rgba;
  gridAxis: Rgba;
  sky: Rgb;
  ground: Rgb;
}

export const VIEWPORT_THEMES: Record<ResolvedTheme, ViewportTheme> = {
  dark: {
    clear: [0x17 / 255, 0x1a / 255, 0x21 / 255], // bimpunk scene
    grid: [0.44, 0.43, 0.4, 0.38],
    edge: [0.08, 0.09, 0.1, 1],
    contour: [0.5, 0.56, 0.64, 0.45],
    activeContour: [0.72, 0.84, 0.98, 0.8],
    gridAxis: [0.62, 0.63, 0.65, 0.95],
    sky: [0.92, 0.94, 0.98],
    ground: [0.28, 0.3, 0.34],
  },
  light: {
    clear: [0xf4 / 255, 0xf5 / 255, 0xf7 / 255], // bimpunk scene
    grid: [0.55, 0.55, 0.53, 0.4],
    edge: [0.12, 0.12, 0.12, 1],
    contour: [0.45, 0.47, 0.5, 0.5],
    activeContour: [0.3, 0.42, 0.55, 0.8],
    gridAxis: [0.36, 0.37, 0.39, 0.95],
    // Neutral (not cool) lighting so walls read grey, not blue.
    sky: [0.96, 0.96, 0.95],
    ground: [0.42, 0.42, 0.41],
  },
};

type Listener = (resolved: ResolvedTheme, pref: ThemePreference) => void;

/** View cube palette (faces, edges, labels, accent hover). */
export interface ViewCubeTheme {
  faces: {
    front: string;
    back: string;
    right: string;
    left: string;
    top: string;
    bottom: string;
  };
  edge: string;
  label: string;
  labelHalo: string;
  hoverFill: string;
  hoverEdge: string;
  hoverLabel: string;
}

/**
 * Fallbacks mirror palette.css chrome tokens (cool blue-greys — never warm
 * olive). Live values come from `--view-cube-*` / `--apex-accent` via
 * `resolveViewCubeTheme`.
 */
export const VIEW_CUBE_THEMES: Record<ResolvedTheme, ViewCubeTheme> = {
  dark: {
    faces: {
      front: "#343b4a", // --chrome-hover
      back: "#22262f", // --chrome-bg-tabs
      right: "#3a4352", // --chrome-border
      left: "#3a4352",
      top: "#4a5366", // --chrome-scrollbar-hover
      bottom: "#20252f", // --chrome-bg-doc
    },
    edge: "#12141a", // --chrome-bg-hint
    label: "#e7e9ee", // --chrome-text
    labelHalo: "rgba(20,23,30,0.94)", // --chrome-overlay-strong
    hoverFill: "#d5d9e1", // --apex-accent
    hoverEdge: "#eef0f4",
    hoverLabel: "#14171d", // --apex-accent-fg
  },
  light: {
    faces: {
      front: "#e3e7ed", // --chrome-hover
      back: "#eef0f3", // --chrome-bg-doc
      right: "#e2e6ed", // --apex-accent-soft
      left: "#e2e6ed",
      top: "#ffffff", // --chrome-bg
      bottom: "#c9d0da", // --chrome-border
    },
    edge: "#c9d0da", // --chrome-border
    label: "#1b1f27", // --chrome-text
    labelHalo: "rgba(255,255,255,0.96)", // --chrome-overlay-strong
    hoverFill: "#2a303b", // --apex-accent
    hoverEdge: "#14171d",
    hoverLabel: "#ffffff", // --apex-accent-fg
  },
};

/** Hex `#rrggbb` or `rgba(...)` paint string from a computed CSS color. */
function cssColorToPaint(value: string): string | null {
  const v = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(v)) return v.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(v)) {
    const r = v[1];
    const g = v[2];
    const b = v[3];
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  const m = v.match(
    /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i,
  );
  if (!m) return null;
  if (m[4] !== undefined && Number(m[4]) < 1) {
    return `rgba(${Math.round(Number(m[1]))},${Math.round(Number(m[2]))},${Math.round(Number(m[3]))},${m[4]})`;
  }
  const hex = (n: string) =>
    Math.round(Number(n)).toString(16).padStart(2, "0");
  return `#${hex(m[1])}${hex(m[2])}${hex(m[3])}`;
}

/** Resolve a custom property, unwrapping nested `var(--x)` up to a few hops. */
function readCssVar(
  style: CSSStyleDeclaration,
  name: string,
): string | null {
  let v = style.getPropertyValue(name).trim();
  for (let i = 0; i < 4 && v; i++) {
    const paint = cssColorToPaint(v);
    if (paint) return paint;
    const ref = v.match(/^var\(\s*(--[\w-]+)\s*(?:,[^)]+)?\)$/i);
    if (!ref) return null;
    v = style.getPropertyValue(ref[1]).trim();
  }
  return null;
}

const VIEW_CUBE_FACE_VARS = {
  front: "--view-cube-face-front",
  back: "--view-cube-face-back",
  right: "--view-cube-face-right",
  left: "--view-cube-face-left",
  top: "--view-cube-face-top",
  bottom: "--view-cube-face-bottom",
} as const;

/**
 * View-cube palette for the resolved theme. Idle faces / edge / label and
 * hover fill come from live chrome / accent CSS vars so theme swaps stay cool
 * and in sync with panels (no independent warm greys).
 */
export function resolveViewCubeTheme(
  resolved: ResolvedTheme,
  style?: CSSStyleDeclaration | null,
): ViewCubeTheme {
  const base = VIEW_CUBE_THEMES[resolved];
  if (!style) return { ...base, faces: { ...base.faces } };
  const faces = { ...base.faces };
  for (const face of Object.keys(VIEW_CUBE_FACE_VARS) as Array<
    keyof typeof VIEW_CUBE_FACE_VARS
  >) {
    const paint = readCssVar(style, VIEW_CUBE_FACE_VARS[face]);
    if (paint && paint.startsWith("#")) faces[face] = paint;
  }
  const edge = readCssVar(style, "--view-cube-edge");
  const label = readCssVar(style, "--view-cube-label");
  const labelHalo = readCssVar(style, "--view-cube-label-halo");
  const accent = readCssVar(style, "--apex-accent");
  const accentFg = readCssVar(style, "--apex-accent-fg");
  return {
    ...base,
    faces,
    edge: edge && edge.startsWith("#") ? edge : base.edge,
    label: label && label.startsWith("#") ? label : base.label,
    labelHalo: labelHalo ?? base.labelHalo,
    hoverFill: accent && accent.startsWith("#") ? accent : base.hoverFill,
    hoverLabel:
      accentFg && accentFg.startsWith("#") ? accentFg : base.hoverLabel,
    hoverEdge:
      accentFg && accentFg.startsWith("#") ? accentFg : base.hoverEdge,
  };
}

export interface ThemeEnv {
  storage?: Pick<Storage, "getItem" | "setItem">;
  /** Optional media query for `(prefers-color-scheme: dark)`. */
  media?: {
    matches: boolean;
    addEventListener?: (
      t: "change",
      cb: (e: { matches: boolean }) => void,
    ) => void;
  };
}

/** Small observable store: preference + System follow + persistence. */
export function createThemeStore(env: ThemeEnv = {}) {
  let pref = loadThemePreference(env.storage);
  let systemDark = env.media?.matches ?? true;
  const listeners = new Set<Listener>();
  const resolved = () => resolveTheme(pref, systemDark);
  const emit = () => {
    const r = resolved();
    listeners.forEach((l) => l(r, pref));
  };
  env.media?.addEventListener?.("change", (e) => {
    const before = resolved();
    systemDark = e.matches;
    if (resolved() !== before) emit();
  });
  return {
    preference: () => pref,
    resolved,
    setPreference(next: ThemePreference) {
      pref = next;
      saveThemePreference(env.storage, next);
      emit();
    },
    /** Quick toggle: flip the currently shown theme to an explicit choice. */
    toggle() {
      this.setPreference(resolved() === "dark" ? "light" : "dark");
    },
    subscribe(l: Listener): () => void {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

export type ThemeStore = ReturnType<typeof createThemeStore>;

let shared: ThemeStore | null = null;

/** App-wide store bound to localStorage + prefers-color-scheme. */
export function themeStore(): ThemeStore {
  if (!shared) {
    const hasWindow = typeof window !== "undefined";
    shared = createThemeStore({
      storage: hasWindow ? window.localStorage : undefined,
      media:
        hasWindow && window.matchMedia
          ? window.matchMedia("(prefers-color-scheme: dark)")
          : undefined,
    });
    const apply = (r: ResolvedTheme) => {
      if (typeof document !== "undefined") {
        document.documentElement.dataset.theme = r;
        document.documentElement.style.colorScheme = r;
      }
    };
    apply(shared.resolved());
    shared.subscribe(apply);
  }
  return shared;
}
