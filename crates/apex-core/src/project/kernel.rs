//! Boolean kernel selection for host cuts (walls and their openings).
//!
//! The default [`MeshKernel`] keeps the established mesh-boolean path. An
//! exact kernel is plugged in with [`Project::set_kernel`]: natively the
//! synchronous `apex-smlib` kernel, in the browser an [`ExternalKernel`]
//! whose jobs run in a Web Worker and come back through
//! [`Project::apply_kernel_results`]. Until a result arrives (or when the
//! exact kernel rejects an input) the mesh path is used.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};

use apex_geometry::{
    mesh_from_indexed, BooleanOp, GeometryKernel, KernelError, MeshKernel, PlanarSolids,
    TriangleMesh,
};

use super::Project;
use crate::element::ElementId;

/// Kernel results kept for reuse; older entries are dropped past this.
const CACHE_LIMIT: usize = 1024;

/// `(points, triangles)` from the kernel.
type Indexed = (Vec<f64>, Vec<i32>);

/// A kernel computed elsewhere: requests become jobs, results are cached by
/// shape up to placement ([`PlanarSolids::shape_key`]), so identical
/// instances share one run. Jobs run in model coordinates; results are
/// reported and cached in the shape frame (minus the input's min corner,
/// see [`to_shape_frame`]) and placed back at each use.
#[derive(Default)]
pub struct ExternalKernel {
    /// Shape key -> result in the shape frame (`None`: the kernel failed).
    cache: Mutex<HashMap<u64, Option<Indexed>>>,
    /// Exact input key -> placed mesh, so rebuilds skip placing again.
    placed: Mutex<HashMap<u64, TriangleMesh>>,
    jobs: Mutex<BTreeMap<u64, QueuedJob>>,
}

type QueuedJob = (PlanarSolids, Vec<(usize, u64)>);

/// A model-space result of running `solids`, moved into the shape frame.
pub fn to_shape_frame(solids: &PlanarSolids, r: Indexed) -> Indexed {
    let m = solids.min_corner();
    let (mut p, t) = r;
    for c in p.as_chunks_mut::<3>().0 {
        for i in 0..3 {
            c[i] -= m[i];
        }
    }
    (p, t)
}

/// A finished job: its key and `(points, triangles)`, or `None` on failure.
pub type KernelResult = (u64, Option<(Vec<f64>, Vec<i32>)>);

/// One queued kernel job.
#[derive(Debug, Clone)]
pub struct KernelJob {
    pub key: u64,
    pub solids: PlanarSolids,
    /// `(solid index, job key)`: that solid is a provisional stand-in for
    /// another job of the same batch. Splice that job's result in
    /// ([`PlanarSolids::splice_indexed`]) and run the spliced input; report
    /// it under the spliced key and this key as stale (see
    /// [`Project::apply_kernel_results_chained`]).
    pub deps: Vec<(usize, u64)>,
}

impl ExternalKernel {
    pub fn new() -> Self {
        Self::default()
    }

    /// Queued jobs, removed from the queue.
    pub fn take_jobs(&self) -> Vec<KernelJob> {
        std::mem::take(&mut *self.jobs.lock().unwrap())
            .into_iter()
            .map(|(key, (solids, deps))| KernelJob { key, solids, deps })
            .collect()
    }

    /// Store a result. `None` records a failure so the mesh path is kept.
    pub fn fulfil(&self, key: u64, result: Option<Indexed>) {
        let mut cache = self.cache.lock().unwrap();
        if cache.len() >= CACHE_LIMIT {
            cache.clear();
            self.placed.lock().unwrap().clear();
        }
        cache.insert(key, result);
    }
}

impl GeometryKernel for ExternalKernel {
    fn name(&self) -> &'static str {
        "smlib-external"
    }

    fn combine(
        &self,
        base: &TriangleMesh,
        tools: &[(BooleanOp, &TriangleMesh)],
    ) -> Result<TriangleMesh, KernelError> {
        let solids = PlanarSolids::encode(base, tools)?;
        let exact = solids.key();
        if let Some(m) = self.placed.lock().unwrap().get(&exact) {
            return Ok(m.clone());
        }
        let offset = solids.min_corner();
        let key = solids.shape_key();
        match self.cache.lock().unwrap().get(&key) {
            Some(Some((p, t))) => {
                let p: Vec<f64> = p
                    .as_chunks::<3>()
                    .0
                    .iter()
                    .flat_map(|c| [c[0] + offset[0], c[1] + offset[1], c[2] + offset[2]])
                    .collect();
                let mesh = mesh_from_indexed(&p, t);
                let mut placed = self.placed.lock().unwrap();
                if placed.len() >= CACHE_LIMIT {
                    placed.clear();
                }
                placed.insert(exact, mesh.clone());
                return Ok(mesh);
            }
            Some(None) => return Err(KernelError::Failed("rejected earlier".into())),
            None => {}
        }
        let deps: Vec<(usize, u64)> = std::iter::once(base)
            .chain(tools.iter().map(|(_, m)| *m))
            .enumerate()
            .filter_map(|(i, m)| crate::kroute::standin_for(m).map(|k| (i, k)))
            .filter(|&(_, k)| k != key)
            .collect();
        self.jobs.lock().unwrap().insert(key, (solids, deps));
        Err(KernelError::Pending(key))
    }
}

/// The project's kernel plus bookkeeping for asynchronous results.
pub(crate) struct KernelSlot {
    pub(crate) kernel: Arc<dyn GeometryKernel>,
    pub(crate) external: Option<Arc<ExternalKernel>>,
    /// Pending job key -> elements waiting for it.
    pub(crate) waiting: Mutex<HashMap<u64, Vec<ElementId>>>,
}

impl Default for KernelSlot {
    fn default() -> Self {
        Self {
            kernel: Arc::new(MeshKernel),
            external: None,
            waiting: Mutex::default(),
        }
    }
}

/// Counters for the kernel status line and parity checks.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
pub struct KernelStatus {
    pub kernel: String,
    pub pending: usize,
}

/// Run a batch of jobs, resolving chains in the batch: a job whose deps all
/// succeeded runs with their results spliced in. Returns results (under the
/// spliced keys) and the stale keys of chained jobs, for
/// [`Project::apply_kernel_results_chained`].
pub fn run_job_chain(
    jobs: Vec<KernelJob>,
    mut run: impl FnMut(&PlanarSolids) -> Option<Indexed>,
) -> (Vec<KernelResult>, Vec<u64>) {
    // Job key -> model-space result (dependents splice it in as is).
    let mut done: HashMap<u64, Option<Indexed>> = HashMap::new();
    let mut results = Vec::new();
    let mut stale = Vec::new();
    let mut todo = jobs;
    while !todo.is_empty() {
        let (ready, wait): (Vec<_>, Vec<_>) = todo
            .into_iter()
            .partition(|j| j.deps.iter().all(|(_, k)| done.contains_key(k)));
        if ready.is_empty() {
            // Dependencies outside the batch (or a cycle): retry later.
            stale.extend(wait.iter().map(|j| j.key));
            break;
        }
        for j in ready {
            let spliced = if j.deps.is_empty() {
                Some(j.solids.clone())
            } else {
                stale.push(j.key);
                j.deps.iter().try_fold(j.solids.clone(), |s, &(i, k)| {
                    let (p, t) = done.get(&k)?.as_ref()?;
                    s.splice_indexed(i, p, t).ok()
                })
            };
            let Some(solids) = spliced else {
                done.insert(j.key, None);
                continue;
            };
            let key = if j.deps.is_empty() {
                j.key
            } else {
                solids.shape_key()
            };
            let r = run(&solids);
            done.insert(j.key, r.clone());
            results.push((key, r.map(|r| to_shape_frame(&solids, r))));
        }
        todo = wait;
    }
    (results, stale)
}

impl Project {
    /// Use `kernel` for host cuts and rebuild every affected element.
    pub fn set_kernel(&mut self, kernel: Arc<dyn GeometryKernel>) {
        self.kernel = KernelSlot {
            kernel,
            external: None,
            waiting: Mutex::default(),
        };
        self.refresh_hosts();
    }

    /// Use a worker-backed exact kernel (browser).
    pub fn set_external_kernel(&mut self) -> Arc<ExternalKernel> {
        let ext = Arc::new(ExternalKernel::new());
        self.kernel = KernelSlot {
            kernel: ext.clone(),
            external: Some(ext.clone()),
            waiting: Mutex::default(),
        };
        self.refresh_hosts();
        ext
    }

    /// Back to the mesh kernel.
    pub fn reset_kernel(&mut self) {
        self.set_kernel(Arc::new(MeshKernel));
    }

    pub fn kernel_name(&self) -> &'static str {
        self.kernel.kernel.name()
    }

    pub fn kernel_status(&self) -> KernelStatus {
        KernelStatus {
            kernel: self.kernel_name().into(),
            pending: self.kernel.waiting.lock().unwrap().len(),
        }
    }

    /// Jobs queued for the external kernel.
    pub fn take_kernel_jobs(&self) -> Vec<KernelJob> {
        crate::kroute::clear_standins();
        self.kernel
            .external
            .as_ref()
            .map(|e| e.take_jobs())
            .unwrap_or_default()
    }

    /// Results from the external kernel: `(key, Some((points, tris)))`, or
    /// `None` when it failed. Rebuilds the waiting elements; returns them.
    pub fn apply_kernel_results(&mut self, results: Vec<KernelResult>) -> Vec<ElementId> {
        self.apply_kernel_results_chained(results, Vec::new())
    }

    /// [`Self::apply_kernel_results`] plus `stale` job keys: chained jobs
    /// whose input was a stand-in. Their elements rebuild (now finding the
    /// spliced results cached) without caching anything under those keys.
    pub fn apply_kernel_results_chained(
        &mut self,
        results: Vec<KernelResult>,
        stale: Vec<u64>,
    ) -> Vec<ElementId> {
        self.memo.enter();
        let out = self.apply_kernel_results_unscoped(results, stale);
        self.memo.leave();
        out
    }

    fn apply_kernel_results_unscoped(
        &mut self,
        results: Vec<KernelResult>,
        stale: Vec<u64>,
    ) -> Vec<ElementId> {
        let Some(ext) = self.kernel.external.clone() else {
            return Vec::new();
        };
        let mut ids = Vec::new();
        for (key, r) in results {
            ext.fulfil(key, r);
            if let Some(w) = self.kernel.waiting.lock().unwrap().remove(&key) {
                ids.extend(w);
            }
        }
        for key in stale {
            if let Some(w) = self.kernel.waiting.lock().unwrap().remove(&key) {
                ids.extend(w);
            }
        }
        ids.sort();
        ids.dedup();
        let mut all = ids.clone();
        for id in &ids {
            if let Some(e) = self.document.get_element(*id).cloned() {
                all.extend(self.neighbour_cut_dependents(&e));
            }
        }
        all.sort();
        all.dedup();
        if !all.is_empty() {
            self.refresh_meshes(all);
        }
        ids
    }

    /// Elements waiting on external kernel results (diagnostics).
    pub fn kernel_waiting_ids(&self) -> Vec<ElementId> {
        let mut ids: Vec<ElementId> = self
            .kernel
            .waiting
            .lock()
            .unwrap()
            .values()
            .flatten()
            .copied()
            .collect();
        ids.sort();
        ids.dedup();
        ids
    }

    pub(crate) fn exact_kernel_selected(&self) -> bool {
        self.kernel.kernel.name() != MeshKernel.name()
    }

    /// Host cuts through the selected kernel; `None` means use the mesh path.
    pub(crate) fn kernel_host_cuts(
        &self,
        id: ElementId,
        base: &TriangleMesh,
        cuts: &[TriangleMesh],
    ) -> Option<TriangleMesh> {
        if cuts.is_empty() || !self.exact_kernel_selected() {
            return None;
        }
        let refs: Vec<&TriangleMesh> = cuts.iter().collect();
        match self.kernel.kernel.subtract_all(base, &refs) {
            Ok(mesh) if !mesh.is_empty() => Some(mesh),
            Ok(_) => None,
            Err(KernelError::Pending(key)) => {
                self.kernel
                    .waiting
                    .lock()
                    .unwrap()
                    .entry(key)
                    .or_default()
                    .push(id);
                None
            }
            Err(_) => None,
        }
    }

    /// Rebuild every element: the kernel routes every boolean and body.
    fn refresh_hosts(&mut self) {
        let all: Vec<ElementId> = self.document.elements().map(|e| e.id).collect();
        self.refresh_meshes(all);
    }
}
