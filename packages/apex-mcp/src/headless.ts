import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { type ApiCatalog, type Backend, BackendError } from './backend.js';

interface WasmModule {
  initSync(arg: { module: Buffer }): unknown;
  initApp(): void;
  executeCommand(json: string): string;
  runQuery(json: string): string;
  describeApi(): string;
  exportProject(): string;
  importProject(json: string): unknown;
  newProject(): unknown;
}

/** Locate the wasm-pack output (`apps/web/src/wasm/pkg`) or `APEX_WASM_PKG`. */
export function findWasmPkg(): string {
  const fromEnv = process.env.APEX_WASM_PKG;
  if (fromEnv) return resolve(fromEnv);
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    resolve(here, '../../../apps/web/src/wasm/pkg'),
    resolve(here, '../wasm'),
  ]) {
    if (existsSync(resolve(candidate, 'apex_wasm_bg.wasm'))) return candidate;
  }
  throw new BackendError(
    'apex wasm pkg not found; run `npm run wasm:build` at the repo root or set APEX_WASM_PKG',
  );
}

const asError = (e: unknown) => new BackendError(typeof e === 'string' ? e : e instanceof Error ? e.message : String(e));

/** The Rust core compiled to WASM, running in this Node process. No browser. */
export class HeadlessBackend implements Backend {
  readonly kind = 'headless' as const;
  private constructor(private readonly wasm: WasmModule, private readonly pkg: string) {}

  static async create(pkgDir = findWasmPkg()): Promise<HeadlessBackend> {
    const wasm = (await import(pathToFileURL(resolve(pkgDir, 'apex_wasm.js')).href)) as WasmModule;
    wasm.initSync({ module: readFileSync(resolve(pkgDir, 'apex_wasm_bg.wasm')) });
    wasm.initApp();
    return new HeadlessBackend(wasm, pkgDir);
  }

  private call<T>(fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      throw asError(e);
    }
  }

  async execute(command: Record<string, unknown>) {
    return JSON.parse(this.call(() => this.wasm.executeCommand(JSON.stringify(command))));
  }
  async query(query: Record<string, unknown>) {
    return JSON.parse(this.call(() => this.wasm.runQuery(JSON.stringify(query))));
  }
  async describe(): Promise<ApiCatalog> {
    return JSON.parse(this.call(() => this.wasm.describeApi()));
  }
  async load(projectJson: string) {
    this.call(() => this.wasm.importProject(projectJson));
  }
  async save() {
    return this.call(() => this.wasm.exportProject());
  }
  async reset() {
    this.call(() => this.wasm.newProject());
  }
  status() {
    return { backend: 'headless', wasm_pkg: this.pkg };
  }
}
