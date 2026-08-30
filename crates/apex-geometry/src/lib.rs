//! Geometry kernel: the primitives every Apex component is built from.
//!
//! One convention throughout: a [`Profile`] lives in the local XY plane of a
//! [`Frame`], and solids are produced by advancing that profile along local Z
//! ([`extrude`]) or along a [`Curve`] ([`sweep`]).
//!
//! This crate knows nothing about walls, levels or documents.

mod curve;
mod error;
mod frame;
mod mesh;
mod profile;
mod sweep;

pub use curve::{Curve, MIN_CURVE_LENGTH};
pub use error::GeometryError;
pub use frame::Frame;
pub use mesh::TriangleMesh;
pub use profile::{Justification, Point2, Profile};
pub use sweep::{extrude, sweep, SweepOptions};
