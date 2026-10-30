/// <reference lib="webworker" />
// Runs exact SMLib booleans (third_party/smlib, built to wasm by
// third_party/smlib/build-wasm.sh) off the main thread.
import createSmlib from './smlib/apex_smlib.mjs';
import wasmUrl from './smlib/apex_smlib.wasm?url';
import type { KernelJobDto, KernelResultDto } from '../wasm/apex';

interface SmlibModule {
  HEAPF64: Float64Array;
  HEAP32: Int32Array;
  _malloc(bytes: number): number;
  _free(ptr: number): void;
  _apex_sm_run(pts: number, ints: number, nsolids: number, ops: number, chord: number): number;
  _apex_sm_points(): number;
  _apex_sm_npoints(): number;
  _apex_sm_tris(): number;
  _apex_sm_ntris(): number;
}

const CHORD = 1e-3;
let mod: Promise<SmlibModule> | null = null;

function load(): Promise<SmlibModule> {
  mod ??= (createSmlib as (o: object) => Promise<SmlibModule>)({
    locateFile: (p: string) => (p.endsWith('.wasm') ? wasmUrl : p),
  });
  return mod;
}

function run(m: SmlibModule, job: KernelJobDto): KernelResultDto {
  const pts = m._malloc(Math.max(8, job.points.length * 8));
  const ints = m._malloc(Math.max(4, job.ints.length * 4));
  const ops = m._malloc(Math.max(4, job.ops.length * 4));
  try {
    m.HEAPF64.set(job.points, pts >> 3);
    m.HEAP32.set(job.ints, ints >> 2);
    m.HEAP32.set(job.ops, ops >> 2);
    const status = m._apex_sm_run(pts, ints, job.solids, ops, CHORD);
    if (status !== 0) return { key: job.key, error: `smlib status ${status}` };
    const np = m._apex_sm_npoints();
    const nt = m._apex_sm_ntris();
    const p = m._apex_sm_points() >> 3;
    const t = m._apex_sm_tris() >> 2;
    return {
      key: job.key,
      points: Array.from(m.HEAPF64.subarray(p, p + np * 3)),
      tris: Array.from(m.HEAP32.subarray(t, t + nt * 3)),
    };
  } catch (e) {
    return { key: job.key, error: String(e) };
  } finally {
    m._free(pts);
    m._free(ints);
    m._free(ops);
  }
}

self.onmessage = async (ev: MessageEvent<{ id: number; jobs: KernelJobDto[] }>) => {
  const { id, jobs } = ev.data;
  try {
    const m = await load();
    const t0 = performance.now();
    const results = jobs.map((j) => run(m, j));
    self.postMessage({ id, results, ms: performance.now() - t0 });
  } catch (e) {
    self.postMessage({ id, results: jobs.map((j) => ({ key: j.key, error: String(e) })), ms: 0 });
  }
};
