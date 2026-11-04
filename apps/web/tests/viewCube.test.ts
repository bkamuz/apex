import { test } from "node:test";
import assert from "node:assert/strict";
import {
  projectViewCube,
  viewCubePixelScale,
} from "../src/viewport/viewCube.ts";
import {
  VIEW_CUBE_THEMES,
  resolveViewCubeTheme,
} from "../src/theme/theme.ts";

test("view cube fit: bounding sphere stays inside the widget at every orientation", () => {
  for (const size of [96, 128]) {
    for (let yaw = 0; yaw < Math.PI * 2; yaw += 0.2) {
      for (let pitch = -1.5; pitch <= 1.5; pitch += 0.15) {
        const p = projectViewCube(yaw, pitch, size);
        for (const v of p.verts) {
          assert.ok(
            v.x > 0 && v.x < size && v.y > 0 && v.y < size,
            `${size} ${yaw} ${pitch}`,
          );
        }
      }
    }
    assert.ok(Math.sqrt(3) * viewCubePixelScale(size) < size * 0.5 * 0.92);
  }
});

/** Cool chrome greys keep blue ≥ red (no warm olive / yellow cast). */
function assertCoolHex(hex: string, label: string) {
  assert.match(hex, /^#[0-9a-f]{6}$/, label);
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  assert.ok(b >= r, `${label} ${hex} should be cool (B>=R), got R=${r} B=${b}`);
}

test("view cube palettes exist for both themes with cool chrome faces", () => {
  for (const t of ["light", "dark"] as const) {
    assert.match(VIEW_CUBE_THEMES[t].hoverFill, /^#[0-9a-f]{6}$/);
    assert.equal(Object.keys(VIEW_CUBE_THEMES[t].faces).length, 6);
    for (const [face, hex] of Object.entries(VIEW_CUBE_THEMES[t].faces)) {
      assertCoolHex(hex, `${t}.${face}`);
    }
  }
  // Fallbacks mirror palette.css chrome / --apex-accent (dark / light).
  assert.equal(VIEW_CUBE_THEMES.dark.faces.front, "#343b4a");
  assert.equal(VIEW_CUBE_THEMES.dark.hoverFill, "#d5d9e1");
  assert.equal(VIEW_CUBE_THEMES.light.hoverFill, "#2a303b");
  assert.notEqual(
    VIEW_CUBE_THEMES.light.faces.front,
    VIEW_CUBE_THEMES.dark.faces.front,
  );
  // Old warm olive greys must stay gone.
  assert.notEqual(VIEW_CUBE_THEMES.dark.faces.front, "#5e5e5b");
  assert.notEqual(VIEW_CUBE_THEMES.dark.faces.top, "#666662");
});

test("resolveViewCubeTheme overlays live chrome + accent CSS vars", () => {
  const vars: Record<string, string> = {
    "--apex-accent": "#aabbcc",
    "--apex-accent-fg": "#112233",
    "--view-cube-face-front": "var(--chrome-hover)",
    "--chrome-hover": "#343b4a",
    "--view-cube-face-top": "#4a5366",
    "--view-cube-edge": "#12141a",
    "--view-cube-label": "#e7e9ee",
  };
  const style = {
    getPropertyValue(name: string) {
      return vars[name] ?? "";
    },
  } as CSSStyleDeclaration;
  const themed = resolveViewCubeTheme("dark", style);
  assert.equal(themed.hoverFill, "#aabbcc");
  assert.equal(themed.hoverLabel, "#112233");
  assert.equal(themed.hoverEdge, "#112233");
  assert.equal(themed.faces.front, "#343b4a");
  assert.equal(themed.faces.top, "#4a5366");
  assert.equal(themed.edge, "#12141a");
  assert.equal(themed.label, "#e7e9ee");
  assert.equal(
    resolveViewCubeTheme("light").hoverFill,
    VIEW_CUBE_THEMES.light.hoverFill,
  );
});
