/**
 * Live agent bridge: connects this tab to a local `apex-mcp --bridge` server
 * so an MCP client (Cursor, Claude Desktop) can drive the open model.
 *
 * Opt-in only: nothing connects until the user turns it on (or opens the app
 * with `?mcp=ws://127.0.0.1:7317&mcpToken=...`). Only loopback URLs are
 * accepted and the server rejects connections without its token.
 *
 * Protocol: the server sends `{id, method, params}`; we answer
 * `{id, result}` or `{id, error}`. We send `{type: 'hello'}` once.
 */
import {
  apexDescribeApi,
  apexExecuteCommand,
  apexExportProject,
  apexImportProject,
  apexNewProject,
  apexRunQuery,
} from './wasm/apex';

export type BridgeState = 'off' | 'connecting' | 'connected' | 'error';

export interface BridgeHost {
  /** The model changed (command, load, reset): refresh the UI. */
  onModelChanged(fit: boolean): void;
  /** PNG data URL of the current 3D viewport. */
  screenshot(width?: number, height?: number): Promise<string>;
  onState(state: BridgeState, detail?: string): void;
}

export const DEFAULT_BRIDGE_URL = 'ws://127.0.0.1:7317';

export function isLoopbackUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return false;
    return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(u.hostname);
  } catch {
    return false;
  }
}

export class AgentBridge {
  private ws: WebSocket | null = null;
  private stopped = true;

  constructor(private readonly host: BridgeHost) {}

  get active(): boolean {
    return !this.stopped;
  }

  connect(url: string, token: string): void {
    this.disconnect();
    if (!isLoopbackUrl(url)) {
      this.host.onState('error', 'The agent bridge only connects to localhost.');
      return;
    }
    if (!token.trim()) {
      this.host.onState('error', 'Enter the token printed by apex-mcp.');
      return;
    }
    this.stopped = false;
    const target = new URL(url);
    target.searchParams.set('token', token.trim());
    this.host.onState('connecting');
    const ws = new WebSocket(target.toString());
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'hello', app: 'apex-web', url: location.origin }));
      this.host.onState('connected');
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (!this.stopped) {
        this.stopped = true;
        this.host.onState('error', e.reason || 'Connection closed (wrong token, or apex-mcp is not running with --bridge).');
      }
    };
    ws.onmessage = (e) => void this.handle(ws, String(e.data));
  }

  disconnect(): void {
    this.stopped = true;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.host.onState('off');
  }

  private async handle(ws: WebSocket, text: string): Promise<void> {
    let msg: { id?: number; method?: string; params?: Record<string, unknown> };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof msg.id !== 'number' || !msg.method) return;
    try {
      const result = await this.dispatch(msg.method, msg.params ?? {});
      ws.send(JSON.stringify({ id: msg.id, result: result ?? null }));
    } catch (err) {
      ws.send(JSON.stringify({ id: msg.id, error: err instanceof Error ? err.message : String(err) }));
    }
  }

  private async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'execute': {
        const out = apexExecuteCommand(params.command as Record<string, unknown>);
        this.host.onModelChanged(false);
        return out;
      }
      case 'query':
        return apexRunQuery(params.query as Record<string, unknown>);
      case 'describe':
        return apexDescribeApi();
      case 'save':
        return apexExportProject();
      case 'load':
        apexImportProject(String(params.project));
        this.host.onModelChanged(true);
        return null;
      case 'reset':
        apexNewProject();
        this.host.onModelChanged(true);
        return null;
      case 'screenshot':
        return { data: await this.host.screenshot(params.width as number, params.height as number) };
      default:
        throw new Error(`unknown bridge method ${method}`);
    }
  }
}
