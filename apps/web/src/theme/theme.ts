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
  gridAxisFaint: Rgba;
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
    gridAxisFaint: [0.62, 0.63, 0.65, 0.4],
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
    gridAxisFaint: [0.36, 0.37, 0.39, 0.45],
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

export const VIEW_CUBE_THEMES: Record<ResolvedTheme, ViewCubeTheme> = {
  dark: {
    faces: {
      front: "#5e5e5b",
      back: "#4b4b49",
      right: "#545452",
      left: "#545452",
      top: "#666662",
      bottom: "#424240",
    },
    edge: "#1a1a1a",
    label: "#f2f2f2",
    labelHalo: "rgba(12,12,12,0.9)",
    hoverFill: "#d5d9e1", // bimpunk --accent (dark)
    hoverEdge: "#eef0f4",
    hoverLabel: "#14171d",
  },
  light: {
    faces: {
      front: "#f4f4f2",
      back: "#e2e2df",
      right: "#ebebe8",
      left: "#ebebe8",
      top: "#fbfbfa",
      bottom: "#d9d9d6",
    },
    edge: "#8e8e89",
    label: "#2b2b29",
    labelHalo: "rgba(255,255,255,0.85)",
    hoverFill: "#2a303b", // bimpunk --accent (light)
    hoverEdge: "#14171d",
    hoverLabel: "#ffffff",
  },
};

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
