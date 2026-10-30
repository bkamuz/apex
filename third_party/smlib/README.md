# SMLib (vendored)

Exact B-rep booleans for Apex, from NVIDIA's open-sourced
[usd-brep](https://github.com/NVIDIA-Omniverse/usd-brep) (Apache-2.0).
See `NOTICE` for the exact source revision; `SMLib/` and `SM_API/` are
unmodified upstream files.

Apex uses one narrow entry point, `bridge/apex_smlib.cpp`:

```
int apex_sm_run(const double* pts, const int* ints, int nsolids,
                const int* ops, double chord);
```

Input is `apex_geometry::PlanarSolids` (planar faces with holes, one solid
after another; `ops[i]` combines solid `i + 1` into the accumulator:
0 union, 1 difference, 2 intersection). Each solid is built with
`CreatePlanarFacesWith3DCurves` and `SmApiStitchIntoSolid`, combined with
`SmApiBoolean` and tessellated. Status: `0` ok, `-(1+i)` solid `i` did not
stitch, `-(100+i)` boolean with solid `i` failed, `-1000` tessellation failed.

## Two builds

- **Native** (`crates/apex-smlib`, `build.rs` via the `cc` crate): used by
  cargo tests (`apex-core/tests/kernel_parity.rs`). Needs a C++17 compiler.
- **WebAssembly** (`./build-wasm.sh`, emscripten ≥ 4): writes
  `apps/web/src/kernel/smlib/apex_smlib.{mjs,wasm}`, which are **committed**
  so the web build and CI need no emsdk. Rebuild and commit both after
  touching anything here:

  ```sh
  source /path/to/emsdk/emsdk_env.sh
  third_party/smlib/build-wasm.sh      # ~5 min on 8 cores, objects in build/
  ```

The app loads the wasm in a Web Worker (`apps/web/src/kernel/smlib.worker.ts`)
only when the SMLib kernel is selected (`?kernel=smlib`).
