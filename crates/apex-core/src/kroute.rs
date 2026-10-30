//! Kernel routing for every boolean an element build performs.
//!
//! While a project builds an element with an exact kernel selected, the
//! kernel is installed here (thread local). [`kbool`] then routes each
//! boolean (roof eaves, genus self cuts, attach trims, slab openings, join
//! clusters, boolean elements) through it, and [`solidify`] re-stitches
//! finished bodies as single exact solids. Any kernel error, or a result
//! still pending in a worker, falls back to the mesh boolean; pending keys
//! are collected so the project rebuilds the element when they arrive.

use std::cell::RefCell;
use std::sync::Arc;

use apex_geometry::{
    is_watertight, mesh_boolean, BooleanOp, CsgError, GeometryKernel, KernelError, TriangleMesh,
};

thread_local! {
    static ACTIVE: RefCell<Option<Arc<dyn GeometryKernel>>> = const { RefCell::new(None) };
    static PENDING: RefCell<Vec<u64>> = const { RefCell::new(Vec::new()) };
    static MISSES: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

/// Pending results met on this thread so far. A value built while it moved
/// is provisional and must not be memoized.
pub(crate) fn pending_misses() -> u64 {
    MISSES.with(|m| m.get())
}

/// Run `f` with `kernel` routing booleans. Nested calls keep the outer
/// kernel. Returns `f`'s value and the job keys still pending.
pub(crate) fn with_kernel<T>(
    kernel: Arc<dyn GeometryKernel>,
    f: impl FnOnce() -> T,
) -> (T, Vec<u64>) {
    if active() {
        return (f(), Vec::new());
    }
    ACTIVE.with(|a| *a.borrow_mut() = Some(kernel));
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            ACTIVE.with(|a| *a.borrow_mut() = None);
        }
    }
    let _reset = Reset;
    let out = f();
    let keys = PENDING.with(|p| std::mem::take(&mut *p.borrow_mut()));
    (out, keys)
}

/// An exact kernel is routing booleans on this thread.
pub(crate) fn active() -> bool {
    ACTIVE.with(|a| a.borrow().is_some())
}

/// The exact kernel's result, or `None` (not active, rejected, pending).
pub(crate) fn kcombine(
    base: &TriangleMesh,
    tools: &[(BooleanOp, &TriangleMesh)],
) -> Option<TriangleMesh> {
    let kernel = ACTIVE.with(|a| a.borrow().clone())?;
    match kernel.combine(base, tools) {
        Ok(m) if !m.is_empty() => Some(m),
        Ok(_) => None,
        Err(KernelError::Pending(key)) => {
            MISSES.with(|m| m.set(m.get() + 1));
            PENDING.with(|p| p.borrow_mut().push(key));
            None
        }
        Err(_) => None,
    }
}

/// A boolean through the active exact kernel, else the mesh boolean.
pub(crate) fn kbool(
    a: &TriangleMesh,
    b: &TriangleMesh,
    op: BooleanOp,
) -> Result<TriangleMesh, CsgError> {
    if active() && !a.is_empty() && !b.is_empty() {
        if let Some(m) = kcombine(a, &[(op, b)]) {
            return Ok(m);
        }
    }
    mesh_boolean(a, b, op)
}

/// Union `parts` into one exact solid; `None` keeps the parts as they are.
pub(crate) fn union_parts(parts: &[&TriangleMesh]) -> Option<TriangleMesh> {
    let (first, rest) = parts.split_first()?;
    let tools: Vec<_> = rest.iter().map(|m| (BooleanOp::Union, *m)).collect();
    kcombine(first, &tools)
}

/// Re-stitch a finished closed body as exact solid(s): its connected shells
/// unioned through the kernel. Tagged (glass, ghost) or open meshes and
/// meshes with loose lines are left alone.
pub(crate) fn solidify(mesh: TriangleMesh) -> TriangleMesh {
    if !active() || mesh.is_empty() || !is_watertight(&mesh) {
        return mesh;
    }
    let tagged = mesh.normals.chunks(3).any(|n| {
        let l = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
        (l - 1.0).abs() > 0.01
    });
    if tagged {
        return mesh;
    }
    let shells = apex_geometry::split_shells(&mesh);
    let refs: Vec<&TriangleMesh> = shells.iter().collect();
    match union_parts(&refs) {
        Some(mut m) => {
            if m.edges.is_empty() {
                m.edges = mesh.edges.clone();
            }
            m
        }
        None => mesh,
    }
}

/// `mesh` with its triangles and feature edges in a canonical order, so an
/// exact build is bit-identical however the pieces were gathered.
pub(crate) fn canonical(mesh: TriangleMesh) -> TriangleMesh {
    type Tri = [[f32; 3]; 6];
    // `+ 0.0` folds -0.0 into 0.0.
    let v = |a: &[f32], i: usize| [a[i * 3] + 0.0, a[i * 3 + 1] + 0.0, a[i * 3 + 2] + 0.0];
    let mut tris: Vec<Tri> = mesh
        .indices
        .chunks(3)
        .map(|t| {
            let i = t.iter().map(|&k| k as usize).collect::<Vec<_>>();
            let p = [
                v(&mesh.positions, i[0]),
                v(&mesh.positions, i[1]),
                v(&mesh.positions, i[2]),
            ];
            let n = [
                v(&mesh.normals, i[0]),
                v(&mesh.normals, i[1]),
                v(&mesh.normals, i[2]),
            ];
            let m = (0..3)
                .min_by(|&a, &b| p[a].partial_cmp(&p[b]).unwrap_or(std::cmp::Ordering::Equal))
                .unwrap_or(0);
            let r = |k: usize| (m + k) % 3;
            [p[r(0)], p[r(1)], p[r(2)], n[r(0)], n[r(1)], n[r(2)]]
        })
        .collect();
    tris.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let mut edges: Vec<[[f32; 3]; 2]> = mesh
        .edges
        .chunks(6)
        .filter(|e| e.len() == 6)
        .map(|e| {
            let (a, b) = (v(e, 0), v(e, 1));
            if b < a {
                [b, a]
            } else {
                [a, b]
            }
        })
        .collect();
    edges.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let mut out = TriangleMesh::empty();
    for t in &tris {
        let base = out.positions.len() as u32 / 3;
        for k in 0..3 {
            out.positions.extend_from_slice(&t[k]);
            out.normals.extend_from_slice(&t[k + 3]);
        }
        out.indices.extend_from_slice(&[base, base + 1, base + 2]);
    }
    for [a, b] in &edges {
        out.edges.extend_from_slice(a);
        out.edges.extend_from_slice(b);
    }
    out
}
