# Genera, species and instances

Apex classifies placeable building parts biologically: **Genus → Species → Instance**
(RU: «Род → Вид → Экземпляр»).

| Level | RU | What it is | Where it lives |
| --- | --- | --- | --- |
| **Genus** | Род | A `ComponentDefinition` with an `opening` recipe: the rules (frame, sashes, infill, plan symbol, generator) and the parameters. `apex.window`, `apex.door`, user and plugin genera. | Component registry |
| **Species** | Вид | A named value set for the genus's species-bound ("Shared type") parameters: `apex.window.double-1500x1400`. A species inherits everything else from its genus. | Project (`species` in the save) |
| **Instance** | Экземпляр | One element standing in the model. It points at its species via the `species` param and adds its own instance params (position, host wall, sill height, …). | Document elements |

A species inherits its genus's recipe and defaults; an instance inherits its species's
values. Editing a species rebuilds every instance in one undo step. The model is
designed so that later versions can add nesting (a sub-genus refining a genus, a
species derived from another species) without changing the instance side: lookups
always walk instance → species → genus.

- **Swap**: inspector **Genus & species** section (Genus / Species selects) or the
  `set_element_species` command. Position and host wall are kept; one undo step.
- **Manage**: the same section can duplicate, rename and delete a species. Delete is
  refused while instances use it or for the genus's default species.
- Projects saved before species existed load with the genus's default species.

## MCP / command API

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
