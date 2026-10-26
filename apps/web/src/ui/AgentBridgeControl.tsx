import { useEffect, useRef, useState } from 'react';
import { AgentBridge, type BridgeHost, type BridgeState, DEFAULT_BRIDGE_URL } from '../agentBridge';

interface Props {
  onModelChanged: (fit: boolean) => void;
  screenshot: (width?: number, height?: number) => Promise<string>;
}

const TOKEN_KEY = 'apex.agentBridge.token';
const URL_KEY = 'apex.agentBridge.url';

/** Opt-in toggle that lets a local MCP agent drive this tab. */
export function AgentBridgeControl({ onModelChanged, screenshot }: Props) {
  const hostRef = useRef<Props>({ onModelChanged, screenshot });
  hostRef.current = { onModelChanged, screenshot };
  const [state, setState] = useState<BridgeState>('off');
  const [detail, setDetail] = useState<string | undefined>();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState(() => sessionStorage.getItem(URL_KEY) ?? DEFAULT_BRIDGE_URL);
  const [token, setToken] = useState(() => sessionStorage.getItem(TOKEN_KEY) ?? '');
  const bridgeRef = useRef<AgentBridge | null>(null);

  if (!bridgeRef.current) {
    const host: BridgeHost = {
      onModelChanged: (fit) => hostRef.current.onModelChanged(fit),
      screenshot: (w, h) => hostRef.current.screenshot(w, h),
      onState: (s, d) => {
        setState(s);
        setDetail(d);
      },
    };
    bridgeRef.current = new AgentBridge(host);
  }

  // `?mcp=ws://127.0.0.1:7317&mcpToken=...` connects on load (still explicit: the user opened that link).
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const qUrl = q.get('mcp');
    const qToken = q.get('mcpToken');
    if (qToken) {
      const u = qUrl && qUrl !== '1' ? qUrl : DEFAULT_BRIDGE_URL;
      setUrl(u);
      setToken(qToken);
      bridgeRef.current?.connect(u, qToken);
    }
    return () => bridgeRef.current?.disconnect();
  }, []);

  const on = state === 'connected' || state === 'connecting';
  const connect = () => {
    sessionStorage.setItem(URL_KEY, url);
    sessionStorage.setItem(TOKEN_KEY, token);
    bridgeRef.current?.connect(url, token);
  };

  return (
    <div className="agent-bridge" data-testid="agent-bridge">
      <button
        type="button"
        className={on ? 'active' : undefined}
        aria-pressed={on}
        title="Let a local MCP agent (apex-mcp --bridge) drive this model"
        data-testid="agent-bridge-toggle"
        onClick={() => setOpen((v) => !v)}
      >
        Agent{state === 'connected' ? ' ●' : ''}
      </button>
      {open ? (
        <div className="agent-bridge-panel" role="dialog" aria-label="Agent bridge">
          <p>
            Run <code>apex-mcp --bridge</code> and paste the token it prints. Only localhost is allowed.
          </p>
          <label>
            URL
            <input value={url} onChange={(e) => setUrl(e.target.value)} data-testid="agent-bridge-url" />
          </label>
          <label>
            Token
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              data-testid="agent-bridge-token"
            />
          </label>
          <div className="agent-bridge-actions">
            {on ? (
              <button type="button" onClick={() => bridgeRef.current?.disconnect()} data-testid="agent-bridge-disconnect">
                Disconnect
              </button>
            ) : (
              <button type="button" onClick={connect} data-testid="agent-bridge-connect">
                Connect
              </button>
            )}
            <span data-testid="agent-bridge-state">{state}{detail ? `: ${detail}` : ''}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
