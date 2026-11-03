export type SidebarTab = 'views' | 'model' | 'genera';

export interface SidebarPrefs {
  tab: SidebarTab;
  collapsed: boolean;
  width: number;
}

export const SIDEBAR_PREFS_KEY = 'apex.sidebar';
export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 480;
export const SIDEBAR_DEFAULT: SidebarPrefs = { tab: 'model', collapsed: false, width: 248 };

const TABS: readonly SidebarTab[] = ['views', 'model', 'genera'];

export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT.width;
  return Math.round(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width)));
}

/** Parse stored prefs; anything unknown falls back to defaults. */
export function parseSidebarPrefs(raw: string | null): SidebarPrefs {
  if (!raw) return { ...SIDEBAR_DEFAULT };
  try {
    const v = JSON.parse(raw) as Partial<SidebarPrefs>;
    return {
      tab: TABS.includes(v.tab as SidebarTab) ? (v.tab as SidebarTab) : SIDEBAR_DEFAULT.tab,
      collapsed: typeof v.collapsed === 'boolean' ? v.collapsed : SIDEBAR_DEFAULT.collapsed,
      width: typeof v.width === 'number' ? clampSidebarWidth(v.width) : SIDEBAR_DEFAULT.width,
    };
  } catch {
    return { ...SIDEBAR_DEFAULT };
  }
}

export function loadSidebarPrefs(): SidebarPrefs {
  try {
    return parseSidebarPrefs(localStorage.getItem(SIDEBAR_PREFS_KEY));
  } catch {
    return { ...SIDEBAR_DEFAULT };
  }
}

export function saveSidebarPrefs(prefs: SidebarPrefs): void {
  try {
    localStorage.setItem(SIDEBAR_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
}

/** Search match used by the Model / Genera trees (case- and ё-insensitive, all words). */
export function matchesBrowserSearch(query: string, ...fields: readonly string[]): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е');
  const q = norm(query.trim());
  if (!q) return true;
  const hay = norm(fields.join(' '));
  return q.split(/\s+/).every((w) => hay.includes(w));
}
