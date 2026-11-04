# Apex desktop (Tauri 2)

Native shell around the same Vite + React + WASM UI in [`apps/web`](../web).
Open / Save / Save As use system dialogs when running inside Tauri; the browser
keeps the File API / download path.

## Prerequisites

Same as the web app, plus Tauri Linux/macOS/Windows system deps:

- [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/)
- On Debian/Ubuntu: `libwebkit2gtk-4.1-dev`, `libayatana-appindicator3-dev`,
  `librsvg2-dev`, `patchelf`, build tools (see upstream docs)

Rust **stable** is required (already used by the workspace). The desktop crate
lives under `src-tauri/` and is **not** a member of the root Cargo workspace, so
`cargo test` / clippy for BIM crates stay unchanged.

## Develop

From the repo root (or this folder):

```bash
# Web deps (once)
cd apps/web && npm install && cd ../desktop && npm install

# Starts Vite for apps/web, then opens the native window
npm run dev
```

Or from the monorepo root: `npm run desktop:dev`.

The window loads `http://127.0.0.1:5173` (same UI as `npm run dev` in
`apps/web`). Edit React/TS under `apps/web`; HMR still applies. After Rust/WASM
changes, rebuild with `npm run wasm:build` and reload the window.

## Build

```bash
cd apps/desktop
npm run build
```

This runs `apps/web` production build, then packages the desktop app. Artifacts
land under `src-tauri/target/release/bundle/` (platform-specific). Code signing
and auto-update are out of scope for this shell.

```bash
# Root convenience
npm run desktop:build
```

## File I/O

Detection: `isTauriShell()` in `apps/web/src/desktop/projectIo.ts` (presence of
`window.__TAURI_INTERNALS__` / `__TAURI__`). The File menu and Ctrl/Cmd+O/S
share one code path: desktop uses `@tauri-apps/plugin-dialog` + `plugin-fs`;
web uses `<input type="file">` and download.

## Notes

- Full `tauri build` in CI is optional; local `tauri dev` is the smoke check.
- Do not add per-component branches in the shell — it only hosts the web UI.
