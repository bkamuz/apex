//! A line in plan with one of two bodies.
//!
//! `repeated_line` places vertical posts and straight panels between them.
//! `profile_line` sweeps a vertical rectangle (width across the line, height
//! up) so each span is a straight sloped or level prism. Neither function
//! samples terrain: the caller passes the seated centreline and, for posts,
//! the ground height under each post.

use crate::mesh::TriangleMesh;

/// Posts and the panels that fill the bays between them.
#[derive(Debug, Clone, Copy)]
pub struct RepeatedLine {
    /// Height of the post above the seated line.
    pub post_height: f64,
    /// Square post size in plan.
    pub post_size: f64,
    /// Plan distance between posts. Below 5 cm, posts sit only on vertices.
    pub spacing: f64,
    /// Vertical panel size above the seated line.
    pub panel_height: f64,
    /// Panel thickness across the line.
    pub panel_thickness: f64,
    /// Extra depth below the lower of the line and the ground.
    pub embed: f64,
}

/// Rectangular section, width across the line and height straight up.
#[derive(Debug, Clone, Copy)]
pub struct LineProfile {
    pub width: f64,
    pub height: f64,
}

/// Plan gap left between stones so a joint reads as two pieces.
pub const JOINT_GAP: f64 = 0.02;

/// Posts at every vertex and at `spacing` along each span, panels between them.
///
/// `ground(x, z)` is the terrain under a post. `None` leaves the post sitting
/// on the seated line (still embedded by `embed`).
pub fn repeated_line(
    points: &[[f64; 3]],
    ground: impl Fn(f64, f64) -> Option<f64>,
    spec: &RepeatedLine,
) -> TriangleMesh {
    let points = clean(points);
    let mut mesh = TriangleMesh::empty();
    if points.len() < 2 {
        return mesh;
    }
    let post_h = spec.post_height.max(0.0);
    let post_s = spec.post_size.max(0.02);
    let panel_h = spec.panel_height.max(0.0);
    let panel_t = spec.panel_thickness.max(0.005);
    let embed = spec.embed.max(0.0);
    let mut last_post: Option<[f64; 3]> = None;
    for seg in points.windows(2) {
        let tangent = segment_tangent(seg[0], seg[1]);
        let stations = stations(seg[0], seg[1], spec.spacing);
        for i in 0..stations.len() {
            let p = stations[i];
            let duplicate = last_post.is_some_and(|q| plan_len(p, q) < 1e-3);
            if !duplicate {
                add_post(&mut mesh, p, tangent, &ground, post_s, post_h, embed);
                last_post = Some(p);
            }
            if panel_h > 1e-4 && i + 1 < stations.len() {
                add_panel(&mut mesh, p, stations[i + 1], post_s, panel_t, panel_h);
            }
        }
    }
    mesh
}

/// A stone shorter than this, once the joint gap is taken out, is not drawn.
const MIN_STONE: f64 = 0.02;

/// Straight stones along `points`.
///
/// `segment` below 5 cm keeps each span as one piece (no extra joints).
/// Otherwise each span is cut every `segment` metres in plan. A remainder
/// too short to stand on its own is kept on the previous stone, so the run
/// still reaches the vertex or the path end. A whole span that short is
/// omitted and its neighbours are not pulled back for a joint that is not
/// there. Surviving joints, including a polyline vertex, are pulled back by
/// half of `gap`. Endpoints keep the input heights.
pub fn profile_segments(points: &[[f64; 3]], segment: f64, gap: f64) -> Vec<[[f64; 3]; 2]> {
    let points = clean(points);
    if points.len() < 2 {
        return Vec::new();
    }
    let half = (gap * 0.5).max(0.0);
    let fold_under = MIN_STONE + gap.max(0.0);
    let mut spans: Vec<Vec<(f64, f64)>> = Vec::with_capacity(points.len() - 1);
    for seg in points.windows(2) {
        let len = plan_len(seg[0], seg[1]);
        if len < 1e-4 {
            spans.push(Vec::new());
            continue;
        }
        if segment < 0.05 {
            spans.push(vec![(0.0, len)]);
            continue;
        }
        let mut ds = vec![0.0];
        let mut d = segment;
        while d < len - 1e-3 {
            ds.push(d);
            d += segment;
        }
        ds.push(len);
        let mut folded: Vec<(f64, f64)> = Vec::new();
        for w in ds.windows(2) {
            let (a, b) = (w[0], w[1]);
            if b - a < 1e-6 {
                continue;
            }
            if b - a < fold_under {
                if let Some(prev) = folded.last_mut() {
                    prev.1 = b;
                    continue;
                }
            }
            folded.push((a, b));
        }
        if folded.len() >= 2 && folded[0].1 - folded[0].0 < fold_under {
            folded[1].0 = folded[0].0;
            folded.remove(0);
        }
        spans.push(folded);
    }
    let any_real = spans
        .iter()
        .any(|span| span.iter().any(|p| p.1 - p.0 >= fold_under));
    if any_real {
        for span in &mut spans {
            span.retain(|p| p.1 - p.0 >= fold_under);
        }
    }
    // (span, start, end, span length)
    let mut pieces: Vec<(usize, f64, f64, f64)> = Vec::new();
    for (si, span) in spans.iter().enumerate() {
        let len = plan_len(points[si], points[si + 1]);
        for &(a, b) in span {
            pieces.push((si, a, b, len));
        }
    }
    let split = segment >= 0.05;
    let mut out = Vec::with_capacity(pieces.len());
    for i in 0..pieces.len() {
        let (si, mut a, mut b, len) = pieces[i];
        if len < 1e-6 {
            continue;
        }
        if split && i > 0 && stones_meet(pieces[i - 1], pieces[i]) {
            a += half;
        }
        if split && i + 1 < pieces.len() && stones_meet(pieces[i], pieces[i + 1]) {
            b -= half;
        }
        if b - a < MIN_STONE {
            continue;
        }
        let seg = [points[si], points[si + 1]];
        out.push([lerp(seg[0], seg[1], a / len), lerp(seg[0], seg[1], b / len)]);
    }
    out
}

/// Consecutive stones share a joint. A span that was omitted is not a joint,
/// so the neighbours run out to their own vertices.
fn stones_meet(prev: (usize, f64, f64, f64), next: (usize, f64, f64, f64)) -> bool {
    let (span, _, end, span_len) = prev;
    let (next_span, start, _, _) = next;
    if span == next_span {
        return (start - end).abs() < 1e-3;
    }
    next_span == span + 1 && start < 1e-3 && (span_len - end).abs() < 1e-3
}

/// Vertical rectangular prism along the seated centreline, mitred in plan.
pub fn profile_line(points: &[[f64; 3]], spec: &LineProfile) -> TriangleMesh {
    let points = clean(points);
    let mut mesh = TriangleMesh::empty();
    if points.len() < 2 || spec.width < 1e-4 || spec.height < 1e-4 {
        return mesh;
    }
    let half = spec.width * 0.5;
    let sides = rails(&points, half);
    for i in 0..points.len() - 1 {
        let [l0, r0] = sides[i];
        let [l1, r1] = sides[i + 1];
        prism(&mut mesh, l0, r0, r1, l1, spec.height);
    }
    mesh
}

fn clean(points: &[[f64; 3]]) -> Vec<[f64; 3]> {
    let mut out = Vec::with_capacity(points.len());
    for p in points {
        if out.last().is_some_and(|q| plan_len(*p, *q) < 1e-4) {
            continue;
        }
        out.push(*p);
    }
    out
}

fn plan_len(a: [f64; 3], b: [f64; 3]) -> f64 {
    let dx = b[0] - a[0];
    let dz = b[2] - a[2];
    dx.hypot(dz)
}

fn lerp(a: [f64; 3], b: [f64; 3], t: f64) -> [f64; 3] {
    [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
    ]
}

/// Plan stations on `a → b`, including both ends. Spacing is measured in plan.
fn stations(a: [f64; 3], b: [f64; 3], spacing: f64) -> Vec<[f64; 3]> {
    let len = plan_len(a, b);
    if len < 1e-4 {
        return Vec::new();
    }
    let mut ds = vec![0.0];
    if spacing >= 0.05 {
        let mut d = spacing;
        while d < len - 1e-3 {
            ds.push(d);
            d += spacing;
        }
    }
    ds.push(len);
    ds.into_iter().map(|d| lerp(a, b, d / len)).collect()
}

fn add_post(
    mesh: &mut TriangleMesh,
    at: [f64; 3],
    tangent: [f64; 2],
    ground: &impl Fn(f64, f64) -> Option<f64>,
    size: f64,
    post_height: f64,
    embed: f64,
) {
    let line_y = at[1];
    let bottom = match ground(at[0], at[2]) {
        Some(g) => g.min(line_y) - embed,
        None => line_y - embed,
    };
    let height = line_y + post_height - bottom;
    if height < 1e-4 {
        return;
    }
    add_post_oriented(mesh, at, tangent, size, bottom, height);
}

fn add_post_oriented(
    mesh: &mut TriangleMesh,
    at: [f64; 3],
    tangent: [f64; 2],
    size: f64,
    bottom: f64,
    height: f64,
) {
    let (tx, tz) = (tangent[0], tangent[1]);
    let (nx, nz) = (-tz, tx);
    let h = size * 0.5;
    let corner = |sx: f64, sz: f64| {
        [
            at[0] + (tx * sx + nx * sz) * h,
            bottom,
            at[2] + (tz * sx + nz * sz) * h,
        ]
    };
    prism(
        mesh,
        corner(-1.0, -1.0),
        corner(1.0, -1.0),
        corner(1.0, 1.0),
        corner(-1.0, 1.0),
        height,
    );
}

fn add_panel(
    mesh: &mut TriangleMesh,
    a: [f64; 3],
    b: [f64; 3],
    post_size: f64,
    thickness: f64,
    height: f64,
) {
    let len = plan_len(a, b);
    if len < 1e-4 || height < 1e-4 {
        return;
    }
    let inset = (post_size * 0.5 / len).min(0.49);
    if inset * 2.0 + 1e-4 >= 1.0 {
        return;
    }
    let start = lerp(a, b, inset);
    let end = lerp(a, b, 1.0 - inset);
    let (nx, nz) = {
        let t = segment_tangent(start, end);
        (-t[1], t[0])
    };
    let half = thickness * 0.5;
    let side = |p: [f64; 3], s: f64| [p[0] + nx * half * s, p[1], p[2] + nz * half * s];
    prism(
        mesh,
        side(start, -1.0),
        side(start, 1.0),
        side(end, 1.0),
        side(end, -1.0),
        height,
    );
}

fn segment_tangent(a: [f64; 3], b: [f64; 3]) -> [f64; 2] {
    let len = plan_len(a, b);
    if len < 1e-9 {
        [1.0, 0.0]
    } else {
        [(b[0] - a[0]) / len, (b[2] - a[2]) / len]
    }
}

fn rails(points: &[[f64; 3]], half: f64) -> Vec<[[f64; 3]; 2]> {
    let n = points.len();
    (0..n)
        .map(|i| {
            let prev = (i > 0).then(|| segment_tangent(points[i - 1], points[i]));
            let next = (i + 1 < n).then(|| segment_tangent(points[i], points[i + 1]));
            let nrm = miter_left(prev, next);
            let c = points[i];
            let left = [c[0] + nrm[0] * half, c[1], c[2] + nrm[1] * half];
            let right = [c[0] - nrm[0] * half, c[1], c[2] - nrm[1] * half];
            [left, right]
        })
        .collect()
}

/// Left offset in plan, stretched at a corner so both sides keep `half` width.
fn miter_left(prev: Option<[f64; 2]>, next: Option<[f64; 2]>) -> [f64; 2] {
    let left = |d: [f64; 2]| [-d[1], d[0]];
    match (prev, next) {
        (Some(d0), Some(d1)) => {
            let n0 = left(d0);
            let n1 = left(d1);
            let mx = n0[0] + n1[0];
            let mz = n0[1] + n1[1];
            let len = mx.hypot(mz);
            if len < 1e-8 {
                return n0;
            }
            let m = [mx / len, mz / len];
            let dot = (m[0] * n0[0] + m[1] * n0[1]).max(0.3);
            [m[0] / dot, m[1] / dot]
        }
        (Some(d), None) | (None, Some(d)) => left(d),
        (None, None) => [0.0, 1.0],
    }
}

fn f3(p: [f64; 3]) -> [f32; 3] {
    [p[0] as f32, p[1] as f32, p[2] as f32]
}

fn nrm(a: [f32; 3], b: [f32; 3], c: [f32; 3]) -> [f32; 3] {
    let (ux, uy, uz) = (b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    let (vx, vy, vz) = (c[0] - a[0], c[1] - a[1], c[2] - a[2]);
    let n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    let len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
    if len < 1e-12 {
        [0.0, 1.0, 0.0]
    } else {
        [n[0] / len, n[1] / len, n[2] / len]
    }
}

fn quad(mesh: &mut TriangleMesh, p: [[f64; 3]; 4]) {
    let q = p.map(f3);
    // The corner order traces the face; the opposite winding points outward.
    let n = nrm(q[0], q[2], q[1]);
    mesh.push_triangle(q[0], q[2], q[1], n);
    mesh.push_triangle(q[0], q[3], q[2], n);
    mesh.push_edge(q[0], q[1]);
    mesh.push_edge(q[1], q[2]);
    mesh.push_edge(q[2], q[3]);
    mesh.push_edge(q[3], q[0]);
}

/// Vertical prism. `bl/br` are the start edge, `fr/fl` the end edge, bottom.
fn prism(
    mesh: &mut TriangleMesh,
    bl: [f64; 3],
    br: [f64; 3],
    fr: [f64; 3],
    fl: [f64; 3],
    height: f64,
) {
    let up = |p: [f64; 3]| [p[0], p[1] + height, p[2]];
    quad(mesh, [bl, fl, fr, br]);
    quad(mesh, [up(bl), up(br), up(fr), up(fl)]);
    quad(mesh, [bl, br, up(br), up(bl)]);
    quad(mesh, [br, fr, up(fr), up(br)]);
    quad(mesh, [fr, fl, up(fl), up(fr)]);
    quad(mesh, [fl, bl, up(bl), up(fl)]);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mesh_volume;

    fn y_span_near(mesh: &TriangleMesh, x: f64, z: f64, r: f64) -> Option<(f32, f32)> {
        let mut lo = f32::MAX;
        let mut hi = f32::MIN;
        let mut hit = false;
        for p in mesh.positions.chunks(3) {
            let dx = p[0] as f64 - x;
            let dz = p[2] as f64 - z;
            if dx * dx + dz * dz > r * r {
                continue;
            }
            hit = true;
            lo = lo.min(p[1]);
            hi = hi.max(p[1]);
        }
        hit.then_some((lo, hi))
    }

    #[test]
    fn a_straight_profile_is_a_vertical_box() {
        let mesh = profile_line(
            &[[0.0, 0.0, 0.0], [4.0, 1.0, 0.0]],
            &LineProfile {
                width: 0.2,
                height: 0.15,
            },
        );
        let (lo, hi) = mesh.aabb().expect("aabb");
        assert!((hi[0] - lo[0] - 4.0).abs() < 1e-3, "length");
        assert!(
            (hi[2] - lo[2] - 0.2).abs() < 1e-3,
            "width {}",
            hi[2] - lo[2]
        );
        assert!((hi[1] - 1.15).abs() < 1e-3, "high end top {}", hi[1]);
        assert!(lo[1].abs() < 1e-3, "low end base {}", lo[1]);
        let vol = mesh_volume(&mesh);
        assert!(
            (vol - 4.0 * 0.2 * 0.15).abs() < 1e-3,
            "volume {vol} (outward winding is positive)"
        );
    }

    #[test]
    fn posts_land_on_vertices_and_on_the_spacing() {
        let mesh = repeated_line(
            &[[0.0, 1.0, 0.0], [6.0, 1.0, 0.0]],
            |_, _| Some(0.0),
            &RepeatedLine {
                post_height: 1.5,
                post_size: 0.1,
                spacing: 2.0,
                panel_height: 1.2,
                panel_thickness: 0.04,
                embed: 0.02,
            },
        );
        for x in [0.0, 2.0, 4.0, 6.0] {
            let (lo, hi) = y_span_near(&mesh, x, 0.0, 0.08).expect("post");
            assert!(lo < -0.01, "post at {x} reaches the ground, bottom {lo}");
            assert!((hi - 2.5).abs() < 1e-2, "post top {hi}");
        }
        // A panel is one prism, so its vertices sit at the bay ends, inset
        // from the posts — not at the middle of the face.
        let (lo, hi) = y_span_near(&mesh, 0.05, 0.0, 0.04).expect("panel");
        assert!(lo > 0.9, "panel stays on the line, bottom {lo}");
        assert!((hi - 2.2).abs() < 1e-2, "panel top {hi}");
    }

    #[test]
    fn a_post_in_a_valley_reaches_the_ground_and_the_panel_does_not() {
        let mesh = repeated_line(
            &[[0.0, 0.0, 0.0], [4.0, 0.0, 0.0]],
            |x, _| {
                if (x - 2.0).abs() < 0.2 {
                    Some(-1.5)
                } else {
                    Some(0.0)
                }
            },
            &RepeatedLine {
                post_height: 1.0,
                post_size: 0.12,
                spacing: 2.0,
                panel_height: 0.8,
                panel_thickness: 0.04,
                embed: 0.02,
            },
        );
        let (lo, hi) = y_span_near(&mesh, 2.0, 0.0, 0.1).expect("mid post");
        assert!(lo < -1.4, "post drops into the valley, bottom {lo}");
        assert!((hi - 1.0).abs() < 1e-2, "post top stays on the line, {hi}");
        let (plo, _) = y_span_near(&mesh, 0.08, 0.0, 0.05).expect("panel");
        assert!(
            plo > -0.05,
            "panel does not follow the valley, bottom {plo}"
        );
    }

    #[test]
    fn a_long_run_splits_into_stones_with_a_gap_at_each_joint() {
        let pieces = profile_segments(&[[0.0, 0.0, 0.0], [3.5, 0.0, 0.0]], 1.0, JOINT_GAP);
        assert_eq!(pieces.len(), 4, "1 + 1 + 1 + 0.5");
        assert!(pieces[0][0][0].abs() < 1e-6, "the outer start is not inset");
        assert!(
            (pieces[3][1][0] - 3.5).abs() < 1e-6,
            "the outer end is not inset"
        );
        let gap = pieces[1][0][0] - pieces[0][1][0];
        assert!((gap - JOINT_GAP).abs() < 1e-6, "joint gap {gap}");
        assert!(
            pieces[3][1][0] - pieces[3][0][0] < 0.5,
            "the last stone is the remainder"
        );
    }

    #[test]
    fn a_short_remainder_stays_on_the_stone_and_reaches_the_end() {
        let pieces = profile_segments(&[[0.0, 0.0, 0.0], [1.03, 0.0, 0.0]], 1.0, JOINT_GAP);
        assert_eq!(pieces.len(), 1, "the 3 cm stub is not its own stone");
        assert!(pieces[0][0][0].abs() < 1e-6);
        assert!(
            (pieces[0][1][0] - 1.03).abs() < 1e-6,
            "the run reaches the path end, got {}",
            pieces[0][1][0]
        );
    }

    #[test]
    fn a_dropped_span_does_not_pull_the_neighbours_back() {
        let pieces = profile_segments(
            &[
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [1.03, 0.0, 0.0],
                [2.03, 0.0, 0.0],
            ],
            1.0,
            JOINT_GAP,
        );
        assert_eq!(pieces.len(), 2);
        assert!((pieces[0][1][0] - 1.0).abs() < 1e-6, "reaches the vertex");
        assert!(
            (pieces[1][0][0] - 1.03).abs() < 1e-6,
            "starts at the next vertex"
        );
    }

    #[test]
    fn a_zero_segment_length_is_one_piece_per_span() {
        let pieces = profile_segments(
            &[[0.0, 0.0, 0.0], [2.0, 0.0, 0.0], [2.0, 0.0, 2.0]],
            0.0,
            JOINT_GAP,
        );
        assert_eq!(pieces.len(), 2);
        assert!(pieces[0][0][0].abs() < 1e-6);
        assert!((pieces[0][1][0] - 2.0).abs() < 1e-6);
    }
}
