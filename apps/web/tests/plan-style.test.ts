import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createKeySequence,
  cutFillFor,
  effectiveLineWidthPx,
  loadHairline,
  parseHexColor,
  saveHairline,
} from "../src/viewport/planStyle.ts";

test("TL sequence toggles only when typed in order and in time", () => {
  const s = createKeySequence("TL", 900);
  assert.equal(s.feed("t", 0), false);
  assert.equal(s.feed("l", 100), true);
  assert.equal(s.feed("t", 200), false);
  assert.equal(s.feed("l", 2000), false);
  assert.equal(s.feed("l", 2100), false);
  assert.equal(s.feed("x", 2200), false);
  assert.equal(s.feed("t", 2300), false);
  assert.equal(s.feed("t", 2350), false);
  assert.equal(s.feed("L", 2400), true);
});

test("hairline state persists through storage", () => {
  const m = new Map<string, string>();
  const st = {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  };
  assert.equal(loadHairline(st), false);
  saveHairline(st, true);
  assert.equal(loadHairline(st), true);
  saveHairline(st, false);
  assert.equal(loadHairline(st), false);
  assert.equal(loadHairline(undefined), false);
});

test("hairline widths are one device pixel; poche defaults to black", () => {
  assert.equal(effectiveLineWidthPx(3.2, 2, true), 1);
  assert.equal(effectiveLineWidthPx(3.2, 2, false), 6.4);
  assert.deepEqual(cutFillFor("apex.wall"), [0, 0, 0, 1]);
  assert.deepEqual(parseHexColor("#fff"), [1, 1, 1, 1]);
  assert.equal(parseHexColor("red"), null);
});
