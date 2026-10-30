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

/// Result-driven rebuilds per element before it keeps its mesh-path body.
/// Chained exact booleans whose inputs depend on other exact results (joined
/// attached walls) can otherwise feed back forever, because SMLib's
/// tessellation is not bitwise stable.
const MAX_RESULT_ROUNDS: u32 = 6;

/// A kernel computed elsewhere: requests become jobs, results are cached by
/// the exact encoded input.
#[derive(Default)]
pub struct ExternalKernel {
    cache: Mutex<HashMap<u64, Option<TriangleMesh>>>,
    jobs: Mutex<BTreeMap<u64, PlanarSolids>>,
}

/// A finished job: its key and `(points, triangles)`, or `None` on failure.
pub type KernelResult = (u64, Option<(Vec<f64>, Vec<i32>)>);

/// One queued kernel job.
#[derive(Debug, Clone)]
pub struct KernelJob {
    pub key: u64,
    pub solids: PlanarSolids,
}

impl ExternalKernel {
    pub fn new() -> Self {
        Self::default()
    }

    /// Queued jobs, removed from the queue.
    pub fn take_jobs(&self) -> Vec<KernelJob> {
        std::mem::take(&mut *self.jobs.lock().unwrap())
            .into_iter()
            .map(|(key, solids)| KernelJob { key, solids })
            .collect()
    }

    /// Store a result. `None` records a failure so the mesh path is kept.
    pub fn fulfil(&self, key: u64, mesh: Option<TriangleMesh>) {
        let mut cache = self.cache.lock().unwrap();
        if cache.len() >= CACHE_LIMIT {
            cache.clear();
        }
        cache.insert(key, mesh);
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
        let key = solids.key();
        match self.cache.lock().unwrap().get(&key) {
            Some(Some(mesh)) => return Ok(mesh.clone()),
            Some(None) => return Err(KernelError::Failed("rejected earlier".into())),
            None => {}
        }
        self.jobs.lock().unwrap().insert(key, solids);
        Err(KernelError::Pending(key))
    }
}

/// The project's kernel plus bookkeeping for asynchronous results.
pub(crate) struct KernelSlot {
    pub(crate) kernel: Arc<dyn GeometryKernel>,
    pub(crate) external: Option<Arc<ExternalKernel>>,
    /// Pending job key -> elements waiting for it.
    pub(crate) waiting: Mutex<HashMap<u64, Vec<ElementId>>>,
    /// Result-driven rebuild count per element since the kernel settled.
    pub(crate) rounds: Mutex<HashMap<ElementId, u32>>,
}

impl Default for KernelSlot {
    fn default() -> Self {
        Self {
            kernel: Arc::new(MeshKernel),
            external: None,
            waiting: Mutex::default(),
            rounds: Mutex::default(),
        }
    }
}

/// Counters for the kernel status line and parity checks.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
pub struct KernelStatus {
    pub kernel: String,
    pub pending: usize,
}

impl Project {
    /// Use `kernel` for host cuts and rebuild every affected element.
    pub fn set_kernel(&mut self, kernel: Arc<dyn GeometryKernel>) {
        self.kernel = KernelSlot {
            kernel,
            external: None,
            waiting: Mutex::default(),
            rounds: Mutex::default(),
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
            rounds: Mutex::default(),
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
        self.kernel
            .external
            .as_ref()
            .map(|e| e.take_jobs())
            .unwrap_or_default()
    }

    /// Results from the external kernel: `(key, Some((points, tris)))`, or
    /// `None` when it failed. Rebuilds the waiting elements; returns them.
    pub fn apply_kernel_results(&mut self, results: Vec<KernelResult>) -> Vec<ElementId> {
        let Some(ext) = self.kernel.external.clone() else {
            return Vec::new();
        };
        let mut ids = Vec::new();
        for (key, r) in results {
            ext.fulfil(key, r.map(|(p, t)| mesh_from_indexed(&p, &t)));
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
        {
            let mut rounds = self.kernel.rounds.lock().unwrap();
            all.retain(|id| {
                let n = rounds.entry(*id).or_insert(0);
                *n += 1;
                *n <= MAX_RESULT_ROUNDS
            });
        }
        if !all.is_empty() {
            self.refresh_meshes(all);
        }
        {
            let mut waiting = self.kernel.waiting.lock().unwrap();
            let rounds = self.kernel.rounds.lock().unwrap();
            waiting.retain(|_, ids| {
                ids.retain(|id| rounds.get(id).is_none_or(|n| *n < MAX_RESULT_ROUNDS));
                !ids.is_empty()
            });
            if waiting.is_empty() {
                drop(rounds);
                self.kernel.rounds.lock().unwrap().clear();
            }
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
