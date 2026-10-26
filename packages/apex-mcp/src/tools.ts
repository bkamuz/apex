import type { ApiCatalog, Descriptor } from './backend.js';

/** One MCP tool, generated from a descriptor (or one of the few fixed session tools). */
export interface ToolSpec {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
  /** How a call maps onto the backend. */
  route:
    | { kind: 'command'; op: string }
    | { kind: 'query'; op: string }
    | { kind: 'place'; component: string }
    | { kind: 'session'; name: SessionTool };
}

export type SessionTool =
  | 'describe_api'
  | 'new_project'
  | 'load_project'
  | 'save_project'
  | 'export_ifc'
  | 'screenshot'
  | 'bridge_status';

const NAME_OK = /^[a-zA-Z0-9_-]{1,64}$/;

export function placeToolName(componentId: string): string {
  const short = componentId.startsWith('apex.') ? componentId.slice(5) : componentId;
  return `place_${short.replace(/[^a-zA-Z0-9]+/g, '_')}`.slice(0, 64);
}

function describe(d: Descriptor, extra: string[] = []): string {
  const parts = [d.purpose];
  if (d.points) parts.push(`Points: ${d.points}`);
  if (d.units) parts.push(`Units: ${d.units}.`);
  if (d.constraints?.length) parts.push(`Constraints:\n- ${d.constraints.join('\n- ')}`);
  parts.push(...extra);
  if (d.examples?.length) {
    parts.push(
      'Examples:\n' +
        d.examples.map((e) => `- ${e.description}: ${JSON.stringify(e.input)}`).join('\n'),
    );
  }
  return parts.join('\n\n');
}

/** Strip the `op` discriminator: the tool name already selects it. */
function withoutOp(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  const s = structuredClone(schema ?? { type: 'object', properties: {} }) as {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
  s.type = 'object';
  s.properties = { ...(s.properties ?? {}) };
  delete s.properties.op;
  if (s.required) s.required = s.required.filter((r) => r !== 'op');
  if (s.required && s.required.length === 0) delete s.required;
  return s as Record<string, unknown>;
}

const POINT = {
  type: 'array',
  items: { type: 'number' },
  minItems: 3,
  maxItems: 3,
  description: '[x, y, z] in metres; plan is the XZ plane, +Y is up',
};

const SESSION: Omit<ToolSpec, 'route'>[] & { name: SessionTool }[] = [
  {
    name: 'describe_api',
    title: 'Describe API',
    description:
      'Full machine-readable catalog: conventions, element types (with params JSON Schema), commands, queries and annotation types, each with purpose, examples, units and constraints. Read this first if unsure.',
    inputSchema: { type: 'object', properties: {} },
    readOnly: true,
  },
  {
    name: 'new_project',
    title: 'New project',
    description: 'Discard the current model and start a blank project with Level 0 and the built-in types. Not undoable.',
    inputSchema: { type: 'object', properties: {} },
    readOnly: false,
  },
  {
    name: 'load_project',
    title: 'Load project',
    description: 'Replace the model from Apex project JSON (the format Save writes). Pass `json` text or a local `path`.',
    inputSchema: {
      type: 'object',
      properties: { json: { type: 'string' }, path: { type: 'string', description: 'local file path' } },
    },
    readOnly: false,
  },
  {
    name: 'save_project',
    title: 'Save project',
    description: 'Project JSON snapshot. With `path`, also writes it to that local file and returns only the size.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    readOnly: true,
  },
  {
    name: 'export_ifc',
    title: 'Export IFC',
    description: 'IFC4 STEP export of the whole model. With `path`, writes the file; otherwise returns the text.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        mapping: { type: 'object', description: 'optional { componentId: IfcEntity } overrides' },
      },
    },
    readOnly: true,
  },
  {
    name: 'screenshot',
    title: 'Screenshot',
    description: 'PNG of the live Apex viewport (live bridge only). Use it to check what you built looks right.',
    inputSchema: {
      type: 'object',
      properties: { width: { type: 'integer', minimum: 64 }, height: { type: 'integer', minimum: 64 } },
    },
    readOnly: true,
  },
  {
    name: 'bridge_status',
    title: 'Backend status',
    description: 'Which backend runs commands (headless WASM or the live app) and whether an app is connected.',
    inputSchema: { type: 'object', properties: {} },
    readOnly: true,
  },
];

/** Generate the tool list. Nothing about element types or commands is hand-written here. */
export function buildTools(api: ApiCatalog): ToolSpec[] {
  const tools: ToolSpec[] = [];
  for (const d of api.element_types) {
    tools.push({
      name: placeToolName(d.id),
      title: `Place ${d.name}`,
      description: describe(d, [
        `Shortcut for create_element with component "${d.id}". Returns the new id.`,
      ]),
      inputSchema: {
        type: 'object',
        properties: {
          points: { type: 'array', items: POINT, description: d.points ?? 'placement picks' },
          params: { ...(d.params_schema ?? { type: 'object' }), description: `${d.name} parameters` },
          level: { type: 'string', description: 'level id or exact name; default the active level' },
          parent: { type: 'string', description: 'host / parent element id' },
          name: { type: 'string' },
          rotation: { type: 'number', description: 'radians about +Y' },
          placement_kind: { type: 'string', enum: ['point', 'two_point', 'three_point_arc', 'polyline', 'path', 'free'] },
        },
        required: ['points'],
        additionalProperties: false,
      },
      readOnly: false,
      route: { kind: 'place', component: d.id },
    });
  }
  for (const d of api.commands) {
    tools.push({
      name: d.id,
      title: d.name,
      description: describe(d, ['One undo step.']),
      inputSchema: withoutOp(d.params_schema),
      readOnly: false,
      route: { kind: 'command', op: d.id },
    });
  }
  for (const d of api.queries) {
    tools.push({
      name: d.id,
      title: d.name,
      description: describe(d, ['Read-only.']),
      inputSchema: withoutOp(d.params_schema),
      readOnly: true,
      route: { kind: 'query', op: d.id },
    });
  }
  for (const s of SESSION) tools.push({ ...s, route: { kind: 'session', name: s.name } });

  const seen = new Set<string>();
  for (const t of tools) {
    if (!NAME_OK.test(t.name)) throw new Error(`generated tool name '${t.name}' is not a valid MCP tool name`);
    if (seen.has(t.name)) throw new Error(`duplicate generated tool name '${t.name}'`);
    seen.add(t.name);
  }
  return tools;
}

export function conventionsMarkdown(api: ApiCatalog): string {
  const lines = ['# Apex modelling conventions', ''];
  for (const [k, v] of Object.entries(api.conventions)) lines.push(`## ${k}`, '', v, '');
  lines.push('## Element types', '');
  for (const d of api.element_types) {
    lines.push(`- **${d.id}** (${d.name}): ${d.purpose}${d.points ? ` Points: ${d.points}` : ''}`);
  }
  lines.push('', '## Annotation types', '');
  for (const d of api.annotation_types) lines.push(`- **${d.id}**: ${d.purpose}`);
  return lines.join('\n');
}
