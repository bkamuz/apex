# Apex UI/UX audit — October 2026

Hands-on visual audit of **apex** on `main` (local dev server `http://localhost:5173/`, compared mentally to the public demo at `https://bkamuz.github.io/apex/`). No product code was changed in this run.

## Method

- Started `npm run dev` (committed WASM package; no Rust rebuild required).
- Exercised flows via Playwright smoke (`npm run test:smoke`) plus supplemental capture at **1280×800** and **1600×1000**, and **860×800** (mobile breakpoint).
- Recorded walkthrough video with Playwright (`recordVideo`).
- Reviewed shell styling in `apps/web/src/styles/app.css` and toolbar structure in `apps/web/src/ui/ToolsToolbar.tsx`.

## Artifact index

| Artifact | Description |
|----------|-------------|
| `/opt/cursor/artifacts/apex-ux-audit-walkthrough.webm` | ~2 min tab tour, wall room, column, detect rooms, orbit |
| `/opt/cursor/artifacts/screenshots/ux-audit/1280-01-empty-load.png` | First load, Basics tab, empty grid |
| `/opt/cursor/artifacts/screenshots/ux-audit/1280-02-tab-building.png` | Building constructions toolbar (full width) |
| `/opt/cursor/artifacts/screenshots/ux-audit/1280-02-tab-engineering.png` | Engineering tab |
| `/opt/cursor/artifacts/screenshots/ux-audit/1280-03-walls-room.png` | Wall placement + draw modes (note **Polyline** truncation) |
| `/opt/cursor/artifacts/screenshots/ux-audit/1280-05-inspector-slab-selected.png` | Instance selected — schema-driven inspector |
| `/opt/cursor/artifacts/screenshots/ux-audit/1280-06-move-tool-hint.png` | Move tool + INFO hint + selection |
| `/opt/cursor/artifacts/screenshots/ux-audit/1280-09-annotations.png` | Grid axis, construction line, section cut overlays |
| `/opt/cursor/artifacts/screenshots/ux-audit/1280-10-detect-rooms.png` | Detect rooms active; stale Properties (see blocker) |
| `/opt/cursor/artifacts/screenshots/ux-audit/1280-11-mep-duct.png` | Duct tool + MEP inspector |
| `/opt/cursor/artifacts/screenshots/ux-audit/860-mobile-layout.png` | ≤900px: side panels hidden, toolbar truncation |
| `/opt/cursor/artifacts/screenshots/ux-audit/ux-bug-inspector-stale-on-detect-rooms.png` | Repro: Section cut still in Properties while Detect rooms active |
| `/opt/cursor/artifacts/screenshots/ux-audit/apex-06-profile-editor.png` | In-viewport profile sketch editor overlay |
| `/opt/cursor/artifacts/screenshots/ux-audit/apex-07-browser-save.png` | Project browser + save/reload (from smoke) |
| `/opt/cursor/artifacts/screenshots/ux-audit/apex-path-joins-*.png` | Wall join visuals (L, T, room) |

Additional smoke captures live under `/opt/cursor/artifacts/screenshots/ux-audit/apex-*.png`.

---

## Findings (prioritized)

### Blocker

#### B1 — Properties panel disagrees with active tool (annotation selection not cleared)

- **What happens:** After selecting a section cut (or similar plan annotation), switching to **Spaces → Detect rooms** (or other create tools) updates the INFO hint for the new tool but **Properties** still shows the previous annotation (e.g. Section 1) with Delete/edit fields.
- **Repro:** Basics → Section cut → two clicks to place → Spaces tab → **Detect rooms**. Observe INFO vs Properties.
- **Screenshot:** `/opt/cursor/artifacts/screenshots/ux-audit/ux-bug-inspector-stale-on-detect-rooms.png`
- **Suggested fix:** When activating a tool that is not Select/transform, clear non-instance selection (`selected_section_cut_id`, grid axis, ref, space, etc.) or show a neutral “tool options / nothing selected” inspector state; keep tree selection in sync.

---

### Major

#### M1 — No true 2D plan view; “Ortho / Persp” reads as 3D-only

- **What happens:** Projection toggles are **Orthographic axonometric** vs **Perspective** (`ToolsToolbar`: “Ortho” / “Persp”). There is no top-down plan workplane mode BIM users expect as “2D”.
- **Repro:** Place walls → toggle Ortho vs Persp — both remain oblique 3D views.
- **Screenshot:** `/opt/cursor/artifacts/screenshots/ux-audit/1280-06-move-tool-hint.png`
- **Suggested fix:** Add an explicit **Plan** view (top-down, parallel projection, locked up vector) with a clear toolbar control; rename “Ortho” to “Axon” or similar to avoid implying floor plan.

#### M2 — Mobile / narrow layout hides browser and inspector until Menu FAB

- **What happens:** Below **900px** width, left project browser and right Properties are removed from the grid; only a **Menu** FAB exposes them in a sheet (`App.tsx` `useMediaQuery('(max-width: 900px)')`).
- **Repro:** Resize to 860×800 — canvas-only chrome; project tree and inspector not visible without discovering Menu.
- **Screenshot:** `/opt/cursor/artifacts/screenshots/ux-audit/860-mobile-layout.png`
- **Suggested fix:** Persistent slim strip or default-open sheet on first visit; show a one-time callout on the FAB; consider breakpoint ≥1024 for desktop three-pane layout at 1280×800 audits.

#### M3 — Toolbar horizontal overflow and label truncation at common widths

- **What happens:** Building tab with draw modes: **Polyline** renders as **“Polyt…”** at 1280×800. Basics tab at 860px: **“Grid axi…”**. Toolbar `scrollWidth` exceeds client width (measured 1281 vs 1280 at 1280px with building tools). Scrollbars are thin and easy to miss.
- **Repro:** Building → Wall (Line/Arc/Polyline visible); or Basics at 860px width.
- **Screenshot:** `/opt/cursor/artifacts/screenshots/ux-audit/1280-03-walls-room.png`, `/opt/cursor/artifacts/screenshots/ux-audit/860-mobile-layout.png`
- **Suggested fix:** Icon-only mode with tooltips below ~1400px; wrap draw modes to a second row; fade affordance at toolbar edges; shorten labels (“Poly”, “Grid”).

#### M4 — Raw component categories in project browser (`mep.duct`, `wall`, …)

- **What happens:** Shared types list shows internal **category** strings (e.g. `mep.tray`, `mep.duct`, `wall`) in muted mono type — reads like debug IDs, not user-facing discipline names.
- **Repro:** Open project browser → Shared types on empty or populated doc.
- **Screenshot:** `/opt/cursor/artifacts/screenshots/ux-audit/1280-01-empty-load.png`
- **Suggested fix:** Map categories to display labels (“Duct”, “Wall”, “Cable tray”); hide dot-notation unless “Show technical IDs” pref is on.

#### M5 — Empty document lacks onboarding beyond one INFO line

- **What happens:** First load is an empty grid. No sample project, call-to-action (“Draw walls”, “Add level”), or illustration of tab model. INFO bar shows camera bindings only.
- **Repro:** Hard refresh / New project.
- **Screenshot:** `/opt/cursor/artifacts/screenshots/ux-audit/1280-01-empty-load.png`
- **Suggested fix:** Empty-state overlay in viewport (3 steps: pick tab → place wall → inspect); optional “Load sample building” on New.

#### M6 — Camera navigation undocumented for trackpad / single-button users

- **What happens:** INFO text assumes **MMB pan**, **RMB orbit**, wheel zoom. No on-screen view cube, zoom-extents, or “navigation” help. Discoverability is low for Mac trackpads and pen tablets.
- **Repro:** First load — read INFO bar; try to orbit without RMB.
- **Screenshot:** `/opt/cursor/artifacts/screenshots/ux-audit/1280-01-empty-load.png`
- **Suggested fix:** Add Alt+drag / two-finger gestures; **Fit view** / **Zoom selection** buttons; link “?” to shortcut sheet.

#### M7 — Inspector “Apply” pattern vs immediate edit inconsistency

- **What happens:** Some numeric fields require **Apply** (e.g. wall height when element selected); tool-default fields while placing update on change. Users can think edits applied when they are not.
- **Repro:** Select wall → change Height → navigate away without Apply.
- **Screenshot:** `/opt/cursor/artifacts/screenshots/ux-audit/1280-06-move-tool-hint.png`
- **Suggested fix:** Apply on blur/Enter consistently, or show dirty-state badge on Apply; auto-apply with debounce for numbers.

---

### Minor

#### N1 — Disabled Undo/Redo look like enabled text buttons

- **What happens:** Disabled file-actions use `opacity: 1` and `#666` text (`.file-actions button:disabled`) — similar weight to enabled actions.
- **Repro:** Fresh project — Undo/Redo appear clickable.
- **Screenshot:** `/opt/cursor/artifacts/screenshots/ux-audit/1280-01-empty-load.png`
- **Suggested fix:** Lower opacity, remove hover, or iconographic disabled state.

#### N2 — Active level duplicated in three places

- **What happens:** Level name appears in top-right doc bar, level list highlight, and viewport badge (`WebGL2 · fps · Level 0 · vN`).
- **Repro:** Any session.
- **Screenshot:** `/opt/cursor/artifacts/screenshots/ux-audit/1280-06-move-tool-hint.png`
- **Suggested fix:** Drop level from viewport badge or top bar when level list is visible.

#### N3 — Viewport badge is developer-facing

- **What happens:** “WebGL2”, FPS, document version exposed to all users — useful in dev, noisy for BIM workflows.
- **Repro:** Any session.
- **Screenshot:** `/opt/cursor/artifacts/screenshots/ux-audit/1280-03-walls-room.png`
- **Suggested fix:** Hide behind debug flag or collapse to icon tooltip.

#### N4 — Tab label length and casing

- **What happens:** “Building constructions” in uppercase tab strip feels long next to “Basics” / “Spaces”; increases horizontal tab scroll on small widths.
- **Repro:** View tab row at 1280px.
- **Screenshot:** `/opt/cursor/artifacts/screenshots/ux-audit/1280-02-tab-building.png`
- **Suggested fix:** Shorten to “Building” or “Structure”; sentence case optional.

#### N5 — File actions are text-only and densely packed

- **What happens:** Undo, Save, IFC, Open, New share equal visual weight with no icons; **IFC** is opaque to non-BIM users.
- **Repro:** Top doc bar.
- **Screenshot:** `/opt/cursor/artifacts/screenshots/ux-audit/1280-01-empty-load.png`
- **Suggested fix:** Icons + “Export IFC” label; group File menu; confirm **New** when document dirty.

#### N6 — Delete control styling is easy to miss

- **What happens:** Delete uses `.danger` subtle border/text; not a filled destructive button — low affordance for irreversible action.
- **Repro:** Select any deletable entity.
- **Screenshot:** `/opt/cursor/artifacts/screenshots/ux-audit/1280-09-annotations.png`
- **Suggested fix:** Filled destructive style + optional confirm for bulk delete.

#### N7 — Browser filter chips abbreviate (“Annot.”)

- **What happens:** “Annot.” for annotations is cryptic at 10px uppercase.
- **Repro:** Project browser filter row.
- **Screenshot:** `/opt/cursor/artifacts/screenshots/ux-audit/1280-09-annotations.png`
- **Suggested fix:** Tooltip on hover; full word if width allows.

#### N8 — Keyboard focus order skips the canvas

- **What happens:** Tab cycling highlights file buttons then toolbar; 3D viewport is not in tab order (expected for CAD, but no visible “canvas focused” state for keyboard nudging).
- **Repro:** Repeated Tab from load.
- **Screenshot:** `/opt/cursor/artifacts/screenshots/ux-audit/1280-14-keyboard-focus.png`
- **Suggested fix:** Document focus model; ensure Escape returns focus to canvas; visible focus ring on active tool.

#### N9 — Profile / sketch editor competes with main chrome

- **What happens:** Profile editor overlay is powerful but visually dense; constraint badges and dimensions overlap viewport content with little separation from main model.
- **Repro:** Edit profile on wall type (smoke flow).
- **Screenshot:** `/opt/cursor/artifacts/screenshots/ux-audit/apex-06-profile-editor.png`
- **Suggested fix:** Modal frame, dim background, clearer Save/Cancel hierarchy.

#### N10 — Parent / Detach tools lack in-app explanation

- **What happens:** Transform group includes Parent/Detach with no INFO hint until activated; relationship model is non-obvious vs Revit/ArchiCAD.
- **Repro:** Building tab → note Parent/Detach labels only.
- **Screenshot:** `/opt/cursor/artifacts/screenshots/ux-audit/1280-02-tab-building.png`
- **Suggested fix:** First-run hint or status copy when Parent active; link to docs.

---

### Polish

#### P1 — Selection color language mixes green (UI) and orange (geometry)

- **What happens:** UI selection = green; viewport picks / anchors = orange/yellow — acceptable but could be harmonized.
- **Screenshot:** `/opt/cursor/artifacts/screenshots/ux-audit/1280-06-move-tool-hint.png`
- **Suggested fix:** Align anchor color to accent family or document the dual encoding in a legend.

#### P2 — Grid / annotation overlay colors (pink grid, olive construction, amber section) are strong

- **What happens:** Multiple saturated overlay hues simultaneously — busy on complex plans.
- **Screenshot:** `/opt/cursor/artifacts/screenshots/ux-audit/1280-09-annotations.png`
- **Suggested fix:** Slightly desaturate; user prefs for overlay palette.

#### P3 — Monospace INFO bar vs sans panels

- **What happens:** INFO uses Plex Mono; rest uses Plex Sans — intentional “console” feel but slightly disjointed.
- **Screenshot:** `/opt/cursor/artifacts/screenshots/ux-audit/1280-11-mep-duct.png`
- **Suggested fix:** Sans for INFO body, mono only for coordinates/shortcuts.

#### P4 — Zero border-radius industrial theme is coherent but austere

- **What happens:** `--chrome-radius: 0` everywhere — very DCC/authentic; may feel harsh vs modern web apps.
- **Screenshot:** Any capture.
- **Suggested fix:** Optional 2px radius on inputs/modals only.

#### P5 — “Building constructions” vs plugin tab catalog naming

- **What happens:** Tab id `apex.building` label “Building constructions” — longer than peer tabs.
- **Screenshot:** `/opt/cursor/artifacts/screenshots/ux-audit/1280-02-tab-building.png`
- **Suggested fix:** Align naming with README/AGENTS (“Building”).

---

## Functional issues (UX-adjacent / product bugs)

| ID | Severity | Summary | Repro | Artifact |
|----|----------|---------|-------|----------|
| F1 | Major | Properties stale when switching to Detect rooms (same as B1) | Section cut → Detect rooms | `ux-bug-inspector-stale-on-detect-rooms.png` |
| F2 | Minor | Toolbar draw-mode label clipped (“Polyt…”) | Wall + modes @ 1280w | `1280-03-walls-room.png` |
| F3 | Minor | Basics tools clip at 860w (“Grid axi…”) | 860×800 | `860-mobile-layout.png` |

No crashes, WASM load failures, or broken IFC export observed in smoke. Save/reload via localStorage succeeded in smoke.

---

## What works well

- **Plugin tab model** (Basics / Building / Engineering / Spaces) keeps MEP and annotations out of the building strip — matches mental model.
- **Schema-driven inspector** — wall/MEP/annotation fields appear without type-specific React forks; Edit profile / Draw new profile discovery is good.
- **INFO hint line** updates per tool (wall clicks remaining, duct elevation, detect rooms) — strong affordance when not contradicted by Properties (B1).
- **Path joins** (room rectangle, L, T) render convincingly in viewport captures.
- **Industrial dark theme** is consistent: tokens in `app.css`, active green readable on tools and lists.
- **Smoke coverage** proves end-to-end: all built-in tools, sketch editor, user `defineComponent`, browser filters, undo detach parent.

---

## Suggested next steps (engineering)

1. Fix B1/F1 (selection vs active tool) — highest user confusion.
2. Plan view or rename projection controls (M1).
3. Responsive toolbar strategy (M3) before marketing mobile/tablet.
4. Empty state + navigation help (M5, M6).
5. Category display names in browser (M4).

---

*Audit performed locally on 2026-10-24; artifacts attached to the accompanying PR.*
