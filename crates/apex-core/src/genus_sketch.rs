//! Genus sketches: lines, arcs, rectangles and circles drawn in a plane of
//! the genus, turned into closed loops (outline first, then holes) for
//! extrude / revolve / sweep shapes. Coordinates are formulas, so a sketch
//! flexes with params; `ref.<id>` names read reference geometry (see
//! [`ref_params`]), which is how vertices are locked to references.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::genus_body::{Axis, GenusError, F};
use crate::param::{ParamMap, ParamValue};

/// Prefix of the formula names that read reference geometry.
pub const REF_PREFIX: &str = "ref.";

/// One drawn element of a sketch, in the sketch plane's 2D coordinates.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SketchItem {
    /// Straight segment `a → b`.
    Line { a: [F; 2], b: [F; 2] },
    /// Arc `a → b`; `bulge` = tan(sweep / 4), positive counter-clockwise.
    Arc { a: [F; 2], b: [F; 2], bulge: F },
    /// Axis-aligned rectangle with opposite corners `a`, `b` (a closed loop).
    Rect { a: [F; 2], b: [F; 2] },
    /// Circle with centre `c` and radius `r` (a closed loop).
    Circle { c: [F; 2], r: F },
}

impl SketchItem {
    pub fn formulas(&self) -> Vec<&F> {
        match self {
            SketchItem::Line { a, b } | SketchItem::Rect { a, b } => a.iter().chain(b).collect(),
            SketchItem::Arc { a, b, bulge } => a.iter().chain(b).chain([bulge]).collect(),
            SketchItem::Circle { c, r } => c.iter().chain([r]).collect(),
        }
    }
}

/// Params a sketch reads (without `ref.` names).
pub fn sketch_params(items: &[SketchItem], out: &mut Vec<String>) {
    for f in items.iter().flat_map(|i| i.formulas()) {
        f.params(out);
    }
}

/// Ref ids a formula reads through `ref.<id>` / `ref.<id>.x|y|z`.
pub fn ref_ids_of(name: &str) -> Option<&str> {
    let rest = name.strip_prefix(REF_PREFIX)?;
    Some(
        rest.strip_suffix(".x")
            .or_else(|| rest.strip_suffix(".y"))
            .or_else(|| rest.strip_suffix(".z"))
            .unwrap_or(rest),
    )
}

/// `params` plus `ref.<id>` values: a plane's offset along its normal, and
/// `ref.<id>.x|y|z` for the (first) point of every ref.
pub fn ref_params<'a>(
    params: &ParamMap,
    refs: impl IntoIterator<Item = (&'a str, [f64; 3], Option<Axis>)>,
) -> ParamMap {
    let mut out = params.clone();
    for (id, at, normal) in refs {
        for (k, axis) in ["x", "y", "z"].iter().enumerate() {
            out.set(
                format!("{REF_PREFIX}{id}.{axis}"),
                ParamValue::Length(at[k]),
            );
        }
        if let Some(n) = normal {
            out.set(
                format!("{REF_PREFIX}{id}"),
                ParamValue::Length(at[axis_index(n)]),
            );
        }
    }
    out
}

pub fn axis_index(a: Axis) -> usize {
    match a {
        Axis::X => 0,
        Axis::Y => 1,
        Axis::Z => 2,
    }
}

/// Local point of sketch-plane coordinates `q` at `depth` along the plane
/// normal, matching the prism outline axes: normal z → (x, y), normal x →
/// (z, y) with depth along −x, normal y → (x, z).
pub fn plane_point(normal: Axis, q: [f64; 2], depth: f64) -> [f64; 3] {
    match normal {
        Axis::Z => [q[0], q[1], depth],
        Axis::X => [-depth, q[1], q[0]],
        Axis::Y => [q[0], depth, q[1]],
    }
}

/// Inverse of [`plane_point`]: `(q, depth)` of a local point.
pub fn plane_coords(normal: Axis, p: [f64; 3]) -> ([f64; 2], f64) {
    match normal {
        Axis::Z => ([p[0], p[1]], p[2]),
        Axis::X => ([p[2], p[1]], -p[0]),
        Axis::Y => ([p[0], p[2]], p[1]),
    }
}

const TOL: f64 = 1e-6;

/// An open sketch piece: its points (end excluded), start and end.
type Piece = (Vec<[f64; 2]>, [f64; 2], [f64; 2]);

fn ev2(q: &[F; 2], p: &ParamMap) -> Result<[f64; 2], GenusError> {
    Ok([q[0].eval(p)?, q[1].eval(p)?])
}

fn err(msg: impl Into<String>) -> GenusError {
    GenusError::Other(format!("sketch: {}", msg.into()))
}

/// Points of an arc `a → b` with `bulge`, `a` included, `b` excluded.
fn arc_points(a: [f64; 2], b: [f64; 2], bulge: f64) -> Vec<[f64; 2]> {
    if bulge.abs() < 1e-9 {
        return vec![a];
    }
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let sweep = 4.0 * bulge.atan();
    // Centre: chord midpoint + left normal · (len/2)·(1 − b²)/(2b).
    let k = (1.0 - bulge * bulge) / (4.0 * bulge);
    let c = [(a[0] + b[0]) / 2.0 - dy * k, (a[1] + b[1]) / 2.0 + dx * k];
    let r = ((a[0] - c[0]).powi(2) + (a[1] - c[1]).powi(2)).sqrt();
    let a0 = (a[1] - c[1]).atan2(a[0] - c[0]);
    let n = ((sweep.abs() / (std::f64::consts::PI / 12.0)).ceil() as usize).max(2);
    (0..n)
        .map(|i| {
            let t = a0 + sweep * i as f64 / n as f64;
            [c[0] + r * t.cos(), c[1] + r * t.sin()]
        })
        .collect()
}

fn circle_points(c: [f64; 2], r: f64) -> Vec<[f64; 2]> {
    let n = 32;
    (0..n)
        .map(|i| {
            let t = std::f64::consts::TAU * i as f64 / n as f64;
            [c[0] + r * t.cos(), c[1] + r * t.sin()]
        })
        .collect()
}

pub fn signed_area(ring: &[[f64; 2]]) -> f64 {
    let mut a = 0.0;
    for i in 0..ring.len() {
        let (p, q) = (ring[i], ring[(i + 1) % ring.len()]);
        a += p[0] * q[1] - q[0] * p[1];
    }
    a * 0.5
}

fn inside(pt: [f64; 2], ring: &[[f64; 2]]) -> bool {
    let mut c = false;
    let n = ring.len();
    for i in 0..n {
        let (a, b) = (ring[i], ring[(i + n - 1) % n]);
        if (a[1] > pt[1]) != (b[1] > pt[1])
            && pt[0] < (b[0] - a[0]) * (pt[1] - a[1]) / (b[1] - a[1]) + a[0]
        {
            c = !c;
        }
    }
    c
}

fn key(q: [f64; 2]) -> (i64, i64) {
    ((q[0] / TOL).round() as i64, (q[1] / TOL).round() as i64)
}

/// Closed loops of a sketch: the outline first, then holes inside it.
/// Errors: empty sketch, an open end, a vertex with more than two edges,
/// a zero-size element, a loop outside the outline.
pub fn sketch_loops(items: &[SketchItem], p: &ParamMap) -> Result<Vec<Vec<[f64; 2]>>, GenusError> {
    let mut loops: Vec<Vec<[f64; 2]>> = Vec::new();
    // Open pieces: point lists a … (b excluded) plus both ends.
    let mut pieces: Vec<Piece> = Vec::new();
    for item in items {
        match item {
            SketchItem::Rect { a, b } => {
                let (a, b) = (ev2(a, p)?, ev2(b, p)?);
                if (a[0] - b[0]).abs() < TOL || (a[1] - b[1]).abs() < TOL {
                    return Err(err("zero-size rectangle"));
                }
                loops.push(vec![a, [b[0], a[1]], b, [a[0], b[1]]]);
            }
            SketchItem::Circle { c, r } => {
                let (c, r) = (ev2(c, p)?, r.eval(p)?);
                if r < TOL {
                    return Err(err("zero-size circle"));
                }
                loops.push(circle_points(c, r));
            }
            SketchItem::Line { a, b } => {
                let (a, b) = (ev2(a, p)?, ev2(b, p)?);
                if key(a) == key(b) {
                    return Err(err("zero-length line"));
                }
                pieces.push((vec![a], a, b));
            }
            SketchItem::Arc { a, b, bulge } => {
                let (a, b, k) = (ev2(a, p)?, ev2(b, p)?, bulge.eval(p)?);
                if key(a) == key(b) {
                    return Err(err("zero-length arc"));
                }
                pieces.push((arc_points(a, b, k), a, b));
            }
        }
    }
    let mut degree: BTreeMap<(i64, i64), (usize, [f64; 2])> = BTreeMap::new();
    for (_, a, b) in &pieces {
        for q in [a, b] {
            degree.entry(key(*q)).or_insert((0, *q)).0 += 1;
        }
    }
    for (n, q) in degree.values() {
        if *n == 1 {
            return Err(err(format!("open profile at ({:.3}, {:.3})", q[0], q[1])));
        }
        if *n > 2 {
            return Err(err(format!(
                "more than two edges meet at ({:.3}, {:.3})",
                q[0], q[1]
            )));
        }
    }
    let mut used = vec![false; pieces.len()];
    for start in 0..pieces.len() {
        if used[start] {
            continue;
        }
        used[start] = true;
        let mut ring = pieces[start].0.clone();
        let first = key(pieces[start].1);
        let mut end = pieces[start].2;
        while key(end) != first {
            let next = (0..pieces.len()).find(|&j| {
                !used[j] && (key(pieces[j].1) == key(end) || key(pieces[j].2) == key(end))
            });
            let Some(j) = next else {
                return Err(err("open profile"));
            };
            used[j] = true;
            let (pts, a, b) = &pieces[j];
            if key(*a) == key(end) {
                ring.extend(pts.iter().copied());
                end = *b;
            } else {
                // Walk the piece backwards: b … a (a excluded, b included).
                let mut back: Vec<[f64; 2]> = pts.iter().skip(1).copied().collect();
                back.push(*b);
                back.reverse();
                ring.extend(back);
                end = *a;
            }
        }
        if ring.len() < 3 {
            return Err(err("a loop needs at least three corners"));
        }
        loops.push(ring);
    }
    if loops.is_empty() {
        return Err(err("empty"));
    }
    let outer = (0..loops.len())
        .max_by(|&i, &j| {
            signed_area(&loops[i])
                .abs()
                .total_cmp(&signed_area(&loops[j]).abs())
        })
        .unwrap_or(0);
    let o = loops.remove(outer);
    for l in &loops {
        if !inside(l[0], &o) {
            return Err(err("a loop lies outside the outline"));
        }
    }
    loops.insert(0, o);
    Ok(loops)
}
