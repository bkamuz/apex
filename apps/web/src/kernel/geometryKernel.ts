// Selects the boolean kernel for wall openings and pumps exact-kernel jobs
// through a Web Worker. Defaults to the exact SMLib kernel; `?kernel=mesh`
// or the settings toggle (stored in localStorage) selects the mesh kernel.
import {
  apexApplyKernelResults,
  apexSetGeometryKernel,
  apexSpliceKernelJob,
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
  /** Breakdown: taking jobs, slowest worker per round, scene sink. */
  takeMs: number;
  workerMs: number;
  sinkMs: number;
  /** Wall-clock time from dispatch to results back. */
  wallMs: number;
}
export const kernelStats: KernelStats = {
  kernel: 'mesh', jobs: 0, failed: 0, lastMs: 0, rounds: 0, applyMs: 0, takeMs: 0, workerMs: 0, sinkMs: 0, wallMs: 0,
};

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

/** Run one level of ready jobs across the pool. */
async function runLevel(jobs: KernelJobDto[]): Promise<{ results: KernelResultDto[]; ms: number }> {
  // Deal jobs out largest first so the workers finish together.
  const n = Math.min(POOL, jobs.length);
  const shares: KernelJobDto[][] = Array.from({ length: n }, () => []);
  const load = new Array<number>(n).fill(0);
  for (const j of [...jobs].sort((a, b) => b.points.length - a.points.length)) {
    const i = load.indexOf(Math.min(...load));
    shares[i].push(j);
    load[i] += j.points.length;
  }
  const parts = await Promise.all(shares.map((s, i) => runOn(workerAt(i), s)));
  return { results: parts.flatMap((p) => p.results), ms: Math.max(...parts.map((p) => p.ms)) };
}

/**
 * Run a batch, resolving chains (roof -> attached walls -> joins) here: a
 * job whose operands stood in for other jobs runs once those finish, with
 * their results spliced in. Returns all results and the stale (chained) keys
 * so the core applies everything in one pass.
 */
async function runChain(jobs: KernelJobDto[]): Promise<{ results: KernelResultDto[]; stale: string[]; ms: number }> {
  const done = new Map<string, KernelResultDto>();
  const results: KernelResultDto[] = [];
  const stale: string[] = [];
  let ms = 0;
  let todo = jobs;
  while (todo.length) {
    const ready: { job: KernelJobDto; orig?: string }[] = [];
    const wait: KernelJobDto[] = [];
    for (const j of todo) {
      const deps = j.deps ?? [];
      if (!deps.every(([, k]) => done.has(k))) {
        wait.push(j);
        continue;
      }
      if (deps.length === 0) {
        ready.push({ job: j });
        continue;
      }
      let job: KernelJobDto | null = j;
      for (const [i, k] of deps) {
        const r = done.get(k)!;
        if (!job || !r.points || !r.tris) {
          job = null;
          break;
        }
        try {
          job = apexSpliceKernelJob({ ...job, deps: [] }, i, r.points, r.tris);
        } catch {
          job = null;
        }
      }
      stale.push(j.key);
      if (job) ready.push({ job, orig: j.key });
      else done.set(j.key, { key: j.key });
    }
    if (ready.length === 0) {
      stale.push(...wait.map((j) => j.key));
      break;
    }
    const level = await runLevel(ready.map((r) => r.job));
    ms += level.ms;
    const byKey = new Map(level.results.map((r) => [r.key, r]));
    for (const r of ready) {
      const res = byKey.get(r.job.key) ?? { key: r.job.key };
      done.set(r.orig ?? r.job.key, res);
      results.push(toShapeFrame(r.job, res));
    }
    todo = wait;
  }
  return { results, stale, ms };
}

/**
 * Results are cached per shape (see the core's `to_shape_frame`): move a
 * model-space result by minus its input's min corner.
 */
function toShapeFrame(job: KernelJobDto, r: KernelResultDto): KernelResultDto {
  if (!r.points) return r;
  const m = [Infinity, Infinity, Infinity];
  const p = job.points;
  for (let i = 0; i < p.length; i += 3) {
    for (let a = 0; a < 3; a++) if (p[i + a] < m[a]) m[a] = p[i + a];
  }
  if (!Number.isFinite(m[0])) return r;
  const out = Float64Array.from(r.points as ArrayLike<number>);
  for (let i = 0; i < out.length; i += 3) for (let a = 0; a < 3; a++) out[i + a] -= m[a];
  return { ...r, points: Array.from(out) };
}

/** Send queued jobs to the workers. Call after every scene update. */
export function pumpKernelJobs() {
  if (current !== 'smlib' || inFlight) return;
  const tt = performance.now();
  const jobs = apexTakeKernelJobs();
  kernelStats.takeMs += performance.now() - tt;
  if (jobs.length === 0) return;
  inFlight = true;
  const t0 = performance.now();
  void runChain(jobs).then(({ results, stale, ms }) => {
    inFlight = false;
    kernelStats.jobs += results.length;
    kernelStats.failed += results.filter((r) => !r.points).length;
    kernelStats.lastMs = performance.now() - t0;
    kernelStats.wallMs += kernelStats.lastMs;
    kernelStats.rounds += 1;
    kernelStats.workerMs += ms;
    if (current !== 'smlib') return;
    const t1 = performance.now();
    const scene = apexApplyKernelResults(results, stale);
    kernelStats.applyMs += performance.now() - t1;
    // Anything the chain could not resolve starts right away; the view
    // shows the scene once nothing is left in flight.
    pumpKernelJobs();
    if (inFlight) return;
    const t2 = performance.now();
    onScene?.(scene);
    kernelStats.sinkMs += performance.now() - t2;
  });
}
