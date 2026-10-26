# Genera, species and instances

Apex classifies placeable building parts biologically: **Genus → Species → Instance**
(RU: «Род → Вид → Экземпляр»).

| Level | RU | What it is | Where it lives |
| --- | --- | --- | --- |
| **Genus** | Род | A `ComponentDefinition` with a universal `genus` body: params with formulas, reference geometry, solids, cuts and nested genera (see below). `apex.window`, `apex.door`, user and plugin genera. | Component registry |
| **Species** | Вид | A named value set for the genus's species-bound ("Shared type") parameters: `apex.window.double-1500x1400`. A species inherits everything else from its genus. | Project (`species` in the save) |
| **Instance** | Экземпляр | One element standing in the model. It points at its species via the `species` param and adds its own instance params (position, host wall, sill height, …). | Document elements |

A species inherits its genus's recipe and defaults; an instance inherits its species's
values. Editing a species rebuilds every instance in one undo step. Lookups always
walk instance → species → genus → parent genus (`extends`).

- **Swap**: inspector **Genus & species** section (Genus / Species selects) or the
  `set_element_species` command. Position and host wall are kept; one undo step.
- **Manage**: the same section can duplicate, rename and delete a species. Delete is
  refused while instances use it or for the genus's default species.
- Projects saved before species existed load with the genus's default species.

## The universal genus format

Every genus has the same shape. Windows and doors are ordinary genus data (a nested
frame genus, a nested infill genus and a host cut); there is no special code path.

```jsonc
{
  "op": "define_genus",
  "id": "user.shelf", "name": "Shelf", "category": "furniture",
  "extends": "user.base",                       // optional parent genus
  "placement": {"kind": "point"},               // point | line | host {categories}
  "params": [{"id": "width", "default": 1.2},   // kind: length (default) | number | text
             {"id": "finish", "kind": "text", "default": "oak", "species": true}],
  "refs": [{"id": "top", "ref": "plane", "origin": [0, "height", 0], "normal": "y"}],
  "body": [
    {"id": "board", "item": "solid", "shape": "box", "min": [0,0,0], "max": ["width","height",0.4]},
    {"id": "notch", "item": "cut",   "shape": "box", "min": [0.2,0.6,-0.1], "max": [0.5,1,0.5],
     "targets": {"self": true}},
    {"id": "chase", "item": "cut",   "shape": "box", "min": [0.8,0,-0.2], "max": [1,"height",0.6],
     "targets": {"neighbours": ["column"]}},
    {"id": "leg",   "item": "nested", "genus": "user.leg", "at": "top",
     "offset": [0.05, 0, 0.05], "rotation": 0, "params": {"height": "height - 0.04"}}
  ],
  "remove": ["old_item"]                        // inherited ids to drop
}
```

- **Local frame**: x along the element (the line, or the host wall), y up, z across.
  Formulas are numbers or strings over param ids. `length` is injected for line
  placement and `host_depth` (host thickness) for host placement.
- **Params** carry formulas everywhere a number goes. `species: true` binds the param
  to the species ("Shared type") instead of the instance.
- **Reference geometry** (`point`, `line`, `plane`) gives nested items and shapes
  (`on`) a named anchor.
- **Body**: `solid` and `cut` take a shape: `box {min,max}`, `prism {normal, on?,
  loops, depth}`, `revolve {profile, on?, segments?}` or `opening_part {part:
  frame|infill|all}` (the opening recipe in scope). `nested` places another genus.
- **Cut targets** can be combined: `host` (the element it is inserted into),
  `neighbours` (other intersecting elements, filtered by category; `[]` = any) and
  `self` (this genus's own solids). Cuts are mesh booleans applied in a fixed order,
  so results are deterministic. A cut that fails as a boolean leaves the mesh as it
  was and is reported in `warnings`.
- **Nesting**: each child param is bound by a formula over the parent's params.
  Unbound child params take the parent's same-named value, or else their default.
  Nesting cycles and depth over 16 are refused.
- **Inheritance**: `extends` takes the parent's params, refs and body. A param with
  the same id overrides the parent's default. A body item or ref with the same id
  replaces the parent's. `remove` drops one. Cycles are refused. Editing a parent
  rebuilds instances of every genus that extends or nests it.
- **Provenance**: `get_genus` and `param_provenance` report each param's `source`:
  `instance`, `species`, `genus` (declared here) or `inherited` (with `from`, the
  ancestor genus).
- **Placement**: `point` (one pick plus rotation), `line` (two picks), and `host`
  (into an element whose category is in `categories`, like a window into a wall). In
  the editor, host genera get the hosted placement tool.
- Built-in genera are read-only. Extend them instead (for example
  `"extends": "apex.window"`).
- Old projects load unchanged. A saved genus without a `genus` body (an opening
  recipe only) is adapted to the standard opening body.

## MCP / command API

| Command / query | Purpose |
| --- | --- |
| `define_genus { id, name, category?, purpose?, extends?, placement?, params?, refs?, body?, remove? }` | Create or replace a user genus; instances rebuild |
| `set_genus_item { genus, item }` | Add a body item, or replace the one with the same id (an inherited id overrides the parent's) |
| `remove_genus_item { genus, id }` | Remove an item or ref; an inherited one is listed in `remove` |
| `get_genus { id }` | Authored and resolved body, params with provenance, trial build (solids, cuts, warnings) |
| `param_provenance { id }` | Where each param of an element comes from |

Place a genus with `create_element { component: <genus id>, points, parent? }`.
The MCP server turns every described command into a tool, so these need no MCP code.

### Species

| Command / query | Purpose |
| --- | --- |
| `list_genus_species { genus? }` | Species with values, default flag and instance count |
| `create_species { genus, name, id?, base?, params }` | New species (default id `user.<genus>.<slug>`); returns `{ species }` |
| `update_species { id, name?, params }` | Rename or change species values; instances follow |
| `delete_species { id }` | Delete an unused, non-default species |
| `set_element_species { id, species }` | Swap the species (and so maybe the genus) of an instance |

### Compatibility

Projects and scripts from the first release (PR #114) keep working:

- Deprecated op aliases: `list_family_types`, `create_family_type`,
  `update_family_type`, `set_element_type`; field `family` = `genus`, `type` = `species`.
- Saves with `family_types`, `family`, `default_type` and an element param `type`
  load; the param is migrated to `species`.

## Authoring a genus without JSON

Component editor → **Window genus** / **Door genus** starts from the built-in
recipe. Change the recipe fields, add parameters, mark them "Shared type" (species-bound), save.
The genus gets a `<id>.default` species automatically.

## Custom geometry from a plugin

```ts
extensions.registerOpeningGenerator({
  id: 'acme.slab',
  descriptor: { purpose: 'Flat slab door leaf.' },
  generate: (params, wallDepth) => ({
    parts: [{ loops: [[[-0.45, 0], [0.45, 0], [0.45, 2.1], [-0.45, 2.1]]],
              origin: [0, 0], angle: 0, d0: -0.02, d1: 0.02, glass: false }],
    lines: [],
  }),
});
```

Set the genus recipe's `generator` to `acme.slab`. Coordinates are opening-local
metres (x along the wall, y up, depth across the wall). Every instance of the
genus using that generator rebuilds when it is (re)registered.
