#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Backend } from './backend.js';
import { AutoBackend, LiveBridge } from './bridge.js';
import { HeadlessBackend } from './headless.js';
import { createApexServer, type ApexMcp } from './server.js';

const HELP = `apex-mcp — MCP server for Apex

  apex-mcp [options]

  --http [port]        serve Streamable HTTP on 127.0.0.1:port/mcp (default 7316) instead of stdio
  --host <host>        HTTP bind address (default 127.0.0.1)
  --bridge [port]      also accept the live Apex web app on ws://127.0.0.1:port (default 7317)
  --token <token>      bridge token (default: APEX_MCP_TOKEN or a random one, printed to stderr)
  --backend <mode>     headless | live | auto (default: auto = live while an app is connected)
  --project <file>     load this project JSON into the headless model at start
  -h, --help
`;

function parse(argv: string[]) {
  const o: { http?: number; host: string; bridge?: number; token?: string; backend: string; project?: string } = {
    host: '127.0.0.1',
    backend: 'auto',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const num = (d: number) => (argv[i + 1] && /^\d+$/.test(argv[i + 1]) ? Number(argv[++i]) : d);
    if (a === '--http') o.http = num(7316);
    else if (a === '--bridge') o.bridge = num(7317);
    else if (a === '--host') o.host = argv[++i];
    else if (a === '--token') o.token = argv[++i];
    else if (a === '--backend') o.backend = argv[++i];
    else if (a === '--project') o.project = argv[++i];
    else if (a === '-h' || a === '--help') {
      process.stdout.write(HELP);
      process.exit(0);
    } else {
      process.stderr.write(`unknown option ${a}\n${HELP}`);
      process.exit(2);
    }
  }
  if (!['headless', 'live', 'auto'].includes(o.backend)) throw new Error(`--backend must be headless, live or auto`);
  if (o.backend === 'live' && o.bridge === undefined) o.bridge = 7317;
  return o;
}

const log = (m: string) => process.stderr.write(`${m}\n`);

async function main() {
  const opts = parse(process.argv.slice(2));
  const headless = await HeadlessBackend.create();
  if (opts.project) await headless.load(readFileSync(opts.project, 'utf8'));

  let bridge: LiveBridge | undefined;
  if (opts.bridge !== undefined) {
    bridge = await LiveBridge.start({ port: opts.bridge, token: opts.token ?? process.env.APEX_MCP_TOKEN, log });
    log(`apex-mcp bridge listening on ${bridge.url}`);
    log(`apex-mcp bridge token: ${bridge.token}`);
    log('  In Apex: Agent bridge → paste the URL and token → Connect (or open the app with ?mcp=<url>&mcpToken=<token>)');
  }
  const backend: Backend =
    opts.backend === 'headless' || !bridge ? headless : opts.backend === 'live' ? bridge : new AutoBackend(headless, bridge);

  const sessions = new Set<ApexMcp>();
  bridge?.onConnectionChange(() => {
    for (const s of sessions) void s.refresh().catch(() => {});
  });

  if (opts.http === undefined) {
    const mcp = await createApexServer(backend, headless);
    sessions.add(mcp);
    await mcp.server.connect(new StdioServerTransport());
    log('apex-mcp ready on stdio');
    return;
  }

  const transports = new Map<string, StreamableHTTPServerTransport>();
  const readBody = (req: IncomingMessage) =>
    new Promise<unknown>((res, rej) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        try {
          res(data ? JSON.parse(data) : undefined);
        } catch (e) {
          rej(e);
        }
      });
      req.on('error', rej);
    });

  const http = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/mcp') {
      res.writeHead(404).end('apex-mcp: POST /mcp');
      return;
    }
    try {
      const sid = req.headers['mcp-session-id'];
      const body = req.method === 'POST' ? await readBody(req) : undefined;
      let transport = typeof sid === 'string' ? transports.get(sid) : undefined;
      if (!transport) {
        if (req.method !== 'POST' || !isInitializeRequest(body)) {
          res.writeHead(400, { 'content-type': 'application/json' }).end(
            JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'no valid session; send initialize first' }, id: null }),
          );
          return;
        }
        const mcp = await createApexServer(backend, headless);
        const t: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableDnsRebindingProtection: true,
          allowedHosts: [`127.0.0.1:${opts.http}`, `localhost:${opts.http}`],
          onsessioninitialized: (id) => {
            transports.set(id, t);
          },
        });
        t.onclose = () => {
          if (t.sessionId) transports.delete(t.sessionId);
          sessions.delete(mcp);
        };
        sessions.add(mcp);
        await mcp.server.connect(t);
        transport = t;
      }
      await transport.handleRequest(req, res, body);
    } catch (e) {
      if (!res.headersSent) res.writeHead(500).end(String(e));
    }
  });
  await new Promise<void>((r) => http.listen(opts.http, opts.host, r));
  log(`apex-mcp ready on http://${opts.host}:${opts.http}/mcp`);
}

main().catch((e) => {
  log(`apex-mcp: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
