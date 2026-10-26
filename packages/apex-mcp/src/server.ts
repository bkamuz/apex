import { readFile, writeFile } from 'node:fs/promises';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { ApiCatalog, Backend } from './backend.js';
import { buildTools, conventionsMarkdown, type ToolSpec } from './tools.js';

export const SERVER_NAME = 'apex';
export const SERVER_VERSION = '0.1.0';

const text = (value: unknown): CallToolResult => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});
const fail = (message: string): CallToolResult => ({ content: [{ type: 'text', text: message }], isError: true });

export interface ApexMcp {
  server: Server;
  /** Re-read descriptors (after a load or a live connect) and notify clients. */
  refresh(): Promise<void>;
  tools(): ToolSpec[];
}

/**
 * `catalog`: where descriptors come from when `backend` cannot answer yet (a
 * live bridge with no app connected). Defaults to `backend` itself.
 */
export async function createApexServer(backend: Backend, catalog?: Backend): Promise<ApexMcp> {
  const describe = async (): Promise<ApiCatalog> => {
    try {
      return await backend.describe();
    } catch (e) {
      if (!catalog || catalog === backend) throw e;
      return catalog.describe();
    }
  };
  let api: ApiCatalog = await describe();
  let tools = buildTools(api);
  let byName = new Map(tools.map((t) => [t.name, t]));

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: { listChanged: true }, resources: { listChanged: true }, prompts: {} },
      instructions:
        'Apex is a parametric BIM modeller. Lengths are metres, angles radians, +Y is up and plans lie in XZ. ' +
        'Read the apex://conventions resource (or call describe_api) first. Each command is one undo step; use `batch` ' +
        'for several steps at once. Call `validate` when done.',
    },
  );

  const refresh = async () => {
    api = await describe();
    const next = buildTools(api);
    const changed = JSON.stringify(next.map((t) => [t.name, t.inputSchema])) !== JSON.stringify(tools.map((t) => [t.name, t.inputSchema]));
    tools = next;
    byName = new Map(tools.map((t) => [t.name, t]));
    if (changed) {
      await server.sendToolListChanged().catch(() => {});
      await server.sendResourceListChanged().catch(() => {});
    }
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: t.inputSchema as { type: 'object' },
      annotations: { title: t.title, readOnlyHint: t.readOnly, destructiveHint: t.name === 'new_project' || t.name === 'load_project', openWorldHint: false },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = byName.get(req.params.name);
    if (!tool) return fail(`unknown tool '${req.params.name}'`);
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    try {
      return await call(tool, args);
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  });

  async function call(tool: ToolSpec, args: Record<string, unknown>): Promise<CallToolResult> {
    const route = tool.route;
    switch (route.kind) {
      case 'command':
        return text(await backend.execute({ ...args, op: route.op }));
      case 'query': {
        const out = await backend.query({ ...args, op: route.op });
        return text(out);
      }
      case 'place':
        return text(await backend.execute({ ...args, op: 'create_element', component: route.component }));
      case 'session':
        switch (route.name) {
          case 'describe_api':
            return text(api);
          case 'new_project':
            await backend.reset();
            await refresh();
            return text({ ok: true });
          case 'load_project': {
            const json = typeof args.json === 'string' ? args.json : typeof args.path === 'string' ? await readFile(args.path, 'utf8') : null;
            if (json === null) return fail('pass `json` or `path`');
            await backend.load(json);
            await refresh();
            return text(await backend.query({ op: 'summary' }));
          }
          case 'save_project': {
            const json = await backend.save();
            if (typeof args.path === 'string') {
              await writeFile(args.path, json);
              return text({ path: args.path, bytes: Buffer.byteLength(json) });
            }
            return text(json);
          }
          case 'export_ifc': {
            const out = (await backend.query({ op: 'export_ifc', mapping: args.mapping ?? null })) as { content: string };
            if (typeof args.path === 'string') {
              await writeFile(args.path, out.content);
              return text({ path: args.path, bytes: Buffer.byteLength(out.content) });
            }
            return text(out.content);
          }
          case 'screenshot': {
            if (!backend.screenshot) return fail('screenshots need the live app (start with --bridge and connect Apex)');
            const shot = await backend.screenshot({ width: args.width as number | undefined, height: args.height as number | undefined });
            return { content: [{ type: 'image', data: shot.data, mimeType: shot.mimeType }] };
          }
          case 'bridge_status':
            return text(backend.status());
        }
    }
  }

  // ---- resources ---------------------------------------------------------
  const RESOURCES = [
    { uri: 'apex://conventions', name: 'conventions', title: 'Modelling conventions', mimeType: 'text/markdown', description: 'Axes, units, levels, hosting, joins, undo.' },
    { uri: 'apex://api', name: 'api', title: 'API catalog', mimeType: 'application/json', description: 'Every element type, command, query and annotation type with its descriptor.' },
    { uri: 'apex://project/summary', name: 'project-summary', title: 'Project summary', mimeType: 'application/json', description: 'Counts, levels and the active level of the open model.' },
    { uri: 'apex://project/snapshot', name: 'project-snapshot', title: 'Project JSON', mimeType: 'application/json', description: 'The full project snapshot (what Save writes).' },
    { uri: 'apex://project/validation', name: 'validation', title: 'Validation report', mimeType: 'application/json', description: 'Errors and warnings: unknown types, missing hosts, non-watertight solids.' },
  ];
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      ...RESOURCES,
      ...api.element_types.map((d) => ({ uri: `apex://element-types/${d.id}`, name: d.id, title: d.name, mimeType: 'application/json', description: d.purpose })),
    ],
  }));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [
      { uriTemplate: 'apex://element-types/{id}', name: 'element-type', title: 'Element type descriptor', mimeType: 'application/json' },
      { uriTemplate: 'apex://elements/{id}', name: 'element', title: 'Element', mimeType: 'application/json' },
    ],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const uri = req.params.uri;
    const json = (v: unknown) => ({ contents: [{ uri, mimeType: 'application/json', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });
    if (uri === 'apex://conventions') return { contents: [{ uri, mimeType: 'text/markdown', text: conventionsMarkdown(api) }] };
    if (uri === 'apex://api') return json(api);
    if (uri === 'apex://project/summary') return json(await backend.query({ op: 'summary' }));
    if (uri === 'apex://project/snapshot') return json(await backend.save());
    if (uri === 'apex://project/validation') return json(await backend.query({ op: 'validate' }));
    const type = uri.match(/^apex:\/\/element-types\/(.+)$/);
    if (type) {
      const d = api.element_types.find((t) => t.id === decodeURIComponent(type[1]));
      if (!d) throw new Error(`no element type '${type[1]}'`);
      return json(d);
    }
    const el = uri.match(/^apex:\/\/elements\/(.+)$/);
    if (el) return json(await backend.query({ op: 'get_element', id: decodeURIComponent(el[1]) }));
    throw new Error(`unknown resource ${uri}`);
  });

  // ---- prompts -----------------------------------------------------------
  const PROMPTS = [
    { name: 'apex-conventions', title: 'Apex conventions', description: 'Load the modelling conventions and element catalog into the conversation.' },
    { name: 'build-model', title: 'Build a model', description: 'Plan and build a model from a brief, then validate it.', arguments: [{ name: 'brief', description: 'What to build, e.g. "a 10x8 m two-storey house"', required: true }] },
    { name: 'review-model', title: 'Review the model', description: 'Inspect the open model, list problems and fix them.' },
  ];
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: PROMPTS }));
  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const conv = conventionsMarkdown(api);
    const user = (t: string) => ({ role: 'user' as const, content: { type: 'text' as const, text: t } });
    switch (req.params.name) {
      case 'apex-conventions':
        return { description: 'Apex conventions', messages: [user(conv)] };
      case 'build-model': {
        const brief = req.params.arguments?.brief ?? 'a small single-storey building';
        return {
          description: 'Build a model',
          messages: [
            user(
              `${conv}\n\n---\n\nBuild this in Apex: ${brief}\n\n` +
                'Work like this:\n1. Plan levels, the wall loop and openings in metres.\n' +
                '2. Create levels, then walls (close loops by repeating the first point), slabs, roof, then doors/windows with `parent` = wall id.\n' +
                '3. Group related steps with `batch` so each group is one undo step.\n' +
                '4. Call `validate`; fix every error. Call `summary` and report what you built.',
            ),
          ],
        };
      }
      case 'review-model':
        return {
          description: 'Review the model',
          messages: [user(`${conv}\n\n---\n\nCall \`summary\`, \`list_elements\` and \`validate\`. List each problem with the element id and fix what you can, one command per fix.`)],
        };
    }
    throw new Error(`unknown prompt ${req.params.name}`);
  });

  return { server, refresh, tools: () => tools };
}
