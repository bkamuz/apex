# Descriptors

Every registered thing in Apex carries a **descriptor**. It says what the thing is
for in a form an agent (MCP client, LLM, script) can act on without reading code.
The MCP server (`packages/apex-mcp`) builds its tool list and JSON schemas from
these descriptors at runtime. Register a new element type and it becomes a
`place_*` tool with no MCP code change.

## Required on

| Kind | Where | Enforced by |
|---|---|---|
| Element type (component definition) | `ComponentDefinition.descriptor` (Rust), `descriptor` in authored JSON / `registerComponent` | `DefinitionError::MissingDescriptor`; authored JSON without one fails to parse |
| Command / query | descriptor table in `apex-core/src/project/commands.rs`, exposed by `describe_api` | every command is listed with a descriptor |
| Tool | `registerTool({ descriptor })` | `MissingDescriptorError` (`apps/web/src/descriptor.ts`) |
| Exporter | `registerExporter({ descriptor })` | `MissingDescriptorError` |
| Annotation kind | `registerAnnotationKind({ descriptor })` | `MissingDescriptorError` |
| Opening generator | `registerOpeningGenerator({ id, descriptor, generate })` | `MissingDescriptorError`; Rust `RegistryError` |
| Plugin / runtime module | module `descriptor` | `MissingDescriptorError` |

Registration **fails** without a descriptor, or with an empty `purpose`. Tests:

- `registry::tests::registration_without_a_descriptor_fails` (Rust)
- `registry::tests::every_builtin_has_a_descriptor_with_a_valid_example` (Rust)
- `apps/web/scripts/smoke.mjs`: checks "a component without a descriptor is refused" and "a tool without a descriptor is refused"

## Fields

```jsonc
{
  "purpose": "One or two sentences: what it models and when to use it.", // required
  "examples": [{ "description": "3 m wall", "input": { /* params or command body */ } }],
  "constraints": ["thickness comes from the profile type, not the instance"],
  "units": "metres, radians",          // omitted = metres / radians / +Y up
  "points": "two points: start and end of the centreline"
}
```

`id` and `name` come from the thing itself and are not repeated. The parameter
JSON schema is derived from the definition's parameters.

## Writing one

- Write `purpose` for someone choosing between tools: "Load-bearing or partition
  wall along a centreline", not "Wall component".
- Give at least one `example` that works when pasted. Builtin examples are placed in a test.
- Put anything the core rejects into `constraints`, for example "doors and windows need a wall host".

## Builtins

All builtin element types, commands and queries, first-party tools, exporters and
annotation kinds have descriptors. To see them, call `describe_api` (MCP) or
`apexDescribeApi()` (web).
