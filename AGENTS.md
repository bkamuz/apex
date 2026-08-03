# AGENTS.md

## Cursor Cloud specific instructions

### Product

`apex` is a greenfield BIM MVP: a **Rust core compiled to WASM** driving a **React + WebGL2** front end. The legacy Three.js JS prototype was archived to branch `archive/js-prototype`. See `README.md` for the architecture and demo steps; this section only adds non-obvious environment notes.

Layout (Cargo workspace + one web app):
- `crates/apex-core`, `crates/apex-geometry`, `crates/apex-wasm` — Rust crates; `apex-wasm` is the `wasm-bindgen` façade.
- `apps/web` — Vite + React UI that imports the generated WASM package from `apps/web/src/wasm/pkg/`.

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
- Browser smoke test: with the dev server running, `node apps/web/scripts/smoke.mjs`. It uses Playwright (Chromium browser must be installed via `npx playwright install chromium`) to place a wall and edit it, writing screenshots to `/opt/cursor/artifacts/screenshots/`. This is the most reliable end-to-end check of the Rust→WASM→WebGL2 flow.

### Gotchas

- A stale root-level `node_modules/` may exist from the old JS prototype; it is gitignored and unused. The only npm project that needs installing is `apps/web`.
- WebGL2 rendering works headlessly in this environment (software GL), so the smoke test renders real geometry.
