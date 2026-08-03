# AGENTS.md

## Cursor Cloud specific instructions

### Product

`apex` (README title: "Apex BIM Tool") is a single, client-only web app — no backend, database, or auth. The implemented feature today is a browser-based IFC 3D viewer ("Apex BIM Prototype") built with Vite 7 + React 19 + TypeScript + Three.js, using `@thatopen/components` (web-ifc WASM) to parse and render uploaded `.ifc` files. Some dependencies in `package.json` (Speckle, OpenCASCADE `@bitbybit-dev/occt`, `manifold-3d`) are declared but not yet used in `src/`.

### Running (dev is the primary workflow)

- Standard scripts live in `package.json` (`dev`, `build`, `lint`, `preview`); package manager is npm (`package-lock.json`).
- Start the dev server with `npm run dev`. It runs on port `5173` by default; if that port is taken Vite auto-selects the next one (e.g. `5174`) — check the terminal output for the actual URL.
- The viewer depends on static assets served from `public/`: `public/wasm/*.wasm` (web-ifc) and `public/fragments/worker.mjs`. These are required for IFC parsing to work; do not remove them.

### Testing the app end-to-end

- There is no automated test suite. To smoke-test, open the dev URL, wait for the load button to switch from "⏳ Загрузка ядра..." to "📁 Загрузить IFC" (WASM loader ready), then upload a `.ifc` file. Geometry should render in the 3D viewport.
- A working sample IFC (IFC2X3, ~414 KB) can be downloaded from `https://raw.githubusercontent.com/ThatOpen/engine_web-ifc/main/tests/ifcfiles/public/example.ifc`. Loaded geometry currently renders as edges/wireframe rather than solid meshes — this is current app behavior, not an environment problem.

### Known pre-existing failures (not environment issues)

- `npm run build` fails: `src/App.tsx` imports `React` but never uses it (`TS6133`), which breaks `tsc -b`.
- `npm run lint` fails: `src/viewer/BIMViewer.tsx` uses `@ts-ignore` where the config requires `@ts-expect-error`.
- These are committed-code issues, not setup issues. `npm run dev` is unaffected and works.
