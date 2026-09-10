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
  "placement": "point",                     // 1 pick; also two_point, three_point_arc, polyline, path
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

The shipped types use exactly this structure and no bespoke geometry code:

| Component | Placement | Recipe |
| --- | --- | --- |
| `apex.wall` | path (line, arc, or polyline) | profile swept along the path, seated on the level; rectangle vs round is a `profile` parameter |
| `apex.column` | one point | profile extruded up; rectangle vs round is a `profile` parameter |
| `apex.beam` | two points | rectangle swept, hung below the line |
| `apex.slab` | polyline (double-click to close) | closed boundary extruded for thickness |

A **profile type** is the catalog object behind that `profile` parameter: a 2D
section you **draw with the mouse** (click to place an outline, then assign
dimensions to edges). Type-level values are shared (e.g. wall thickness);
instance-level values vary per element (e.g. wall height). **Edit profile**
opens the sketch editor. The project browser lists both **types** (shared
profiles) and **instances** (placed 3D elements), with configurable grouping
and sorting. **Save** / **Open** persist the document (also auto-saved in the
browser). Justification is not in this slice.

Each **tool** is a plugin (`apps/web/src/plugins/`). A plugin decides what the
toolbar shows; registering a component does not automatically add a button.
That is why Wall and Column are one tool each: the draw mode (line / arc /
polyline) and the section are switches on the tool, not extra plugins. A user
module that calls `defineComponent` is itself a plugin and gets a default
placement tool.

Because the placement gesture comes from the definition, the property
inspector is generated from the schema.

### Extending a running app

```js
// A module, or the browser console.
window.apex.defineComponent({ /* definition as above */ });
```

`window.apex.registerTool(tool)` adds a toolbar button for a custom gesture.
See `apps/web/src/tools/Tool.ts` for the `Tool` interface and
`examples/custom-tool.ts` for a minimal stub.

Built-in **Move** (`M`) and **Copy** (`C`) transform the current selection
(instances, references, grid axes): pick a base point, then a target. Undo/redo
and project save include the results. Rotate / mirror / array are natural
follow-ups on the same transform tool infrastructure.

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

1. Pick a tool: **Wall**, **Column**, **Beam**, **Slab**, **Ref point**, **Ref plane**, or **Grid axis**. With Wall active, switch **Line** / **Arc** / **Polyline**. With Slab active, click corners of the floor outline and double-click to finish. **Ref point** is one click; **Ref plane** is origin plus in-plane direction (two clicks); **Grid axis** is start plus end (two clicks) on the active level.
2. Click the number of points that mode needs (1, 2, 3, or double-click to finish a polyline); a ghost previews the result.
3. Select the element. **This element** fields apply only to that instance; **Shared type** fields are the same for every element of that profile. On a **Column**, set **Frame reference** to a placed ref point to extrude from that frame instead of the click point. **Edit profile** opens a 2D sketch: click to draw the outline, close it, then click edges (or **Dimension all edges**) to assign sizes as shared type or this-element parameters. Select a **Grid axis** to edit label, bubble visibility per end, extension, and bubble radius; drag endpoints like ref anchors.
4. The left **Project** browser lists types, instances, references, and grid axes. Use **Refs** / **Grids** filters. Change **Group** / **Sort** to rearrange. **Save** downloads the project (it is also stored in the browser); **Open** loads a file; **New** starts over.

**Grid axes:** the segment lies on the level (plan XZ). Each axis defines a **vertical datum plane** through that segment and world up (BIM-style grid). Viewport overlay draws the extended segment, end bubbles, and a simple text label. Future 2D annotation entities should implement [`PlanAnnotation`](crates/apex-core/src/annotation.rs) alongside grid axes.
5. Orbit: right-drag · Pan: middle-drag · Zoom: wheel · Shift: snap to grid.

## Tests

```bash
cargo test -p apex-core -p apex-geometry   # unit tests
npm run typecheck                          # tsc
npm run dev                                # then, in another shell:
npm run test:smoke                         # Playwright end-to-end
```

## Roadmap (not in this MVP)

- Full associativity when a reference moves (dependents follow automatically)
- A visual component editor, so components can be built without JSON
- Undo/redo
- A full CAD constraint solver (the sketch editor is polyline + labeled edge lengths)
- csgrs / full CSG booleans (blocked on crates.io WASM packaging)
- IFC import, Views / Sheets
- Desktop via Tauri

## License

MIT
