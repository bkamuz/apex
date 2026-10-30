//! Built-in mesh builders for recipes that are awkward as pure Sweep/Extrude.
//!
//! Registered under stable ids (`apex.stair.run`, `apex.roof.pitched`) so
//! ComponentDefinitions stay data: a Custom recipe step points at these.

use apex_geometry::{
    box_mesh, extrude, mesh_volume, BooleanOp, Curve, Frame, GeometryError, Profile, ShapedSurface,
    TriangleMesh, Underside,
};
use glam::Vec3;

use crate::component::{RecipeContext, RecipeError};
use crate::param::ParamMap;

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
    // With a target height (base → top level) the riser count comes from the
    // height so the last step lands exactly on the top level; the run is then
    // shared evenly. Without one, fall back to treads along the run.
    let height = length_param(ctx, "height", 0.0);
    let (steps, riser, tread) = if height > 1e-3 {
        let steps = ((height / riser.max(0.05)).round() as u32).max(1);
        (steps, height / steps as f32, run / steps as f32)
    } else {
        (((run / tread).floor() as u32).max(1), riser, tread)
    };
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

/// Pitched roof as one closed solid (see [`RoofShape`]).
pub fn pitched_roof(ctx: &RecipeContext<'_>) -> Result<TriangleMesh, RecipeError> {
    let curve = ctx.placement.curve().ok_or(RecipeError::NeedsCurve)?;
    let Curve::Line { a, b } = curve else {
        return Err(RecipeError::NeedsCurve);
    };
    let shape = RoofShape::from_params(ctx.params, *a, *b).ok_or(RecipeError::NeedsCurve)?;
    Ok(shape.solid()?)
}

/// How the roof's eave edges are cut.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EaveCut {
    /// Plumb: a vertical fascia (the default).
    Vertical,
    /// Vertical fascia as tall as the thickness, then a horizontal soffit.
    Horizontal,
    /// Square to the roof plane.
    Perpendicular,
}

/// A pitched (gable or hip) roof built on the shaped-surface machinery: the
/// top surface is a [`ShapedSurface`] over the footprint (wall rectangle plus
/// overhang) with the ridge, and for hips the hip lines, as creases. Every
/// face has the same pitch, so a vertical drop of `t / cos(pitch)` gives a
/// constant thickness `t` normal to each face and the ridge/hips are mitred
/// exactly: one watertight body, no gap or overlap.
///
/// The ridge is the two-point placement (lifted by `base_offset`); `width`
/// is the wall-to-wall span. The *underside* passes through the wall line at
/// eave height, so walls attached to the roof meet it flush.
#[derive(Debug, Clone)]
pub struct RoofShape {
    pub top: ShapedSurface,
    /// Vertical distance from top surface to underside.
    pub drop: f64,
    /// Plan corners of the outer footprint (with overhang), CCW from above.
    pub footprint: [[f64; 2]; 4],
    pub eave_cut: EaveCut,
    pub hip: bool,
    pub thickness: f64,
    /// tan(pitch).
    pub slope: f64,
    /// Height of the top surface at the outer eave line.
    pub eave_top: f64,
    /// Ridge top height.
    pub ridge_top: f64,
}

impl RoofShape {
    pub fn from_params(params: &ParamMap, a: Vec3, b: Vec3) -> Option<Self> {
        let num = |k: &str, d: f64| params.number(k).unwrap_or(d);
        let half = num("width", 8.0).max(0.2) * 0.5;
        let thickness = num("thickness", 0.15).max(0.02);
        let overhang = num("overhang", 0.0).max(0.0);
        let by_angle = params.text("slope_by") == Some("angle");
        let slope = if by_angle {
            num("pitch", 30f64.to_radians())
                .clamp(1f64.to_radians(), 75f64.to_radians())
                .tan()
        } else {
            num("rise", 1.8).max(0.05) / half
        };
        let eave_cut = match params.text("eave_cut") {
            Some("horizontal") => EaveCut::Horizontal,
            Some("perpendicular") => EaveCut::Perpendicular,
            _ => EaveCut::Vertical,
        };
        let hip = params.text("roof_type") == Some("hip");
        let lift = num("base_offset", 0.0);
        let flat = Vec3::new(b.x - a.x, 0.0, b.z - a.z);
        let run = flat.length() as f64;
        if run < 1e-4 {
            return None;
        }
        let dir = flat.normalize();
        let side = Vec3::Y.cross(dir).normalize();
        let eave = a.y as f64 + lift;
        let drop = thickness * (1.0 + slope * slope).sqrt();
        let h = half + overhang;
        let (u0, u1) = (-overhang, run + overhang);
        let eave_top = eave + drop - overhang * slope;
        let ridge_top = eave + drop + half * slope;
        let at = |u: f64, s: f64, y: f64| {
            let p = a + dir * u as f32 + side * s as f32;
            [p.x as f64, y, p.z as f64]
        };
        let corners = [(u0, -h), (u1, -h), (u1, h), (u0, h)];
        let footprint = corners.map(|(u, s)| {
            let p = at(u, s, 0.0);
            [p[0], p[2]]
        });
        let mut top;
        if hip {
            top = ShapedSurface::new(corners.iter().map(|&(u, s)| at(u, s, eave_top)).collect());
            let len = u1 - u0;
            if len > 2.0 * h + 1e-6 {
                top.interior = vec![at(u0 + h, 0.0, ridge_top), at(u1 - h, 0.0, ridge_top)];
                top.creases = vec![[4, 5], [0, 4], [3, 4], [1, 5], [2, 5]];
            } else {
                // Too short for a ridge: a pyramid.
                let apex = eave_top + len * 0.5 * slope;
                top.interior = vec![at((u0 + u1) * 0.5, 0.0, apex)];
                top.creases = vec![[0, 4], [1, 4], [2, 4], [3, 4]];
            }
        } else {
            top = ShapedSurface::new(vec![
                at(u0, -h, eave_top),
                at(u1, -h, eave_top),
                at(u1, 0.0, ridge_top),
                at(u1, h, eave_top),
                at(u0, h, eave_top),
                at(u0, 0.0, ridge_top),
            ]);
            top.creases = vec![[2, 5]];
        }
        Some(Self {
            top,
            drop,
            footprint,
            eave_cut,
            hip,
            thickness,
            slope,
            eave_top,
            ridge_top,
        })
    }

    /// The underside as a surface (top lowered by `drop`).
    pub fn underside(&self) -> ShapedSurface {
        let mut s = self.top.clone();
        for p in s.boundary.iter_mut().chain(s.interior.iter_mut()) {
            p[1] -= self.drop;
        }
        s
    }

    /// The closed roof body.
    pub fn solid(&self) -> Result<TriangleMesh, GeometryError> {
        let mut mesh = self.top.solid(Underside::Drop(self.drop))?;
        let lo = self.eave_top - self.drop - 1.0;
        let hi = self.ridge_top + 1.0;
        match self.eave_cut {
            EaveCut::Vertical => {}
            EaveCut::Horizontal => {
                let (mut mn, mut mx) = ([f64::MAX; 2], [f64::MIN; 2]);
                for p in &self.footprint {
                    mn = [mn[0].min(p[0]), mn[1].min(p[1])];
                    mx = [mx[0].max(p[0]), mx[1].max(p[1])];
                }
                let keep = box_mesh(
                    [
                        mn[0] as f32 - 1.0,
                        (self.eave_top - self.thickness) as f32,
                        mn[1] as f32 - 1.0,
                    ],
                    [mx[0] as f32 + 1.0, hi as f32, mx[1] as f32 + 1.0],
                );
                mesh = crate::kroute::kbool(&mesh, &keep, BooleanOp::Intersect).unwrap_or(mesh);
            }
            EaveCut::Perpendicular => {
                // One half-space per eave edge: the plane through the top
                // eave line, square to that face.
                let f = &self.footprint;
                let edges: Vec<usize> = if self.hip {
                    vec![0, 1, 2, 3]
                } else {
                    vec![0, 2]
                };
                let cos = 1.0 / (1.0 + self.slope * self.slope).sqrt();
                let sin = self.slope * cos;
                for k in edges {
                    let (p, q) = (f[k], f[(k + 1) % 4]);
                    let e = Vec3::new((q[0] - p[0]) as f32, 0.0, (q[1] - p[1]) as f32);
                    let len = e.length();
                    let e = e / len;
                    // Footprint is CCW from above: outward is e × Y.
                    let out = e.cross(Vec3::Y).normalize();
                    let origin =
                        Vec3::new(p[0] as f32, self.eave_top as f32, p[1] as f32) - e * 1.0;
                    // Section plane coordinates: x = out, y = up.
                    let r = ((hi - lo) + 2.0 * (len as f64)) as f32 + 10.0;
                    let m = [cos as f32, -sin as f32];
                    let d = [sin as f32, cos as f32];
                    let pts = vec![
                        [d[0] * r, d[1] * r],
                        [-d[0] * r, -d[1] * r],
                        [-d[0] * r - m[0] * r, -d[1] * r - m[1] * r],
                        [d[0] * r - m[0] * r, d[1] * r - m[1] * r],
                    ];
                    let frame = Frame {
                        origin,
                        x: out,
                        y: Vec3::Y,
                        z: out.cross(Vec3::Y),
                    };
                    let length = len + 2.0;
                    let mut frame = frame;
                    if frame.z.dot(e) < 0.0 {
                        frame.origin += e * length;
                    }
                    let Ok(profile) = Profile::polygon(pts) else {
                        continue;
                    };
                    let Ok(keep) = extrude(&profile, &frame, length) else {
                        continue;
                    };
                    let keep = if mesh_volume(&keep) < 0.0 {
                        flip(&keep)
                    } else {
                        keep
                    };
                    if let Ok(cut) = crate::kroute::kbool(&mesh, &keep, BooleanOp::Intersect) {
                        if !cut.is_empty() {
                            mesh = cut;
                        }
                    }
                }
            }
        }
        Ok(mesh)
    }
}

fn flip(m: &TriangleMesh) -> TriangleMesh {
    let mut out = m.clone();
    for t in out.indices.chunks_mut(3) {
        t.swap(1, 2);
    }
    for n in out.normals.iter_mut() {
        *n = -*n;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::param::ParamValue;
    use apex_geometry::{is_watertight, mesh_volume};

    fn params(extra: &[(&str, ParamValue)]) -> ParamMap {
        let mut p = ParamMap::new()
            .with("width", ParamValue::Length(8.0))
            .with("rise", ParamValue::Length(2.0))
            .with("thickness", ParamValue::Length(0.2));
        for (k, v) in extra {
            p = p.with(*k, v.clone());
        }
        p
    }

    fn shape(extra: &[(&str, ParamValue)]) -> RoofShape {
        RoofShape::from_params(&params(extra), Vec3::ZERO, Vec3::new(10.0, 0.0, 0.0)).unwrap()
    }

    fn choice(s: &str) -> ParamValue {
        ParamValue::Choice(s.into())
    }

    #[test]
    fn gable_roof_is_one_watertight_body_with_a_closed_ridge() {
        let s = shape(&[]);
        let m = s.solid().unwrap();
        assert!(is_watertight(&m));
        // Section × length: two slopes of hypotenuse √(4²+2²), 0.2 normal thickness.
        let expected = 10.0 * 2.0 * (16.0f64 + 4.0).sqrt() * 0.2;
        assert!(
            (mesh_volume(&m) - expected).abs() < 1e-3,
            "{}",
            mesh_volume(&m)
        );
        // Ridge: top and underside meet at the same plan line; no gap.
        let u = s.underside();
        assert!((u.height_at(5.0, 0.0).unwrap() - 2.0).abs() < 1e-6);
        assert!((u.height_at(5.0, 4.0).unwrap()).abs() < 1e-6);
        assert!((s.top.height_at(5.0, 0.0).unwrap() - 2.0 - s.drop).abs() < 1e-6);
    }

    #[test]
    fn overhang_and_pitch_by_angle() {
        let s = shape(&[
            ("slope_by", choice("angle")),
            ("pitch", ParamValue::Angle(45f64.to_radians())),
            ("overhang", ParamValue::Length(0.5)),
        ]);
        assert!(is_watertight(&s.solid().unwrap()));
        let u = s.underside();
        // 45°: underside drops 0.5 over the overhang and rises 4 to the ridge.
        assert!((u.height_at(5.0, 4.5).unwrap() + 0.5).abs() < 1e-6);
        assert!((u.height_at(5.0, 0.0).unwrap() - 4.0).abs() < 1e-6);
        assert!((u.height_at(-0.5, 0.0).unwrap() - 4.0).abs() < 1e-6);
    }

    #[test]
    fn hip_roof_has_four_planes_at_one_pitch() {
        let s = shape(&[("roof_type", choice("hip"))]);
        let m = s.solid().unwrap();
        assert!(is_watertight(&m));
        let u = s.underside();
        // End slopes match the sides: 2 m up over 4 m.
        assert!((u.height_at(2.0, 0.0).unwrap() - 1.0).abs() < 1e-6);
        assert!((u.height_at(5.0, 2.0).unwrap() - 1.0).abs() < 1e-6);
        assert!((u.height_at(5.0, 0.0).unwrap() - 2.0).abs() < 1e-6);
        // Pyramid when the footprint is too short for a ridge.
        let p = RoofShape::from_params(
            &params(&[("roof_type", choice("hip"))]),
            Vec3::ZERO,
            Vec3::new(6.0, 0.0, 0.0),
        )
        .unwrap();
        assert!(is_watertight(&p.solid().unwrap()));
    }

    #[test]
    fn eave_cuts_trim_the_eave_and_stay_closed() {
        let plumb = mesh_volume(&shape(&[]).solid().unwrap());
        for cut in ["horizontal", "perpendicular"] {
            for kind in ["gable", "hip"] {
                let s = shape(&[("eave_cut", choice(cut)), ("roof_type", choice(kind))]);
                let m = s.solid().unwrap();
                assert!(is_watertight(&m), "{cut} {kind}");
                let v = mesh_volume(&m);
                assert!(
                    v < plumb + 1e-6 && v > plumb * 0.9,
                    "{cut} {kind}: {v} vs {plumb}"
                );
            }
        }
        // Square cut: lowest point is the top eave minus t·cos(pitch).
        let s = shape(&[("eave_cut", choice("perpendicular"))]);
        let m = s.solid().unwrap();
        let low = m.positions.chunks(3).map(|p| p[1]).fold(f32::MAX, f32::min) as f64;
        let cos = 1.0 / (1.0f64 + 0.25).sqrt();
        assert!((low - (s.eave_top - 0.2 * cos)).abs() < 1e-4, "{low}");
        // Horizontal cut: fascia exactly as tall as the thickness.
        let s = shape(&[("eave_cut", choice("horizontal"))]);
        let m = s.solid().unwrap();
        let low = m.positions.chunks(3).map(|p| p[1]).fold(f32::MAX, f32::min) as f64;
        assert!((low - (s.eave_top - 0.2)).abs() < 1e-4, "{low}");
    }
}
