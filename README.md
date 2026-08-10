# Apex

Greenfield BIM MVP: **Rust core (WASM)** + **React shell** + flat-buffer WebGL2 viewport.

Legacy JS prototype (Three.js / That Open) lives on branch `archive/js-prototype`.

## Architecture

```text
crates/apex-geometry   Geometry kernel: Frame, Curve, Profile, sweep, extrude
crates/apex-core       Document, components, parameters, expressions, Project
crates/apex-wasm       wasm-bindgen façade for the web app
apps/web               Vite + React UI
```

Flow: React tool → WASM command → Rust rebuilds mesh → flat GPU buffers → one WebGL2 draw.

No Three.js scene graph. No Object3D per element.

### Components

An object type is **data**, not code. A `ComponentDefinition` says how it is
placed, what parameters it takes, and how to build its geometry:

```jsonc
{
  "id": "acme.planter",
  "display_name": "Planter",
  "category": "furniture",
  "placement": "point",                     // 1 pick; also two_point, three_point_arc, polyline
  "params": [
    { "id": "radius", "label": "Radius", "kind": "length", "default": 0.5 },
    { "id": "height", "label": "Height", "kind": "length", "default": 0.9 }
  ],
  "recipe": {
    "op": "extrude",                        // also sweep, group, custom
    "profile": { "shape": "circle", "radius": { "op": "param", "id": "radius" } },
    "height": { "op": "param", "id": "height" }
  }
}
```

The shipped components use exactly this structure and no bespoke geometry code:

| Component | Placement | Recipe |
| --- | --- | --- |
| `apex.wall` | two points | rectangle swept along the line, seated on the level |
| `apex.arc_wall` | three points | the same recipe, arc gesture |
| `apex.column` | one point | rectangle extruded up |
| `apex.round_column` | one point | circle extruded up |
| `apex.beam` | two points | rectangle swept, hung below the line |

Because the placement gesture comes from the definition, the toolbar and the
property inspector are generated. Registering a component is all it takes to
get a working tool.

### Extending a running app

```js
// A module, or the browser console.
window.apex.defineComponent({ /* definition as above */ });
```

`window.apex.registerTool(tool)` exists for the rare case of a genuinely new
input gesture; placing a new component type does not need it.

## Prerequisites

- Rust (stable) + `wasm32-unknown-unknown` + `wasm-pack`
- Node.js 20+

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-pack --version 0.13.1
```

## Develop

```bash
# Rebuild WASM (after Rust changes)
cd apps/web && npm run wasm:build

# Web app
cd apps/web && npm install && npm run dev
```

Open http://localhost:5173

### Live demo (GitHub Pages)

After merging to `main` and enabling Pages (Settings → Pages → **GitHub Actions**), the app is at:

**https://bkamuz.github.io/apex/**

Each push to `main` redeploys automatically via `.github/workflows/deploy-pages.yml`.

### Demo

1. Pick a tool: **Wall**, **Arc wall**, **Column**, **Round column** or **Beam**.
2. Click the number of points that tool needs (1, 2 or 3); a ghost previews the result.
3. Select the element and edit its parameters; the fields come from its schema.
4. Orbit: right-drag · Pan: middle-drag · Zoom: wheel · Shift: snap to grid.

## Tests

```bash
cargo test -p apex-core -p apex-geometry   # unit tests
npm run typecheck                          # tsc
npm run dev                                # then, in another shell:
npm run test:smoke                         # Playwright end-to-end
```

## Roadmap (not in this MVP)

- Reference points and planes as first-class objects (`FrameSource::Ref` is the reserved seam)
- A visual component editor, so components can be built without JSON
- Undo/redo and document serialization
- csgrs / full CSG booleans (blocked on crates.io WASM packaging)
- IFC import, Views / Sheets
- Desktop via Tauri

## License

MIT
