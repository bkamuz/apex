import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createThemeStore,
  loadThemePreference,
  resolveTheme,
  THEME_STORAGE_KEY,
  VIEWPORT_THEMES,
} from "../src/theme/theme.ts";
import { PLAN_STYLES, cutFillFor } from "../src/viewport/planStyle.ts";

function memStorage() {
  const m = new Map<string, string>();
  return {
    m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  };
}

function fakeMedia(matches: boolean) {
  let cb: ((e: { matches: boolean }) => void) | null = null;
  return {
    matches,
    addEventListener: (_t: "change", f: (e: { matches: boolean }) => void) =>
      void (cb = f),
    fire: (m: boolean) => cb?.({ matches: m }),
  };
}

test("resolveTheme honours explicit choice and system", () => {
  assert.equal(resolveTheme("light", true), "light");
  assert.equal(resolveTheme("dark", false), "dark");
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("system", false), "light");
});

test("default preference is System; invalid values fall back", () => {
  const st = memStorage();
  assert.equal(loadThemePreference(st), "system");
  st.setItem(THEME_STORAGE_KEY, "neon");
  assert.equal(loadThemePreference(st), "system");
  assert.equal(loadThemePreference(undefined), "system");
});

test("store persists choice and notifies subscribers", () => {
  const st = memStorage();
  const store = createThemeStore({ storage: st, media: fakeMedia(true) });
  const seen: string[] = [];
  store.subscribe((r, p) => seen.push(`${p}:${r}`));
  store.setPreference("light");
  assert.equal(st.m.get(THEME_STORAGE_KEY), "light");
  store.toggle();
  assert.equal(store.preference(), "dark");
  assert.deepEqual(seen, ["light:light", "dark:dark"]);
  assert.equal(createThemeStore({ storage: st }).preference(), "dark");
});

test("System follows prefers-color-scheme changes; explicit choice ignores them", () => {
  const media = fakeMedia(false);
  const store = createThemeStore({ storage: memStorage(), media });
  const seen: string[] = [];
  store.subscribe((r) => seen.push(r));
  assert.equal(store.resolved(), "light");
  media.fire(true);
  assert.equal(store.resolved(), "dark");
  store.setPreference("light");
  media.fire(false);
  media.fire(true);
  assert.deepEqual(seen, ["dark", "light"]);
});

test("palettes: light plan = black poche on paper, dark plan = light poche on dark", () => {
  assert.deepEqual(cutFillFor(undefined, "light"), [0, 0, 0, 1]);
  assert.ok(PLAN_STYLES.dark.cutFill[0] > 0.7);
  assert.ok(
    PLAN_STYLES.dark.paper[0] < 0.2 && PLAN_STYLES.light.paper[0] > 0.9,
  );
  assert.ok(
    VIEWPORT_THEMES.light.clear[0] > 0.8 && VIEWPORT_THEMES.dark.clear[0] < 0.2,
  );
});
