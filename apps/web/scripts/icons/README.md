# Poché tool icons

Source of `src/tools/iconCatalog.generated.ts`: every ribbon, context-bar and genus editor glyph,
drawn as code in three sizes (16, 24, 32 px). Each size is its own pixel-snapped drawing; the
16 px glyphs are hand-drawn in native 16 px coordinates.

| File | What it holds |
| --- | --- |
| `engine.py` | Tiny drawing DSL (rect, poly, path, circle, sector, line, arc, ring) and the SVG renderer |
| `poche.py` | The glyphs: `@master` (24-unit grid, snapped to 24/32 px) and `@px16` (hand-tuned 16 px) |
| `meta.py` | Ids, RU/EN names, status (current / future), genus editor ids that reuse a main glyph |
| `generate.py` | Writes the TypeScript catalog (standard library only) |
| `preview.py` | Preview sheets in `previews/` (needs `pip install resvg-py pillow`) |

## Regenerate

```sh
cd apps/web
npm run icons:generate          # python3 scripts/icons/generate.py
npm run icons:check             # fails if the committed catalog is stale
python3 scripts/icons/preview.py               # optional: refresh previews/*.png
python3 scripts/icons/generate.py --svg /tmp/apex-svg   # optional: loose .svg files
```

## Style rules

- Two tones only: hero shape in `currentColor`, secondary shape in `currentColor` at 40 % opacity.
- `#000`/`#fff` appear only inside masks: an even gap is cut around the hero
  (1 / 1.5 / 2 px at 16 / 24 / 32) and detail holes are punched, never drawn in a background colour.
- Straight, snapped geometry; plan or section views; no tiny decorative dots.
- Mask ids carry the `apx-p-` prefix; the UI makes them unique per instance with `scopeSvgIds`.
- Ids are kebab-case and match the tool ids used in `src/tools/icons.ts`.

## Adding a glyph

1. Add the id with RU/EN names to `meta.py`.
2. Draw it in `poche.py`: a `@master('id')` function, and a `@px16('id')` one if the auto-snapped
   16 px version loses detail.
3. `npm run icons:generate`, check `python3 scripts/icons/preview.py`, and add the id to
   `TOOL_ICONS` in `src/tools/icons.ts`.
