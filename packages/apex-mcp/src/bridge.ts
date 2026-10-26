import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { type ApiCatalog, type Backend, BackendError, type Screenshot } from './backend.js';

/**
 * Live bridge: the MCP server listens on 127.0.0.1 and the Apex web app
 * connects to it (opt-in toggle in the app, token required). Requests run
 * against the user's open model, so they see changes live and can undo them.
 *
 * Wire format (JSON text frames):
 *   server → app  { id, method, params }
 *   app → server  { id, result } | { id, error }
 *   app → server  { type: 'hello', app: 'apex', version }   once, after open
 */
export interface BridgeOptions {
  port: number;
  host?: string;
  token?: string;
  timeoutMs?: number;
  log?: (msg: string) => void;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function isLocalOrigin(origin: string | undefined): boolean {
  if (!origin) return true; // non-browser client (tests, CLI)
  try {
    const { hostname } = new URL(origin);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
  } catch {
    return false;
  }
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export class LiveBridge implements Backend {
  readonly kind = 'live' as const;
  readonly token: string;
  readonly port: number;
  private wss: WebSocketServer;
  private client: WebSocket | null = null;
  private clientInfo: Record<string, unknown> = {};
  private seq = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private readonly timeoutMs: number;
  private readonly log: (msg: string) => void;
  private listeners = new Set<(connected: boolean) => void>();

  private constructor(opts: BridgeOptions, wss: WebSocketServer, port: number) {
    this.token = opts.token ?? '';
    this.wss = wss;
    this.port = port;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.log = opts.log ?? (() => {});
  }

  static async start(opts: BridgeOptions): Promise<LiveBridge> {
    const host = opts.host ?? '127.0.0.1';
    if (!LOOPBACK.has(host) && host !== 'localhost') {
      throw new BackendError(`the live bridge only binds to localhost (got ${host})`);
    }
    const token = opts.token ?? randomBytes(18).toString('base64url');
    const wss = new WebSocketServer({
      host,
      port: opts.port,
      maxPayload: 64 * 1024 * 1024,
      verifyClient: ({ req, origin }: { req: IncomingMessage; origin: string }, done) => {
        const remote = req.socket.remoteAddress ?? '';
        const url = new URL(req.url ?? '/', 'http://localhost');
        const given = url.searchParams.get('token') ?? '';
        if (!LOOPBACK.has(remote)) return done(false, 403, 'localhost only');
        if (!isLocalOrigin(origin)) return done(false, 403, 'origin must be localhost');
        if (!sameToken(given, token)) return done(false, 401, 'bad token');
        done(true);
      },
    });
    await new Promise<void>((res, rej) => {
      wss.once('listening', () => res());
      wss.once('error', rej);
    });
    const address = wss.address();
    const port = typeof address === 'object' && address ? address.port : opts.port;
    const bridge = new LiveBridge({ ...opts, token }, wss, port);
    wss.on('connection', (ws) => bridge.attach(ws));
    return bridge;
  }

  get url(): string {
    return `ws://127.0.0.1:${this.port}`;
  }

  connected(): boolean {
    return this.client !== null && this.client.readyState === this.client.OPEN;
  }

  onConnectionChange(fn: (connected: boolean) => void): void {
    this.listeners.add(fn);
  }

  private attach(ws: WebSocket) {
    if (this.client) {
      this.log('apex-mcp bridge: replacing the previous app connection');
      this.client.close(4000, 'replaced by a newer connection');
    }
    this.client = ws;
    this.clientInfo = {};
    this.log('apex-mcp bridge: app connected');
    ws.on('message', (data) => this.onMessage(String(data)));
    ws.on('close', () => {
      if (this.client !== ws) return;
      this.client = null;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new BackendError('the Apex app disconnected'));
      }
      this.pending.clear();
      this.log('apex-mcp bridge: app disconnected');
      for (const fn of this.listeners) fn(false);
    });
    for (const fn of this.listeners) fn(true);
  }

  private onMessage(text: string) {
    let msg: { id?: number; result?: unknown; error?: unknown; type?: string };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.type === 'hello') {
      this.clientInfo = msg as Record<string, unknown>;
      return;
    }
    if (typeof msg.id !== 'number') return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error !== undefined) p.reject(new BackendError(String(msg.error)));
    else p.resolve(msg.result);
  }

  request<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    const ws = this.client;
    if (!ws || !this.connected()) {
      return Promise.reject(
        new BackendError('no Apex app is connected: open Apex, then turn on "Agent bridge" with this token'),
      );
    }
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BackendError(`the Apex app did not answer ${method} within ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  execute(command: Record<string, unknown>) {
    return this.request('execute', { command });
  }
  query(query: Record<string, unknown>) {
    return this.request('query', { query });
  }
  describe() {
    return this.request<ApiCatalog>('describe');
  }
  async load(projectJson: string) {
    await this.request('load', { project: projectJson });
  }
  save() {
    return this.request<string>('save');
  }
  async reset() {
    await this.request('reset');
  }
  async screenshot(opts: { width?: number; height?: number }): Promise<Screenshot> {
    const r = await this.request<{ data: string }>('screenshot', opts);
    return { data: r.data.replace(/^data:image\/png;base64,/, ''), mimeType: 'image/png' };
  }
  status() {
    return { backend: 'live', url: this.url, connected: this.connected(), app: this.clientInfo };
  }

  async close() {
    this.client?.close();
    await new Promise<void>((res) => this.wss.close(() => res()));
  }
}

/** Route to the live app while one is connected, otherwise to the headless core. */
export class AutoBackend implements Backend {
  constructor(private readonly headless: Backend, private readonly live: LiveBridge) {}
  get kind() {
    return this.current().kind;
  }
  private current(): Backend {
    return this.live.connected() ? this.live : this.headless;
  }
  execute(c: Record<string, unknown>) {
    return this.current().execute(c);
  }
  query(q: Record<string, unknown>) {
    return this.current().query(q);
  }
  describe() {
    return this.current().describe();
  }
  load(p: string) {
    return this.current().load(p);
  }
  save() {
    return this.current().save();
  }
  reset() {
    return this.current().reset();
  }
  screenshot(opts: { width?: number; height?: number }) {
    if (!this.live.connected()) {
      return Promise.reject(new BackendError('screenshots need the live app: connect Apex through the Agent bridge'));
    }
    return this.live.screenshot(opts);
  }
  status() {
    return { routing: this.live.connected() ? 'live' : 'headless', headless: this.headless.status(), live: this.live.status() };
  }
}
