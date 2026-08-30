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

- Rust **stable** (edition2024 required by the locked `getrandom`/`uuid` deps). The base image's default rustup toolchain was `1.83.0`, which is too old — the default has been switched to `stable`. If `cargo test` ever fails with `feature 'edition2024' is required`, run `rustup default stable` (and `rustup target add wasm32-unknown-unknown`).
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
