# Apex

Greenfield BIM MVP: **Rust core (WASM)** + **React shell** + flat-buffer WebGL2 viewport.

Legacy JS prototype (Three.js / That Open) lives on branch `archive/js-prototype`.

## Architecture

```text
crates/apex-core       Document, Element, Level, scene buffers
crates/apex-geometry   Wall mesh generation (extruded profile)
crates/apex-wasm       wasm-bindgen façade for the web app
apps/web               Vite + React UI
```

Flow: React tool → WASM command → Rust rebuilds mesh → flat GPU buffers → one WebGL2 draw.

No Three.js scene graph. No Object3D per element.

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

### Demo

1. Tool **Wall** is active by default.
2. Click two points on the ground grid to place a wall.
3. Select the wall (tree or **Select** tool) and change height / thickness.
4. Orbit: right-drag · Pan: Shift-drag · Zoom: wheel.

## Tests

```bash
cargo test -p apex-core -p apex-geometry
```

## Roadmap (not in this MVP)

- csgrs / full CSG booleans (blocked on crates.io WASM packaging; geometry API is ready)
- WebGPU meshlets / GPU culling
- IFC import, parametric families, Views / Sheets
- Desktop via Tauri

## License

MIT
