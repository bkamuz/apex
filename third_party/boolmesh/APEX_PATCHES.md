# boolmesh 0.2.1 — vendored with determinism patches

Upstream: https://github.com/komietty/boolmesh (MPL-2.0, see LICENSE).
Wired in through `[patch.crates-io]` in the root `Cargo.toml`.

Apex needs byte-identical meshes on every run. Changes from upstream:

- `manifold/mod.rs`, `boolean45/mod.rs`, `simplification/dedup.rs`,
  `values.rs`: `std::collections::HashMap` (random seed, iterated) replaced
  by `BTreeMap`.
- `triangulation/ear_clip.rs`: the ear queue broke cost ties by `Rc`
  address (heap layout, differs per call); now by a creation serial (`uid`).
- `src/lib.rs`: `#![allow(warnings)]` so workspace lints stay clean.
