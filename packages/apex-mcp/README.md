# apex-mcp

MCP server for Apex. Drive an Apex model from Cursor, Claude Desktop or any MCP client.

## Architecture

```
MCP client ──stdio / HTTP──▶ apex-mcp ──▶ Backend
                                         ├─ headless: apex WASM (same build as the web app) in Node
                                         └─ live:     WebSocket bridge ──▶ Apex web app in a browser
```

- **Command layer** (`apex-core`, `executeCommand` / `runQuery` / `describeApi`): every edit is a
  JSON command and one undo step. `batch` groups several commands into one step. Queries and
  exports have no side effects.
- **Tools are generated** from `describe_api`. Every element type becomes `place_<type>`, and every
  command and query becomes a tool, with its JSON schema taken from the descriptors
  ([docs/descriptors.md](../../docs/descriptors.md)). Plugins registered in a connected live app
  show up after a refresh, and clients get `tools/list_changed`.
- **Backends:** `headless` (default when no app is connected), `live`, or `auto` (live while an
  app is connected, headless otherwise).
- **Live bridge** (opt-in, `--bridge`): binds to 127.0.0.1 only and refuses non-loopback hosts.
  It requires a token, rejects browser origins that are not localhost, and supports `screenshot`.
- **Resources:** `apex://conventions`, `apex://api`, `apex://project/summary`,
  `apex://project/snapshot`, `apex://project/validation`, `apex://element-types/{id}`, `apex://elements/{id}`.
  **Prompts:** `apex-conventions`, `build-model` (takes a `brief`), `review-model`.

## Tools (67)

Placement: `place_wall`, `place_slab`, `place_slab_opening`, `place_column`, `place_beam`,
`place_door`, `place_window`, `place_stair`, `place_roof`, `place_roof_pitched`, `place_boolean`,
`place_duct`, `place_pipe`, `place_cable_tray`.
Elements: `create_element`, `update_element`, `delete_element`, `set_parent`, `move_elements`,
`copy_elements`, `boolean`, `set_slab_shape`, `join_paths`.
Levels and references: `create_level`, `set_active_level`, `set_level_elevation`,
`create_grid_axis`, `delete_grid_axis`, `create_reference`, `delete_reference`.
Spaces: `create_space`, `update_space`, `delete_space`, `detect_rooms`.
Views and sheets: `create_plan_view`, `create_3d_view`, `rename_view`, `delete_view`,
`create_view_annotation`, `delete_view_annotation`, `create_sheet`, `delete_sheet`,
`place_view_on_sheet`.
History: `undo`, `redo`, `batch`.
Queries: `summary`, `list_levels`, `list_elements`, `get_element`, `element_geometry`, `validate`,
`list_components`, `list_grid_axes`, `list_spaces`, `list_views`, `list_sheets`.
Exports: `export_view` (SVG/DXF), `export_sheet`, `export_project` (JSON), `export_ifc`.
Session: `describe_api`, `new_project`, `load_project`, `save_project`, `screenshot` (live only),
`bridge_status`.

Units are metres and radians, +Y is up, and plans lie in XZ.

Tips:

- `batch` runs many steps as one undo step. A later step can use an earlier result: `"$0.id"`
  (or `"$0"` for the whole result), so you can place a wall and its doors in one call. Steps
  may use `place_*` op names as well as core ops.
- Doors and windows must have a `parent` wall; a `slab_opening` needs a slab or roof.
- Walls take an instance `height`. Thickness belongs to the wall's profile type
  (`describe_api` → `profiles`) and can't be changed per instance.
- `export_view` and `export_sheet` take an optional `path` and then write the file locally.

## Build

```sh
npm install --prefix apps/web  # needed once for `npm run dev` (live bridge)
npm run wasm:build            # repo root, only if the Rust core changed (needs wasm-pack)
cd packages/apex-mcp && npm install && npm run build
```

## Cursor (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "apex": { "command": "node", "args": ["/path/to/apex/packages/apex-mcp/dist/cli.js"] }
  }
}
```

## Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "apex": {
      "command": "node",
      "args": ["/path/to/apex/packages/apex-mcp/dist/cli.js", "--bridge", "7317"],
      "env": { "APEX_MCP_TOKEN": "pick-a-long-random-string" }
    }
  }
}
```

## Live app

1. Start with `--bridge [port]`. The token comes from `--token`, or `APEX_MCP_TOKEN`, or is
   generated at random and printed to stderr.
2. In Apex, click **Agent**, enter `ws://127.0.0.1:7317` and the token, then click **Connect**.
   You can also open the app at `?mcp=ws://127.0.0.1:7317&mcpToken=<token>`.
3. Commands now edit the open model, the view updates, and `screenshot` returns a PNG of the viewport.

## HTTP

`apex-mcp --http 7316` serves Streamable HTTP at `http://127.0.0.1:7316/mcp`.

## Scripts and tests

- `npm test`: stdio and bridge tests (`node --test`).
- `npm run house`: builds a two-storey house over MCP, validates it, and writes IFC, SVG, DXF and
  JSON to `/tmp/apex-house-mcp`.
- `node scripts/bridge-e2e.mjs`: needs Playwright and `APEX_SMOKE_URL` pointing at a running web
  build. Drives the real app over the bridge and saves screenshots to `APEX_SHOTS`.
