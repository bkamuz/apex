// Selects the boolean kernel for wall openings and pumps exact-kernel jobs
// through a Web Worker. Defaults to the exact SMLib kernel; `?kernel=mesh`
// or the settings toggle (stored in localStorage) selects the mesh kernel.
import {
  apexApplyKernelResults,
  apexSetGeometryKernel,
  apexTakeKernelJobs,
  type GeometryKernelName,
  type KernelJobDto,
  type KernelResultDto,
} from '../wasm/apex';
import type { SceneDto } from '../types';

const STORAGE_KEY = 'apex.geometryKernel';

export function preferredKernel(): GeometryKernelName {
  const q = new URLSearchParams(location.search).get('kernel');
  if (q === 'smlib' || q === 'mesh') return q;
  try {
    return localStorage.getItem(STORAGE_KEY) === 'mesh' ? 'mesh' : 'smlib';
  } catch {
    return 'smlib';
  }
}

let current: GeometryKernelName = 'mesh';
let inFlight = false;
let nextId = 1;
let onScene: ((scene: SceneDto) => void) | null = null;

export interface KernelStats {
  kernel: GeometryKernelName;
  jobs: number;
  failed: number;
  lastMs: number;
  /** Worker round trips and main-thread time applying their results. */
  rounds: number;
  applyMs: number;
}
export const kernelStats: KernelStats = { kernel: 'mesh', jobs: 0, failed: 0, lastMs: 0, rounds: 0, applyMs: 0 };

export function currentKernel(): GeometryKernelName {
  return current;
}

/** Switch kernels; returns the rebuilt scene. `persist` stores the choice. */
export function selectKernel(name: GeometryKernelName, persist = false): SceneDto {
  current = name;
  kernelStats.kernel = name;
  if (persist) {
    try {
      localStorage.setItem(STORAGE_KEY, name);
    } catch {
      /* private mode */
    }
  }
  const scene = apexSetGeometryKernel(name);
  pumpKernelJobs();
  return scene;
}

/** Where updated scenes go once worker results are applied. */
export function setKernelSceneSink(sink: (scene: SceneDto) => void) {
  onScene = sink;
}

/** Workers that run exact-kernel jobs; a round is split across them. */
const POOL = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
const workers: Worker[] = [];

function workerAt(i: number): Worker {
  workers[i] ??= new Worker(new URL('./smlib.worker.ts', import.meta.url), { type: 'module' });
  return workers[i];
}

function runOn(w: Worker, jobs: KernelJobDto[]): Promise<{ results: KernelResultDto[]; ms: number }> {
  const id = nextId++;
  return new Promise((resolve) => {
    const done = (ev: MessageEvent<{ id: number; results: KernelResultDto[]; ms: number }>) => {
      if (ev.data.id !== id) return;
      w.removeEventListener('message', done);
      resolve(ev.data);
    };
    w.addEventListener('message', done);
    w.postMessage({ id, jobs });
  });
}

/** Send queued jobs to the workers. Call after every scene update. */
export function pumpKernelJobs() {
  if (current !== 'smlib' || inFlight) return;
  const jobs = apexTakeKernelJobs();
  if (jobs.length === 0) return;
  inFlight = true;
  // Deal jobs out largest first so the workers finish together.
  const n = Math.min(POOL, jobs.length);
  const shares: KernelJobDto[][] = Array.from({ length: n }, () => []);
  const load = new Array<number>(n).fill(0);
  for (const j of [...jobs].sort((a, b) => b.points.length - a.points.length)) {
    const i = load.indexOf(Math.min(...load));
    shares[i].push(j);
    load[i] += j.points.length;
  }
  const t0 = performance.now();
  void Promise.all(shares.map((s, i) => runOn(workerAt(i), s))).then((parts) => {
    inFlight = false;
    const results = parts.flatMap((p) => p.results);
    kernelStats.jobs += results.length;
    kernelStats.failed += results.filter((r) => !r.points).length;
    kernelStats.lastMs = performance.now() - t0;
    kernelStats.rounds += 1;
    if (current !== 'smlib') return;
    const t1 = performance.now();
    const scene = apexApplyKernelResults(results);
    kernelStats.applyMs += performance.now() - t1;
    onScene?.(scene);
    pumpKernelJobs();
  });
}
