# System packs

First-party tools are grouped into **system packs** (Obsidian-style). Settings
can enable or disable a pack; the toolbar and File exporters/importers rebuild
from the enabled set. Always-on chrome (Select, Move, Copy, Parent, project
JSON Open) is not toggleable.

Community marketplace plugins are a later phase. Runtime
`window.apex.registerTool` / `registerExporter` / `registerImporter` stays the
open-world precursor and is not gated by packs.

## Catalog

| Pack id | Default | Contributes |
|---|---|---|
| *(always on)* | — | select, move, copy, parent, project JSON |
| `apex.pack.basics` | on | Level, Ref point, Ref plane, Construction line, Grid axis, Section cut |
| `apex.pack.building` | on | Wall, Column, Beam, Slab, openings, Stair, roofs |
| `apex.pack.engineering` | on | Pipe, Duct, Cable tray |
| `apex.pack.spaces` | on | Space + Detect rooms |
| `apex.pack.annotate` | on | View annotations |
| `apex.pack.ifc` | on | IFC import / export |

Source: [`apps/web/src/plugins/catalog.ts`](../apps/web/src/plugins/catalog.ts).
Prefs key: `apex.packs.enabled` (JSON string array of enabled pack ids).

## Adding a system pack

1. Implement one or more `Plugin`s under `apps/web/src/plugins/` (same
   `install(host)` as today — full `PluginHost`).
2. Append a `SystemPack` entry to `systemPacks` in `catalog.ts`
   (`id`, `labelKey`, `defaultEnabled`, `plugins`).
3. Add EN/RU strings for `labelKey` (e.g. `settings.pack.myarea`).
4. Prefer a shared `tool.tab` so an empty tab hides when the pack is off.

Do **not** add `if (componentId === …)` branches in `App.tsx`, `apex-wasm`, or
geometry. Tabs stay data-driven from tools.
