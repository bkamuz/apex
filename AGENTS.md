# AGENTS.md

## Cursor Cloud specific instructions

### Product

`apex` is a greenfield BIM MVP: a **Rust core compiled to WASM** driving a **React + WebGL2** front end. The legacy Three.js JS prototype was archived to branch `archive/js-prototype`. See `README.md` for the architecture and demo steps; this section only adds non-obvious environment notes.

Layout (Cargo workspace + one web app):
- `crates/apex-geometry` — geometry kernel (Frame, Curve, Profile, sweep, extrude). Layer 0: depends on nothing else in the workspace and knows nothing about walls, levels or documents.
- `crates/apex-core` — document, components, parameters, expressions, `Project`. Depends on `apex-geometry`.
- `crates/apex-wasm` — `wasm-bindgen` façade. Deliberately thin: JSON in, scene out.
- `apps/web` — Vite + React UI that imports the generated WASM package from `apps/web/src/wasm/pkg/`.

### Components are data

Object types (wall, column, beam, and anything a user adds) are
`ComponentDefinition` values, not code. Adding a type means registering data;
it must not require touching `apex-geometry`, `apex-wasm` or `App.tsx`. If a
change seems to need a per-type branch in those places, the abstraction is
wrong — fix the abstraction instead. See `crates/apex-core/src/registry.rs`
for how the built-ins are declared, and `README.md` for the JSON shape.

Two consequences worth remembering:
- First-party tools are plugins (`apps/web/src/plugins/`). Each plugin
  contributes one toolbar button. A component variant (round vs rectangular
  column) is a parameter, not a second plugin. A user `defineComponent` call
  is itself a plugin and gets a default placement tool.
- The inspector fields are generated from the definition's `ParamSpec` list.
- `to_js` in `apex-wasm` must keep `serialize_maps_as_objects(true)`. Any
  struct using `#[serde(flatten)]` (such as `ParamSpec`) or a map type (such
  as `ParamMap`) otherwise arrives in JS as a `Map` and every field reads
  `undefined`.

### Toolchain (already provisioned in the snapshot)

- Rust **stable**. Workspace crates use `edition = "2021"` (see root `Cargo.toml`). The base image's default rustup toolchain was `1.83.0`, which is too old for current deps — the default has been switched to `stable`. If builds fail on an old toolchain, run `rustup default stable` (and `rustup target add wasm32-unknown-unknown`).
- `wasm32-unknown-unknown` target + `wasm-pack` 0.13.1 (installed at `/usr/local/cargo/bin/wasm-pack`).
- Node 20+ (Node 22 present).

### Running / building (standard commands live in `package.json` / `README.md`)

- Dev server: `npm run dev` (root delegates to `apps/web`; Vite serves on port `5173`, host-local).
- The generated WASM package under `apps/web/src/wasm/pkg/` is committed, so `npm run dev` works even without a Rust toolchain. After editing Rust, rebuild it with `npm run wasm:build` (root or `apps/web`) — the dev server must be restarted / the page reloaded to pick up the new `.wasm`; Vite HMR does not hot-swap the WASM module.
- Production build: `npm run build` (runs `tsc -b && vite build`).

### Testing

- Rust unit tests: `cargo test -p apex-core -p apex-geometry` (or `npm run test:rust`).
- Lint/format, both enforced in CI: `cargo clippy -p apex-core -p apex-geometry -- -D warnings` and `cargo fmt --all -- --check`.
- Type check: `npm run typecheck`.
- Browser smoke test: with the dev server running, `npm run test:smoke`. It uses Playwright (Chromium must be installed via `npx playwright install chromium`) to place every built-in component, edit one through the generated inspector, and install a user component at runtime through `window.apex`. Screenshots go to `/opt/cursor/artifacts/screenshots/`; override with `APEX_SMOKE_OUT`, and the URL with `APEX_SMOKE_URL`. This is the most reliable end-to-end check of the Rust→WASM→WebGL2 flow.
- The dev server binds to `localhost`, which resolves to IPv6 here; prefer `http://localhost:5173/` over `127.0.0.1` unless you pass `--host 127.0.0.1`.

### Gotchas

- A stale root-level `node_modules/` may exist from the old JS prototype; it is gitignored and unused. The only npm project that needs installing is `apps/web`.
- WebGL2 rendering works headlessly in this environment (software GL), so the smoke test renders real geometry.

### Tools and plugins

- One plugin = one toolbar contribution (`apps/web/src/plugins/`). `installPlugins()` rebuilds `ToolRegistry` and the exporter registry from `firstPartyPlugins` plus runtime `window.apex.registerTool` / `registerExporter`.
- `PluginHost` can `registerTool`, `registerComponent`, and `registerExporter`. Domain packs (architecture, MEP, IFC) install through that host — never via `if (componentId === …)` in `App.tsx`.
- Placement finish rules live on `ComponentDefinition.placement_options` (`min_points`, `closed`, `seat_on_level`). Openings declare `host_cut`; MEP 3D routes set `seat_on_level: false` (PgUp/PgDn nudges elevation while placing).
- **Joinable path components** set `joinable: true` on the definition (built-in Wall + Beam). On place (and via `Project::join_paths` / WASM `joinPaths`), peers of the **same component id** on the level get corner miters and T-junctions: sweep `join_start`/`join_end` extensions keep centerlines at user picks; T-hits insert a host polyline vertex and trim the stem. Algorithm: `crates/apex-core/src/path_join.rs` + geometry helpers in `apex-geometry` (`miter_extension`, `stem_trim`, …). Arcs skipped in MVP. No `apex.wall` branches in App/geometry.
- Implement a tool by satisfying `Tool` in `apps/web/src/tools/Tool.ts` and registering it from a plugin's `install(host)` or at runtime via the SDK.
- `ToolContext` is the only bridge to WASM/React — tools hold no React state. Extend `ToolContext` when a new gesture family needs core support (see transform: `getTransformSelection`, `previewTransform`, `commitTransform`; openings: `createElementWithParent`).
- Toolbar groups: `select` | `transform` | `create` (visual separators). Transform tools (Move `M`, Copy `C`) live in the `transform` group.
- Create tools may declare `tab: ApexTabs.building` / `ApexTabs.basics` / `ApexTabs.engineering` / `ApexTabs.spaces` (or another `TOOL_TABS` / `window.apex.tabs` entry). Select/transform stay pinned (no tab). Tabs are data-driven: first tool with a given id creates the chip (first registration wins for label); unknown `{ id, label }` creates a new tab. Catalog is guidance, not an allowlist. Empty tabs are hidden. Building holds structural create tools; Engineering holds MEP routes (Pipe, Duct, Cable tray); Spaces holds Space + Detect rooms.
- **Basics tab** (`ApexTabs.basics`): Level, Ref point, Ref plane, Construction line, Grid axis, Section cut. **Ref point is the only point tool** — do not add a second point type. LevelList remains for manage/activate; the Level tool adds a storey at +3 m (same rise as LevelList).
- **Spaces tab** (`ApexTabs.spaces`): closed plan Space (room) polyline — click ≥3 points, double-click or Enter to close. **Detect rooms** finds closed wall-centerline loops on the active level and creates/refreshes auto-tagged spaces (`auto` param); manual spaces are preserved. One undo group per detect pass. Algorithm lives in `crates/apex-core/src/room_detect.rs` (arc walls skipped in v1).
- Optional `icon`: prefer `ApexIcons.*` / `window.apex.icons.*`; custom `{ svg: string }` allowed; omit or unknown name → label-only.
- Minimal third-party stub: `examples/custom-tool.ts`. Document shape:

```ts
import type { Tool } from './apps/web/src/tools/Tool';
import { ApexIcons } from './apps/web/src/tools/icons';
import { ApexTabs } from './apps/web/src/tools/tabs';

export const myTool: Tool = {
  id: 'acme.myTool',
  label: 'My tool',
  group: 'create',
  // Prefer catalog; custom { id, label } creates a new tab.
  tab: ApexTabs.building,
  icon: ApexIcons.wall, // or { svg: '…' }; omit for label-only
  shortcut: 'T',
  hint: () => 'Status line while active',
  onClick(e, ctx) { /* use ctx.resolvePoint, ctx.setError, … */ },
};

// window.apex.registerTool(myTool)
```

- Core transforms (`translateSelection`, `copySelection`) live in `Project` + `apex-wasm`; prefer adding mutations there over per-type branches in `App.tsx`.

### Grid axes and 2D annotations

- Plan grid axes are first-class document entities in `crates/apex-core/src/grid_axis.rs` (not component instances). They use two-point placement on the active level; semantically each axis is a **vertical plane** through the segment and world up.
- Params are data-driven via `grid_axis_param_specs()` (label, per-end bubbles, extension, bubble radius). Inspector reads `param_specs` from the selected axis DTO.
- Viewport overlay: `ViewportRenderer.setGridAxisOverlays` (WebGL lines/circles) plus `GridAxisLabels` (HTML text at bubble centers). Distinct pink styling vs cyan refs.
- Construction lines (`crates/apex-core/src/construction_line.rs`) and section cuts (`crates/apex-core/src/section_cut.rs`) also implement `PlanAnnotation` — two-point plan entities with `param_specs` and viewport overlays (olive lines / amber cut + fill hint). Section-cut MVP is overlay-only (no 3D clip / 2D section view yet).
- Future universal 2D family/annotation editor: keep extending `PlanAnnotation` in `crates/apex-core/src/annotation.rs` — shared param schema + overlay segments/labels. Prefer that seam over new per-type forks in geometry.
- Project snapshot format is `PROJECT_FORMAT = 8` (adds `view_annotations`; sheet viewports may store `camera` + `lock_navigation`). Format ≤7 imports with empty `view_annotations`. Format ≤6 imports with empty view/sheet lists and runs default-view migration (plan + 3D). Formats ≤5 import with empty lists for newer annotation arrays.
- **Vector export:** plan views and sheets export shared [`VectorDrawing2d`](crates/apex-core/src/vector_export.rs) via WASM (`exportViewVector` / `exportSheetVector`); SVG/PDF in the web shell, DXF R12 ASCII in [`dxf_export.rs`](crates/apex-core/src/dxf_export.rs) (`exportViewDxf` / `exportSheetDxf`). Layers follow export category names; sheet viewports are fit to mm with view scale.
- Plan **Spaces** are closed polylines on the active level (`PlanAnnotation` in `crates/apex-core/src/space.rs`), not mesh components. Toolbar tab `ApexTabs.spaces`; overlay + centroid label; inspector from `param_specs` (label, height unused for mesh this phase, `auto` bool for Detect rooms). No `PROJECT_FORMAT` bump for `auto` — it is a param defaulting to false on older snapshots.
- Full-document undo/redo is shipped (`history.rs` + UI). Move uses a ghost-only preview (document updates on commit); Copy must not open an undo group before commit.
