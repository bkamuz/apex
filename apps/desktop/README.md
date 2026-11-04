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
and auto-update are out of scope for this shell (unsigned / ad-hoc macOS is OK).

```bash
# Root convenience
npm run desktop:build
```

### CI matrix (GitHub Actions)

Workflow: [`.github/workflows/desktop.yml`](../../.github/workflows/desktop.yml).
Runs on `workflow_dispatch`, pushes to `main` that touch `apps/desktop/**`, and
PRs that change the desktop app or that workflow. Existing Rust / web / smoke CI
is unchanged.

| Job id | Runner | Notes |
| --- | --- | --- |
| `windows-x64` | `windows-latest` | MSI + NSIS |
| `windows-arm64` | `windows-11-arm` | Native ARM64 runner |
| `linux-x64` | `ubuntu-22.04` | deb / rpm / AppImage |
| `linux-arm64` | `ubuntu-24.04-arm` | Native aarch64 runner |
| `macos-arm64` | `macos-latest` | `--target aarch64-apple-darwin` |
| `macos-x64` | `macos-latest` | Cross-compile `--target x86_64-apple-darwin` (Intel runners retired) |

Artifacts upload as `apex-desktop-<job id>` (14-day retention). Download from the
Actions run → Artifacts. Packages are **unsigned** MVP builds.

**Signing / notarization (not configured):** to ship signed builds later, add
repo secrets such as Apple certificate + notarization
(`APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`,
`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`) and Windows
Authenticode cert material, then wire them into the workflow. Until then,
`bundle.macOS.signingIdentity` is `"-"` (ad-hoc) so CI can produce macOS
bundles without Apple credentials.

## File I/O

Detection: `isTauriShell()` in `apps/web/src/desktop/projectIo.ts` (presence of
`window.__TAURI_INTERNALS__` / `__TAURI__`). The File menu and Ctrl/Cmd+O/S
share one code path: desktop uses `@tauri-apps/plugin-dialog` + `plugin-fs`;
web uses `<input type="file">` and download.

## Notes

- Prefer `tauri dev` locally for day-to-day checks; CI covers packaging.
- Do not add per-component branches in the shell — it only hosts the web UI.
