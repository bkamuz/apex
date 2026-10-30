//! [`SmlibKernel`]: exact BRep booleans through the vendored SMLib kernel
//! (`third_party/smlib`, Apache-2.0), linked natively. The browser runs the
//! same bridge compiled to WebAssembly inside a Web Worker.

use std::sync::Mutex;

use apex_geometry::{
    mesh_from_indexed, BooleanOp, GeometryKernel, KernelError, PlanarSolids, TriangleMesh,
};

extern "C" {
    fn apex_sm_run(
        pts: *const f64,
        ints: *const i32,
        nsolids: i32,
        ops: *const i32,
        chord: f64,
    ) -> i32;
    fn apex_sm_points() -> *const f64;
    fn apex_sm_npoints() -> i32;
    fn apex_sm_tris() -> *const i32;
    fn apex_sm_ntris() -> i32;
    fn apex_sm_volume() -> f64;
}

/// The bridge keeps its result in globals and SMLib's context is global, so
/// every call is serialised.
static LOCK: Mutex<()> = Mutex::new(());

/// Result of one kernel run.
#[derive(Debug, Clone)]
pub struct RunResult {
    pub points: Vec<f64>,
    pub tris: Vec<i32>,
    /// Exact volume of the BRep result (before tessellation).
    pub volume: f64,
}

/// Run the bridge on encoded solids.
pub fn run(solids: &PlanarSolids, chord: f64) -> Result<RunResult, KernelError> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    // SAFETY: the buffers outlive the call; the bridge copies what it needs and
    // the result pointers stay valid until the next call (we hold the lock).
    unsafe {
        let status = apex_sm_run(
            solids.points.as_ptr(),
            solids.ints.as_ptr(),
            solids.solids as i32,
            solids.ops.as_ptr(),
            chord,
        );
        if status != 0 {
            return Err(KernelError::Failed(describe(status)));
        }
        let np = apex_sm_npoints() as usize;
        let nt = apex_sm_ntris() as usize;
        let points = std::slice::from_raw_parts(apex_sm_points(), np * 3).to_vec();
        let tris = std::slice::from_raw_parts(apex_sm_tris(), nt * 3).to_vec();
        Ok(RunResult {
            points,
            tris,
            volume: apex_sm_volume(),
        })
    }
}

/// Human-readable bridge status.
pub fn describe(status: i32) -> String {
    match status {
        0 => "ok".into(),
        -1000 => "tessellation failed".into(),
        s if s <= -100 => format!("boolean with solid {} failed", -s - 100),
        s => format!("solid {} is not a closed planar polyhedron", -s - 1),
    }
}

/// The bridge's triangles in a canonical order (each rotated to start at
/// its smallest vertex, then sorted; vertices renumbered by first use), so
/// equal results are bit-identical whatever order the BRep walked faces in.
fn canonical(points: &[f64], tris: &[i32]) -> (Vec<f64>, Vec<i32>) {
    let p = |i: i32| {
        let k = i as usize * 3;
        [points[k], points[k + 1], points[k + 2]]
    };
    let key = |v: [f64; 3]| v.map(f64::to_bits);
    let lt = |a: [f64; 3], b: [f64; 3]| a.partial_cmp(&b) == Some(std::cmp::Ordering::Less);
    let mut list: Vec<[[f64; 3]; 3]> = tris
        .chunks(3)
        .map(|t| {
            let v = [p(t[0]), p(t[1]), p(t[2])];
            let m = if lt(v[1], v[0]) && !lt(v[2], v[1]) {
                1
            } else if lt(v[2], v[0]) && lt(v[2], v[1]) {
                2
            } else {
                0
            };
            [v[m], v[(m + 1) % 3], v[(m + 2) % 3]]
        })
        .collect();
    list.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let mut ids = std::collections::HashMap::new();
    let (mut out_p, mut out_t) = (Vec::new(), Vec::with_capacity(tris.len()));
    for t in &list {
        for v in t {
            let n = ids.len() as i32;
            let id = *ids.entry(key(*v)).or_insert_with(|| {
                out_p.extend_from_slice(v);
                n
            });
            out_t.push(id);
        }
    }
    (out_p, out_t)
}

/// Exact BRep boolean kernel.
#[derive(Debug, Clone, Copy)]
pub struct SmlibKernel {
    /// Chord tolerance for tessellating curved faces (planar faces are exact).
    pub chord: f64,
}

impl Default for SmlibKernel {
    fn default() -> Self {
        Self { chord: 1e-3 }
    }
}

impl GeometryKernel for SmlibKernel {
    fn name(&self) -> &'static str {
        "smlib"
    }

    fn combine(
        &self,
        base: &TriangleMesh,
        tools: &[(BooleanOp, &TriangleMesh)],
    ) -> Result<TriangleMesh, KernelError> {
        let solids = PlanarSolids::encode(base, tools)?;
        let r = run(&solids, self.chord)?;
        let (points, tris) = canonical(&r.points, &r.tris);
        Ok(mesh_from_indexed(&points, &tris))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use apex_geometry::{box_mesh, is_watertight, mesh_volume, MeshKernel};

    fn wall() -> TriangleMesh {
        box_mesh([0.0; 3], [5.0, 3.0, 0.3])
    }
    fn window() -> TriangleMesh {
        box_mesh([1.9, 0.9, -0.1], [3.1, 2.3, 0.4])
    }

    #[test]
    fn wall_minus_window_is_exact() {
        let r = run(
            &PlanarSolids::encode(&wall(), &[(BooleanOp::Subtract, &window())]).unwrap(),
            1e-3,
        )
        .unwrap();
        assert!(
            (r.volume - (4.5 - 1.2 * 1.4 * 0.3)).abs() < 1e-6,
            "{}",
            r.volume
        );
        let m = mesh_from_indexed(&r.points, &r.tris);
        assert!(is_watertight(&m));
    }

    #[test]
    fn matches_mesh_kernel_and_is_deterministic() {
        let a = SmlibKernel::default()
            .subtract_all(&wall(), &[&window()])
            .unwrap();
        let b = MeshKernel.subtract_all(&wall(), &[&window()]).unwrap();
        assert!((mesh_volume(&a) - mesh_volume(&b)).abs() < 1e-4);
        let again = SmlibKernel::default()
            .subtract_all(&wall(), &[&window()])
            .unwrap();
        assert_eq!(a.positions, again.positions);
        assert_eq!(a.indices, again.indices);
    }

    #[test]
    fn holed_input_can_be_cut_again() {
        let once = SmlibKernel::default()
            .subtract_all(&wall(), &[&window()])
            .unwrap();
        let door = box_mesh([0.4, 0.0, -0.1], [1.3, 2.1, 0.4]);
        let twice = SmlibKernel::default()
            .subtract_all(&once, &[&door])
            .unwrap();
        let expect = 4.5 - 1.2 * 1.4 * 0.3 - 0.9 * 2.1 * 0.3;
        assert!(
            (mesh_volume(&twice) - expect).abs() < 1e-4,
            "{}",
            mesh_volume(&twice)
        );
        assert!(is_watertight(&twice));
    }

    #[test]
    fn frame_ring_unions_into_one_body() {
        let (x0, x1, y0, y1, f) = (1.9f32, 3.1f32, 0.9f32, 2.3f32, 0.06f32);
        let (z0, z1) = (0.11f32, 0.19f32);
        let bars = [
            box_mesh([x0, y0, z0], [x1, y0 + f, z1]),
            box_mesh([x0, y1 - f, z0], [x1, y1, z1]),
            box_mesh([x0, y0, z0], [x0 + f, y1, z1]),
            box_mesh([x1 - f, y0, z0], [x1, y1, z1]),
        ];
        let tools: Vec<_> = bars[1..].iter().map(|b| (BooleanOp::Union, b)).collect();
        let r = run(&PlanarSolids::encode(&bars[0], &tools).unwrap(), 1e-3).unwrap();
        let ring = (1.2 * 1.4 - 1.08 * 1.28) * 0.08;
        assert!((r.volume - ring).abs() < 1e-6, "{} vs {ring}", r.volume);
    }

    #[test]
    fn rejects_open_input() {
        let mut open = wall();
        open.indices.truncate(open.indices.len() - 3);
        assert!(SmlibKernel::default()
            .subtract_all(&open, &[&window()])
            .is_err());
    }
}
