//! Opening genera (windows, doors, any wall-hosted opening) as data.
//!
//! An [`OpeningRecipe`] on a [`crate::ComponentDefinition`] describes the
//! opening: outline (rectangle or arch), a frame profile run along the
//! outline as one closed solid, a grid of cells split by mullions/transoms,
//! each cell holding a sash with glass (and optional glazing bars) or a
//! swinging leaf, plus the plan symbol. Every dimension is an [`Expr`] over
//! the element's params, so the same recipe serves every species of a genus.
//!
//! Geometry is produced as [`OpeningGeometry`] in a local frame (`s` along
//! the wall, `y` up from the element origin, depth along the wall normal)
//! so plugins can supply their own generator (see
//! [`OpeningGenerator`]) and the core places the result in the host wall.

use apex_geometry::{
    polygon_region, region_intersect, region_subtract, region_union, triangulate_shape, Region,
    TriangleMesh,
};
use glam::Vec3;
use serde::{Deserialize, Serialize};

use crate::expr::Expr;
use crate::param::ParamMap;

/// Glass panes carry normals scaled by this so the renderer draws them in
/// its translucent pass.
pub const GLASS_NORMAL_TAG: f32 = 2.0;
/// Gap between a moving sash/leaf and the fixed frame.
pub const SASH_GAP: f64 = 0.002;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OpeningInfill {
    /// Every cell is a sash (or fixed glass when `sash_width` is 0).
    #[default]
    Glass,
    /// Bottom-row cells are hinged leaves opened 90°; upper rows are glazed.
    Leaf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OpeningPlanSymbol {
    /// Glazing lines across the wall cut.
    #[default]
    Window,
    /// Leaf line(s) with a quarter-circle swing per leaf.
    Swing,
    /// Only the jamb break.
    None,
}

fn e_param(id: &str) -> Expr {
    Expr::param(id)
}
fn d_width() -> Expr {
    e_param("width")
}
fn d_height() -> Expr {
    e_param("height")
}
fn d_sill() -> Expr {
    e_param("sill")
}
fn d_zero() -> Expr {
    Expr::zero()
}
fn d_one() -> Expr {
    Expr::constant(1.0)
}
fn d_frame() -> Expr {
    Expr::constant(0.06)
}
fn d_sash_depth() -> Expr {
    Expr::constant(0.06)
}
fn d_bar() -> Expr {
    Expr::constant(0.02)
}
fn d_leaf() -> Expr {
    Expr::constant(0.05)
}
fn d_true() -> bool {
    true
}

/// Data recipe for a wall-hosted opening. Missing fields take defaults, so
/// `{}` is a 1-cell fixed window driven by `width`/`height`/`sill` params.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OpeningRecipe {
    #[serde(default = "d_width")]
    pub width: Expr,
    #[serde(default = "d_height")]
    pub height: Expr,
    /// Bottom of the opening above the element origin (host base).
    #[serde(default = "d_sill")]
    pub sill: Expr,
    /// Arch rise above the springing line; 0 = rectangular head.
    #[serde(default = "d_zero")]
    pub arch_rise: Expr,
    /// Frame member width (face dimension).
    #[serde(default = "d_frame")]
    pub frame_width: Expr,
    /// Frame depth across the wall; `None` = full wall thickness.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frame_depth: Option<Expr>,
    /// Bottom frame member (window sill frame / door threshold).
    #[serde(default = "d_true")]
    pub threshold: bool,
    #[serde(default = "d_one")]
    pub columns: Expr,
    #[serde(default = "d_one")]
    pub rows: Expr,
    /// Width of mullions and transoms.
    #[serde(default = "d_frame")]
    pub mullion_width: Expr,
    /// Centre height of the first transom above the opening bottom; 0 = rows split evenly.
    #[serde(default = "d_zero")]
    pub transom_height: Expr,
    #[serde(default)]
    pub infill: OpeningInfill,
    /// Sash member width; 0 = fixed glazing straight in the frame.
    #[serde(default = "d_zero")]
    pub sash_width: Expr,
    #[serde(default = "d_sash_depth")]
    pub sash_depth: Expr,
    /// Vertical / horizontal glazing bars per pane.
    #[serde(default = "d_zero")]
    pub bars_x: Expr,
    #[serde(default = "d_zero")]
    pub bars_y: Expr,
    #[serde(default = "d_bar")]
    pub bar_width: Expr,
    #[serde(default = "d_leaf")]
    pub leaf_thickness: Expr,
    #[serde(default)]
    pub plan_symbol: OpeningPlanSymbol,
    /// Registered plugin generator id; when set it replaces the built-in builder.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generator: Option<String>,
}

impl Default for OpeningRecipe {
    fn default() -> Self {
        serde_json::from_str("{}").expect("defaults")
    }
}

impl OpeningRecipe {
    pub fn referenced_params(&self) -> Vec<String> {
        let mut out = Vec::new();
        for e in [
            &self.width,
            &self.height,
            &self.sill,
            &self.arch_rise,
            &self.frame_width,
            &self.columns,
            &self.rows,
            &self.mullion_width,
            &self.transom_height,
            &self.sash_width,
            &self.sash_depth,
            &self.bars_x,
            &self.bars_y,
            &self.bar_width,
            &self.leaf_thickness,
        ] {
            out.extend(e.referenced_params());
        }
        if let Some(e) = &self.frame_depth {
            out.extend(e.referenced_params());
        }
        out.sort();
        out.dedup();
        out
    }

    /// Evaluated outline box: (width, height, sill).
    pub fn extents(&self, params: &ParamMap) -> (f64, f64, f64) {
        let ev = |e: &Expr, d: f64| e.eval(params).unwrap_or(d);
        (
            ev(&self.width, 0.9).max(0.05),
            ev(&self.height, 2.1).max(0.05),
            ev(&self.sill, 0.0),
        )
    }
}

/// One prism of an opening: polygon loops in a local `(s, y)` plane
/// extruded `d0..d1` along that plane's normal. The plane sits at `origin`
/// (`[u, n]` offsets in the wall frame) rotated `angle` radians about +Y
/// (0 = the wall plane, `s` along the wall, depth along the wall normal).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OpeningPart {
    /// First loop is the outer boundary, the rest are holes.
    pub loops: Vec<Vec<[f64; 2]>>,
    #[serde(default)]
    pub origin: [f64; 2],
    #[serde(default)]
    pub angle: f64,
    pub d0: f64,
    pub d1: f64,
    #[serde(default)]
    pub glass: bool,
    /// Part of the fixed frame (vs. sash / glass / leaf infill).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub frame: bool,
}

/// Generated opening: solids plus loose plan/3D lines (`[u, y, n]` points).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct OpeningGeometry {
    pub parts: Vec<OpeningPart>,
    #[serde(default)]
    pub lines: Vec<[[f64; 3]; 2]>,
}

/// Plugin hook: produce an opening's geometry from its resolved params.
pub trait OpeningGenerator {
    fn generate(&self, params: &ParamMap, wall_depth: f64) -> Result<OpeningGeometry, String>;
}

/// Evaluated cell grid: each cell `[x0, x1, y0, y1]` (top row may be clipped by the arch).
struct Layout {
    hw: f64,
    y0: f64,
    y1: f64,
    rise: f64,
    fw: f64,
    bottom_frame: bool,
    cells: Vec<(usize, usize, [f64; 4])>,
    rows: usize,
}

const ARC_SEGMENTS: usize = 24;

impl Layout {
    /// Outline shrunk by `d` (bottom by `bottom`).
    fn outline(&self, d: f64, bottom: f64) -> Region {
        let x = self.hw - d;
        let yb = self.y0 + bottom;
        if x <= 1e-4 {
            return Region::new();
        }
        if self.rise <= 1e-4 {
            let yt = self.y1 - d;
            if yt <= yb {
                return Region::new();
            }
            return polygon_region(&[[-x, yb], [x, yb], [x, yt], [-x, yt]]);
        }
        let big_r = (self.hw * self.hw + self.rise * self.rise) / (2.0 * self.rise);
        let cy = self.y1 - big_r;
        let r = big_r - d;
        if r <= x {
            return Region::new();
        }
        let ys = cy + (r * r - x * x).sqrt();
        if ys <= yb {
            return Region::new();
        }
        let a0 = (ys - cy).atan2(x);
        let a1 = std::f64::consts::PI - a0;
        let mut pts = vec![[-x, yb], [x, yb], [x, ys]];
        for i in 1..ARC_SEGMENTS {
            let a = a0 + (a1 - a0) * i as f64 / ARC_SEGMENTS as f64;
            pts.push([a.cos() * r, cy + a.sin() * r]);
        }
        pts.push([-x, ys]);
        polygon_region(&pts)
    }

    fn cell(&self, row: usize, rect: [f64; 4], d: f64) -> Region {
        let top = if row + 1 == self.rows {
            self.y1 + 1.0
        } else {
            rect[3] - d
        };
        let r = [rect[0] + d, rect[1] - d, rect[2] + d, top];
        if r[1] <= r[0] || r[3] <= r[2] {
            return Region::new();
        }
        let rect_region = polygon_region(&[[r[0], r[2]], [r[1], r[2]], [r[1], r[3]], [r[0], r[3]]]);
        let bottom = if self.bottom_frame { self.fw + d } else { d };
        region_intersect(&rect_region, &self.outline(self.fw + d, bottom))
    }
}

fn bbox(region: &Region) -> Option<[f64; 4]> {
    let mut b = [f64::MAX, f64::MIN, f64::MAX, f64::MIN];
    let mut any = false;
    for shape in region {
        for ring in shape {
            for p in ring {
                any = true;
                b[0] = b[0].min(p[0]);
                b[1] = b[1].max(p[0]);
                b[2] = b[2].min(p[1]);
                b[3] = b[3].max(p[1]);
            }
        }
    }
    any.then_some(b)
}

/// Split `region` into panes by `bx` vertical and `by` horizontal bars of width `bw`.
fn panes(region: &Region, bx: usize, by: usize, bw: f64) -> Region {
    let Some(b) = bbox(region) else {
        return Region::new();
    };
    if bx == 0 && by == 0 {
        return region.clone();
    }
    let split = |lo: f64, hi: f64, n: usize| -> Vec<(f64, f64)> {
        let pane = (hi - lo - n as f64 * bw) / (n as f64 + 1.0);
        (0..=n)
            .map(|i| {
                let a = lo + i as f64 * (pane + bw);
                (a, a + pane)
            })
            .collect()
    };
    let mut out = Region::new();
    for (x0, x1) in split(b[0], b[1], bx) {
        for (y0, y1) in split(b[2], b[3], by) {
            if x1 - x0 < 1e-3 || y1 - y0 < 1e-3 {
                continue;
            }
            let r = polygon_region(&[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
            out = region_union(&out, &region_intersect(&r, region));
        }
    }
    out
}

fn region_parts(region: &Region, d0: f64, d1: f64, glass: bool) -> Vec<OpeningPart> {
    region_parts_of(region, d0, d1, glass, false)
}

fn region_parts_of(
    region: &Region,
    d0: f64,
    d1: f64,
    glass: bool,
    frame: bool,
) -> Vec<OpeningPart> {
    region
        .iter()
        .filter(|s| !s.is_empty())
        .map(|shape| OpeningPart {
            loops: shape.clone(),
            origin: [0.0, 0.0],
            angle: 0.0,
            d0,
            d1,
            glass,
            frame,
        })
        .collect()
}

/// Built-in data-driven opening builder.
pub fn build_opening(
    recipe: &OpeningRecipe,
    params: &ParamMap,
    wall_depth: f64,
) -> OpeningGeometry {
    let ev = |e: &Expr, d: f64| e.eval(params).unwrap_or(d);
    let (width, height, sill) = recipe.extents(params);
    let hw = width * 0.5;
    let fw = ev(&recipe.frame_width, 0.06).clamp(0.005, hw * 0.45);
    let rise = ev(&recipe.arch_rise, 0.0).clamp(0.0, hw.min(height - fw * 3.0).max(0.0));
    let half = recipe
        .frame_depth
        .as_ref()
        .map(|e| ev(e, wall_depth) * 0.5)
        .unwrap_or(wall_depth * 0.5)
        .max(0.01);
    let cols = ev(&recipe.columns, 1.0).round().clamp(1.0, 12.0) as usize;
    let rows = ev(&recipe.rows, 1.0).round().clamp(1.0, 12.0) as usize;
    let mw = ev(&recipe.mullion_width, 0.06).max(0.005);
    let y0 = sill;
    let y1 = sill + height;
    let xi = hw - fw;
    let yb = if recipe.threshold { y0 + fw } else { y0 };
    let ytop = y1 - fw;
    let mut geo = OpeningGeometry::default();
    if xi <= mw || ytop <= yb + mw {
        return geo;
    }
    let cw = (2.0 * xi - (cols as f64 - 1.0) * mw) / cols as f64;
    let transom = ev(&recipe.transom_height, 0.0);
    let row_bounds: Vec<(f64, f64)> = if rows == 2 && transom > 0.0 {
        let t = (y0 + transom).clamp(yb + mw, ytop - mw);
        vec![(yb, t - mw * 0.5), (t + mw * 0.5, ytop)]
    } else {
        let rh = (ytop - yb - (rows as f64 - 1.0) * mw) / rows as f64;
        (0..rows)
            .map(|r| {
                let a = yb + r as f64 * (rh + mw);
                (a, a + rh)
            })
            .collect()
    };
    let mut cells = Vec::new();
    for (r, (ra, rb)) in row_bounds.iter().enumerate() {
        for c in 0..cols {
            let a = -xi + c as f64 * (cw + mw);
            cells.push((r, c, [a, a + cw, *ra, *rb]));
        }
    }
    let lay = Layout {
        hw,
        y0,
        y1,
        rise,
        fw,
        bottom_frame: recipe.threshold,
        cells,
        rows,
    };

    // Frame: outline minus all cells, one seamless solid (a U for doors).
    let mut holes = Region::new();
    for (r, _, rect) in &lay.cells {
        holes = region_union(&holes, &lay.cell(*r, *rect, 0.0));
    }
    let frame = region_subtract(&lay.outline(0.0, 0.0), &holes);
    geo.parts
        .extend(region_parts_of(&frame, -half, half, false, true));

    let sw = ev(&recipe.sash_width, 0.0).max(0.0);
    let sd = (ev(&recipe.sash_depth, 0.06) * 0.5).clamp(0.005, half);
    let bx = ev(&recipe.bars_x, 0.0).round().clamp(0.0, 20.0) as usize;
    let by = ev(&recipe.bars_y, 0.0).round().clamp(0.0, 20.0) as usize;
    let bw = ev(&recipe.bar_width, 0.02).max(0.004);
    let lt = ev(&recipe.leaf_thickness, 0.05).max(0.01);

    for (r, c, rect) in &lay.cells {
        let (r, c, rect) = (*r, *c, *rect);
        if recipe.infill == OpeningInfill::Leaf && r == 0 {
            let leaf = lay.cell(r, rect, SASH_GAP);
            let Some(b) = bbox(&leaf) else { continue };
            let left = (c as f64) < cols as f64 / 2.0;
            let (hu, sgn) = if left { (b[0], 1.0) } else { (b[1], -1.0) };
            let lw = b[1] - b[0];
            let (d0, d1) = if left { (-lt, 0.0) } else { (0.0, lt) };
            for shape in &leaf {
                let loops = shape
                    .iter()
                    .map(|ring| ring.iter().map(|p| [(p[0] - hu) * sgn, p[1]]).collect())
                    .collect();
                geo.parts.push(OpeningPart {
                    loops,
                    origin: [hu, half],
                    angle: std::f64::consts::FRAC_PI_2,
                    d0,
                    d1,
                    glass: false,
                    frame: false,
                });
            }
            let y = b[2] + 0.005;
            const SEG: usize = 16;
            let at = |t: f64| [hu + sgn * t.cos() * lw, y, half + t.sin() * lw];
            for i in 0..SEG {
                let t0 = i as f64 / SEG as f64 * std::f64::consts::FRAC_PI_2;
                let t1 = (i + 1) as f64 / SEG as f64 * std::f64::consts::FRAC_PI_2;
                geo.lines.push([at(t0), at(t1)]);
            }
            continue;
        }
        if sw > 0.0 {
            let outer = lay.cell(r, rect, SASH_GAP);
            let inner = lay.cell(r, rect, SASH_GAP + sw);
            let glazed = panes(&inner, bx, by, bw);
            let sash = region_subtract(&outer, &glazed);
            geo.parts.extend(region_parts(&sash, -sd, sd, false));
            let glass = lay.cell(r, rect, SASH_GAP + sw - 0.008);
            geo.parts.extend(region_parts(&glass, -0.006, 0.006, true));
        } else {
            if bx > 0 || by > 0 {
                let inner = lay.cell(r, rect, 0.0);
                let glazed = panes(&inner, bx, by, bw);
                let bars = region_subtract(&inner, &glazed);
                geo.parts.extend(region_parts(
                    &bars,
                    -0.015_f64.max(-half),
                    0.015_f64.min(half),
                    false,
                ));
            }
            let glass = lay.cell(r, rect, -0.008);
            geo.parts.extend(region_parts(&glass, -0.006, 0.006, true));
        }
    }
    geo
}

fn signed_area(ring: &[[f64; 2]]) -> f64 {
    let mut a = 0.0;
    for i in 0..ring.len() {
        let (p, q) = (ring[i], ring[(i + 1) % ring.len()]);
        a += p[0] * q[1] - q[0] * p[1];
    }
    a * 0.5
}

/// Place generated opening geometry in a wall frame (`u` along, `n` across,
/// `base` = element origin on the wall centreline). Each part becomes one
/// closed prism; edges are drawn on cap outlines and at real corners only,
/// so frames and sashes show no member seams.
pub fn emit_opening(mesh: &mut TriangleMesh, geo: &OpeningGeometry, base: Vec3, u: Vec3, n: Vec3) {
    let tri = |mesh: &mut TriangleMesh, a: Vec3, b: Vec3, d: Vec3, nn: Vec3| {
        if (b - a).cross(d - a).dot(nn) >= 0.0 {
            mesh.push_triangle(a.to_array(), b.to_array(), d.to_array(), nn.to_array());
        } else {
            mesh.push_triangle(a.to_array(), d.to_array(), b.to_array(), nn.to_array());
        }
    };
    for part in &geo.parts {
        if part.loops.is_empty() || (part.d1 - part.d0).abs() < 1e-6 {
            continue;
        }
        let (sa, ca) = (part.angle as f32).sin_cos();
        let a_dir = u * ca + n * sa;
        let b_dir = -u * sa + n * ca;
        let origin = base + u * part.origin[0] as f32 + n * part.origin[1] as f32;
        let (d0, d1) = (part.d0.min(part.d1) as f32, part.d0.max(part.d1) as f32);
        let pt =
            |p: [f64; 2], d: f32| origin + a_dir * p[0] as f32 + Vec3::Y * p[1] as f32 + b_dir * d;
        // Normalise orientation: outer CCW, holes CW (material on the left).
        let loops: Vec<Vec<[f64; 2]>> = part
            .loops
            .iter()
            .enumerate()
            .filter(|(_, l)| l.len() >= 3)
            .map(|(i, l)| {
                let ccw = signed_area(l) > 0.0;
                if (i == 0) != ccw {
                    l.iter().rev().copied().collect()
                } else {
                    l.clone()
                }
            })
            .collect();
        if loops.is_empty() {
            continue;
        }
        let first = mesh.normals.len();
        let cap_n = a_dir.cross(Vec3::Y);
        for t in triangulate_shape(&loops) {
            for (d, nn) in [(d0, -cap_n), (d1, cap_n)] {
                tri(mesh, pt(t[0], d), pt(t[1], d), pt(t[2], d), nn);
            }
        }
        for lp in &loops {
            let m = lp.len();
            for k in 0..m {
                let (p, q) = (lp[k], lp[(k + 1) % m]);
                let (ds, dy) = ((q[0] - p[0]) as f32, (q[1] - p[1]) as f32);
                if ds.abs() + dy.abs() < 1e-9 {
                    continue;
                }
                let nn = (a_dir * dy - Vec3::Y * ds).normalize_or_zero();
                let (pa, pb, qa, qb) = (pt(p, d0), pt(p, d1), pt(q, d0), pt(q, d1));
                tri(mesh, pa, qa, qb, nn);
                tri(mesh, pa, qb, pb, nn);
                mesh.push_edge(pa.to_array(), qa.to_array());
                mesh.push_edge(pb.to_array(), qb.to_array());
                // Depth edge only where the outline really turns.
                let o = lp[(k + m - 1) % m];
                let (v0, v1) = ([p[0] - o[0], p[1] - o[1]], [q[0] - p[0], q[1] - p[1]]);
                let l0 = (v0[0] * v0[0] + v0[1] * v0[1]).sqrt();
                let l1 = (v1[0] * v1[0] + v1[1] * v1[1]).sqrt();
                if l0 > 1e-9 && l1 > 1e-9 {
                    let cos = (v0[0] * v1[0] + v0[1] * v1[1]) / (l0 * l1);
                    if cos < 20f64.to_radians().cos() {
                        mesh.push_edge(pa.to_array(), pb.to_array());
                    }
                }
            }
        }
        if part.glass {
            for v in &mut mesh.normals[first..] {
                *v *= GLASS_NORMAL_TAG;
            }
        }
    }
    for [a, b] in &geo.lines {
        let p = |q: [f64; 3]| base + u * q[0] as f32 + Vec3::Y * q[1] as f32 + n * q[2] as f32;
        mesh.push_edge(p(*a).to_array(), p(*b).to_array());
    }
}

/// A species: a named set of species-bound values for one genus.
/// Hierarchy: genus (component definition) -> species -> instance (element).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Species {
    pub id: String,
    /// Component id of the genus this species belongs to.
    #[serde(alias = "family")]
    pub genus: String,
    pub name: String,
    #[serde(default)]
    pub values: ParamMap,
}

/// Instance param holding the element's species id (`type` in PR #114 files).
pub const SPECIES_PARAM: &str = "species";
/// Pre-rename key of [`SPECIES_PARAM`], migrated on load.
pub const LEGACY_SPECIES_PARAM: &str = "type";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::param::ParamValue;

    fn params(w: f64, h: f64) -> ParamMap {
        ParamMap::new()
            .with("width", ParamValue::Length(w))
            .with("height", ParamValue::Length(h))
            .with("sill", ParamValue::Length(0.9))
    }

    #[test]
    fn recipe_defaults_parse_from_empty_object() {
        let r: OpeningRecipe = serde_json::from_str("{}").unwrap();
        assert_eq!(r.width, Expr::param("width"));
        assert!(r.threshold);
    }

    fn check_parts(geo: &OpeningGeometry) {
        for part in &geo.parts {
            let mut mesh = TriangleMesh::empty();
            emit_opening(
                &mut mesh,
                &OpeningGeometry {
                    parts: vec![part.clone()],
                    lines: vec![],
                },
                Vec3::ZERO,
                Vec3::X,
                Vec3::Z,
            );
            assert!(apex_geometry::is_closed(&mesh), "part not closed");
        }
    }

    #[test]
    fn every_part_is_a_closed_solid() {
        let mut r = OpeningRecipe {
            columns: Expr::constant(2.0),
            sash_width: Expr::constant(0.04),
            bars_x: Expr::constant(1.0),
            bars_y: Expr::constant(2.0),
            arch_rise: Expr::constant(0.3),
            ..OpeningRecipe::default()
        };
        check_parts(&build_opening(&r, &params(1.5, 1.4), 0.2));
        r.infill = OpeningInfill::Leaf;
        r.threshold = false;
        r.rows = Expr::constant(2.0);
        r.transom_height = Expr::constant(2.1);
        let geo = build_opening(&r, &params(1.4, 2.5), 0.2);
        assert!(geo.parts.iter().any(|p| p.angle != 0.0));
        assert!(!geo.lines.is_empty());
        check_parts(&geo);
    }
}
