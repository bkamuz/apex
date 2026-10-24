//! Built-in mesh builders for recipes that are awkward as pure Sweep/Extrude.
//!
//! Registered under stable ids (`apex.stair.run`, `apex.roof.pitched`) so
//! ComponentDefinitions stay data: a Custom recipe step points at these.

use apex_geometry::{extrude, Curve, Frame, Profile, TriangleMesh};
use glam::Vec3;

use crate::component::{RecipeContext, RecipeError};

fn length_param(ctx: &RecipeContext<'_>, id: &str, default: f32) -> f32 {
    ctx.params.number(id).map(|v| v as f32).unwrap_or(default)
}

/// Straight stair run along a two-point placement.
///
/// Params: `width`, `riser` (step height), `tread` (horizontal depth). The
/// number of steps is derived from the placement length and `tread`.
pub fn stair_run(ctx: &RecipeContext<'_>) -> Result<TriangleMesh, RecipeError> {
    let curve = ctx.placement.curve().ok_or(RecipeError::NeedsCurve)?;
    let Curve::Line { a, b } = curve else {
        return Err(RecipeError::NeedsCurve);
    };
    let width = length_param(ctx, "width", 1.0);
    let riser = length_param(ctx, "riser", 0.17);
    let tread = length_param(ctx, "tread", 0.28).max(0.05);
    let run = (*b - *a).length();
    if run < 1e-4 {
        return Err(RecipeError::NeedsCurve);
    }
    let dir = (*b - *a) / run;
    let steps = ((run / tread).floor() as u32).max(1);
    let horizontal = Frame {
        origin: *a,
        x: dir,
        y: Vec3::Y.cross(dir).normalize_or_zero(),
        z: Vec3::Y,
    };
    // If Y.cross(dir) is degenerate (vertical run), pick an arbitrary side.
    let horizontal = if horizontal.y.length_squared() < 1e-8 {
        let side = if dir.dot(Vec3::X).abs() < 0.9 {
            dir.cross(Vec3::X).normalize()
        } else {
            dir.cross(Vec3::Z).normalize()
        };
        Frame {
            origin: *a,
            x: dir,
            y: side,
            z: Vec3::Y,
        }
    } else {
        Frame {
            origin: *a,
            x: dir,
            y: horizontal.y.normalize(),
            z: Vec3::Y,
        }
    };

    let mut mesh = TriangleMesh::empty();
    let half_w = width * 0.5;
    for i in 0..steps {
        let along = i as f32 * tread;
        let elev = i as f32 * riser;
        let profile = Profile::rectangle(tread, width)?;
        // Profile XY: local X = tread direction, local Y = width.
        // Remap: place tread along path X, width along side Y.
        let remapped = Profile::polygon(vec![
            [0.0, -half_w],
            [tread, -half_w],
            [tread, half_w],
            [0.0, half_w],
        ])?;
        let _ = profile;
        let base = Frame {
            origin: horizontal.origin + horizontal.x * along + Vec3::Y * elev,
            x: horizontal.x,
            y: horizontal.y,
            z: horizontal.z,
        };
        mesh.append(&extrude(&remapped, &base, riser.max(0.02))?);
    }
    Ok(mesh)
}

/// Pitched roof: ridge is the two-point placement; `width` spans each side,
/// `rise` is the ridge height above the eaves.
pub fn pitched_roof(ctx: &RecipeContext<'_>) -> Result<TriangleMesh, RecipeError> {
    let curve = ctx.placement.curve().ok_or(RecipeError::NeedsCurve)?;
    let Curve::Line { a, b } = curve else {
        return Err(RecipeError::NeedsCurve);
    };
    let width = length_param(ctx, "width", 6.0).max(0.2);
    let rise = length_param(ctx, "rise", 1.5).max(0.05);
    let thickness = length_param(ctx, "thickness", 0.15).max(0.02);
    let run = (*b - *a).length();
    if run < 1e-4 {
        return Err(RecipeError::NeedsCurve);
    }
    let dir = (*b - *a) / run;
    let mut side = Vec3::Y.cross(dir);
    if side.length_squared() < 1e-8 {
        side = Vec3::X;
    }
    let side = side.normalize();

    let half = width * 0.5;
    let ridge_a = *a + Vec3::Y * rise;
    let ridge_b = *b + Vec3::Y * rise;
    let eave_l_a = *a - side * half;
    let eave_l_b = *b - side * half;
    let eave_r_a = *a + side * half;
    let eave_r_b = *b + side * half;

    let mut mesh = TriangleMesh::empty();
    mesh.append(&slab_quad(eave_l_a, eave_l_b, ridge_b, ridge_a, thickness)?);
    mesh.append(&slab_quad(ridge_a, ridge_b, eave_r_b, eave_r_a, thickness)?);
    Ok(mesh)
}

fn slab_quad(
    a: Vec3,
    b: Vec3,
    c: Vec3,
    d: Vec3,
    thickness: f32,
) -> Result<TriangleMesh, RecipeError> {
    let mid = (a + b + c + d) * 0.25;
    let x = (b - a).normalize_or_zero();
    let raw_z = (d - a).cross(b - a);
    let z = if raw_z.length_squared() < 1e-10 {
        Vec3::Y
    } else {
        raw_z.normalize()
    };
    let y = z.cross(x).normalize_or_zero();
    let frame = Frame {
        origin: mid - z * (thickness * 0.5),
        x,
        y,
        z,
    };
    // Project corners into frame XY for an extruded quad.
    let pts = [a, b, c, d]
        .into_iter()
        .map(|p| {
            let local = p - frame.origin;
            [local.dot(frame.x), local.dot(frame.y)]
        })
        .collect::<Vec<_>>();
    let profile = Profile::polygon(pts)?;
    Ok(extrude(&profile, &frame, thickness)?)
}
