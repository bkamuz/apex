# Door and window families

Doors and windows are **families**: one `ComponentDefinition` with an `opening`
recipe, plus named **types** stored in the project.

- **Recipe** (`definition.opening`): frame width/depth, sash/leaf count, transom,
  arch rise, infill (`glass` or `leaf`), plan symbol, threshold. Every field is an
  expression: a number or a parameter id.
- **Types** (`apex.window.default`, `apex.door.double-1400x2100`, …): named value
  sets for the parameters that are bound to a type. Editing a type updates every
  instance in one undo step. Projects saved before types existed load with the
  family's default type.
- **Swap**: inspector "Family / Type" selects, or the `set_element_type` command.
  Position and host wall are kept; swapping is one undo step.

## MCP / command API

| Command / query | Purpose |
| --- | --- |
| `list_family_types { family? }` | Types with values, default flag and instance count |
| `create_family_type { family, name, id?, base?, params }` | New type (default id `user.<family>.<slug>`) |
| `update_family_type { id, name?, params }` | Change type values; instances follow |
| `set_element_type { id, type }` | Swap type or family of an instance |

## Authoring a family without JSON

Component editor → **Window family** / **Door family** starts from the built-in
recipe. Change the recipe fields, add parameters, mark them "Shared type", save.
The family gets a `<id>.default` type automatically.

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

Set the family recipe's `generator` to `acme.slab`. Coordinates are opening-local
metres (x along the wall, y up, depth across the wall). Every instance of the
family using that generator rebuilds when it is (re)registered.
