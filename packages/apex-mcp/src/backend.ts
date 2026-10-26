/** What the MCP layer needs from a model host: the WASM core in Node, or a live browser tab. */
export interface ApiCatalog {
  conventions: Record<string, string>;
  element_types: Descriptor[];
  commands: Descriptor[];
  queries: Descriptor[];
  annotation_types: Descriptor[];
}

export interface Descriptor {
  id: string;
  kind: string;
  name: string;
  purpose: string;
  params_schema?: Record<string, unknown>;
  examples?: { description: string; input: unknown }[];
  constraints?: string[];
  units?: string;
  points?: string;
}

export interface Screenshot {
  /** base64 PNG */
  data: string;
  mimeType: 'image/png';
}

export interface Backend {
  readonly kind: 'headless' | 'live';
  /** Run one serialized command (one undo step). Returns its JSON result. */
  execute(command: Record<string, unknown>): Promise<unknown>;
  /** Run one read-only query. */
  query(query: Record<string, unknown>): Promise<unknown>;
  describe(): Promise<ApiCatalog>;
  /** Replace the model from project JSON. */
  load(projectJson: string): Promise<void>;
  /** Project JSON snapshot. */
  save(): Promise<string>;
  reset(): Promise<void>;
  /** Only the live backend can see pixels. */
  screenshot?(opts: { width?: number; height?: number }): Promise<Screenshot>;
  status(): Record<string, unknown>;
}

export class BackendError extends Error {}
