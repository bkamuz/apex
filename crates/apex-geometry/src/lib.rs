//! Geometry generators.
//!
//! Wall solids are built as extruded rectangular profiles (glam).
//! A full CSG kernel (csgrs) is planned once a stable WASM-friendly release
//! is available on crates.io; the `generate_wall_mesh` API stays stable.

mod wall;

pub use wall::{generate_wall_mesh, WallMeshError};
