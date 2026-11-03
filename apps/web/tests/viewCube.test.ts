import { test } from "node:test";
import assert from "node:assert/strict";
import {
  projectViewCube,
  viewCubePixelScale,
} from "../src/viewport/viewCube.ts";
import { VIEW_CUBE_THEMES } from "../src/theme/theme.ts";

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

test("view cube palettes exist for both themes with accent hover", () => {
  for (const t of ["light", "dark"] as const) {
    assert.match(VIEW_CUBE_THEMES[t].hoverFill, /^#[0-9a-f]{6}$/);
    assert.equal(Object.keys(VIEW_CUBE_THEMES[t].faces).length, 6);
  }
  // bimpunk accent: light grey on dark, slate on light.
  assert.equal(VIEW_CUBE_THEMES.dark.hoverFill, "#d5d9e1");
  assert.equal(VIEW_CUBE_THEMES.light.hoverFill, "#2a303b");
  assert.notEqual(
    VIEW_CUBE_THEMES.light.faces.front,
    VIEW_CUBE_THEMES.dark.faces.front,
  );
});
