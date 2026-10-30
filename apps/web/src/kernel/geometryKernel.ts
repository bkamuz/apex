// Selects the boolean kernel for wall openings and pumps exact-kernel jobs
// through a Web Worker. Defaults to the exact SMLib kernel; `?kernel=mesh`
// or the settings toggle (stored in localStorage) selects the mesh kernel.
import {
  apexApplyKernelResults,
  apexSetGeometryKernel,
  apexTakeKernelJobs,
  type GeometryKernelName,
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
let worker: Worker | null = null;
let inFlight = false;
let nextId = 1;
let onScene: ((scene: SceneDto) => void) | null = null;

export interface KernelStats {
  kernel: GeometryKernelName;
  jobs: number;
  failed: number;
  lastMs: number;
}
export const kernelStats: KernelStats = { kernel: 'mesh', jobs: 0, failed: 0, lastMs: 0 };

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

/** Send queued jobs to the worker. Call after every scene update. */
export function pumpKernelJobs() {
  if (current !== 'smlib' || inFlight) return;
  const jobs = apexTakeKernelJobs();
  if (jobs.length === 0) return;
  worker ??= new Worker(new URL('./smlib.worker.ts', import.meta.url), { type: 'module' });
  inFlight = true;
  const id = nextId++;
  const done = (ev: MessageEvent<{ id: number; results: KernelResultDto[]; ms: number }>) => {
    if (ev.data.id !== id) return;
    worker?.removeEventListener('message', done);
    inFlight = false;
    kernelStats.jobs += ev.data.results.length;
    kernelStats.failed += ev.data.results.filter((r) => !r.points).length;
    kernelStats.lastMs = ev.data.ms;
    if (current !== 'smlib') return;
    const scene = apexApplyKernelResults(ev.data.results);
    onScene?.(scene);
    pumpKernelJobs();
  };
  worker.addEventListener('message', done);
  worker.postMessage({ id, jobs });
}
