//! Plan-view symbols for hosted openings: a door draws its leaf and swing arc,
//! a window draws glazing lines across the wall, so the two read differently
//! in plan even though both cut the wall the same way.

use glam::Vec3;

use crate::element::Element;
use crate::project::Project;

const ARC_SEGMENTS: usize = 12;
const DEFAULT_WALL_THICKNESS: f32 = 0.2;

/// Segment pairs (consecutive points) for every door/window on `level`.
pub fn opening_plan_symbols(project: &Project, level: Option<crate::LevelId>) -> Vec<Vec3> {
    let mut out = Vec::new();
    for element in project.document().elements() {
        if element.component_id == "apex.stair" {
            if level.is_none_or(|l| project.effective_level_id(element.id) == Some(l)) {
                stair_symbol(project, element, &mut out);
            }
            continue;
        }
        let kind = match element.component_id.as_str() {
            "apex.door" => Kind::Door,
            "apex.window" => Kind::Window,
            _ => continue,
        };
        if let Some(level) = level {
            if project.effective_level_id(element.id) != Some(level) {
                continue;
            }
        }
        if let Some(frame) = opening_frame(project, element) {
            match kind {
                Kind::Door => door_symbol(&frame, &mut out),
                Kind::Window => window_symbol(&frame, &mut out),
            }
        }
    }
    out
}

enum Kind {
    Door,
    Window,
}

struct OpeningFrame {
    center: Vec3,
    /// Unit vector along the wall.
    along: Vec3,
    /// Unit plan normal of the wall.
    across: Vec3,
    width: f32,
    wall_thickness: f32,
}

fn opening_frame(project: &Project, element: &Element) -> Option<OpeningFrame> {
    let center = *element.placement.anchors().first()?;
    let params = project
        .registry()
        .persistable_params(&element.component_id, &element.params)
        .unwrap_or_else(|_| element.params.clone());
    let width = params.number("width").unwrap_or(0.9) as f32;

    let host = element
        .parent_id
        .and_then(|id| project.document().get_element(id));
    let (along, wall_thickness) = match host {
        Some(wall) => {
            // The segment the opening actually sits in, not the wall's first one.
            let dir = wall
                .placement
                .curve()
                .and_then(|c| crate::path_join::host_tangent_at(c, center))
                .map(|d| Vec3::new(d.x, 0.0, d.z))
                .unwrap_or(Vec3::X);
            (dir, wall_thickness(project, wall))
        }
        None => (Vec3::X, DEFAULT_WALL_THICKNESS),
    };
    let along = along.try_normalize().unwrap_or(Vec3::X);
    let across = Vec3::new(-along.z, 0.0, along.x);
    Some(OpeningFrame {
        center,
        along,
        across,
        width,
        wall_thickness,
    })
}

fn wall_thickness(project: &Project, wall: &Element) -> f32 {
    let registry = project.registry();
    let from_params = registry
        .persistable_params(&wall.component_id, &wall.params)
        .ok()
        .and_then(|p| p.number("thickness").or_else(|| p.number("width")));
    let from_type = registry
        .element_profile_id(wall)
        .and_then(|id| registry.profile(&id))
        .and_then(|profile| profile.resolve_type_values().ok())
        .and_then(|values| {
            values
                .number("width")
                .or_else(|| values.number("thickness"))
        });
    from_params
        .or(from_type)
        .map(|t| t as f32)
        .filter(|t| *t > 0.0)
        .unwrap_or(DEFAULT_WALL_THICKNESS)
}

fn push(out: &mut Vec<Vec3>, a: Vec3, b: Vec3) {
    out.push(a);
    out.push(b);
}

/// Frame member width of hosted openings (matches `hosted_opening_assembly`).
const DOOR_FRAME_WIDTH: f32 = 0.06;

/// Leaf drawn open at 90° from the hinge jamb plus a quarter-circle swing.
fn door_symbol(f: &OpeningFrame, out: &mut Vec<Vec3>) {
    let half_t = f.wall_thickness * 0.5;
    // Same hinge and leaf length as the 3D leaf (inside the frame jambs),
    // so the overlay and the mesh edges coincide instead of doubling up.
    let leaf = (f.width - 2.0 * DOOR_FRAME_WIDTH).max(f.width * 0.5);
    let hinge = f.center - f.along * (leaf * 0.5) + f.across * half_t;
    let leaf_end = hinge + f.across * leaf;
    push(out, hinge, leaf_end);
    let mut prev = hinge + f.along * leaf;
    for i in 1..=ARC_SEGMENTS {
        let t = (i as f32 / ARC_SEGMENTS as f32) * std::f32::consts::FRAC_PI_2;
        let next = hinge + (f.along * t.cos() + f.across * t.sin()) * leaf;
        push(out, prev, next);
        prev = next;
    }
}

/// Jambs across the wall plus two parallel glazing lines between them.
fn window_symbol(f: &OpeningFrame, out: &mut Vec<Vec3>) {
    let half_w = f.along * (f.width * 0.5);
    let half_t = f.across * (f.wall_thickness * 0.5);
    let glass = f.across * (f.wall_thickness * 0.12).max(0.015);
    let (l, r) = (f.center - half_w, f.center + half_w);
    push(out, l - half_t, l + half_t);
    push(out, r - half_t, r + half_t);
    push(out, l - glass, r - glass);
    push(out, l + glass, r + glass);
    push(out, l - half_t, r - half_t);
    push(out, l + half_t, r + half_t);
}

/// Height above the stair base where the plan cut line is drawn.
const STAIR_CUT_HEIGHT: f32 = 1.2;

/// Stair plan symbol: outline, treads up to the cut, a diagonal cut line and
/// a walking-line arrow pointing up the run.
fn stair_symbol(project: &Project, stair: &Element, out: &mut Vec<Vec3>) {
    let Some((corners, top)) = project.stair_footprint(stair) else {
        return;
    };
    let params = project
        .registry()
        .persistable_params(&stair.component_id, &stair.params)
        .unwrap_or_else(|_| stair.params.clone());
    let riser = (params.number("riser").unwrap_or(0.17) as f32).max(0.05);
    let height = top - corners[0].y;
    let steps = ((height / riser).round() as u32).max(1);
    stair_lines(corners, steps, height, out);
}

fn stair_lines(c: [Vec3; 4], steps: u32, height: f32, out: &mut Vec<Vec3>) {
    // c: [a-side, b-side, b+side, a+side]; run goes a→b.
    let lift = |p: Vec3| Vec3::new(p.x, c[0].y + 0.01, p.z);
    let c = c.map(lift);
    let run = c[1] - c[0];
    let span = c[3] - c[0];
    let riser = height / steps as f32;
    let cut_step = ((STAIR_CUT_HEIGHT / riser).ceil() as u32).clamp(1, steps);
    let t_cut = cut_step as f32 / steps as f32;
    // Outline up to the cut on both sides, plus the start nosing.
    push(out, c[0], c[3]);
    push(out, c[0], c[0] + run * t_cut);
    push(out, c[3], c[3] + run * t_cut);
    for i in 1..cut_step {
        let t = i as f32 / steps as f32;
        push(out, c[0] + run * t, c[3] + run * t);
    }
    // Diagonal cut line across the run, with a break zig-zag in the middle.
    let step_len = run / steps as f32;
    let p0 = c[0] + run * t_cut - step_len * 0.5;
    let p1 = c[3] + run * t_cut + step_len * 0.5;
    let m = (p0 + p1) * 0.5;
    let d = (p1 - p0).normalize_or_zero();
    let n = run.normalize_or_zero() * step_len.length().max(0.08) * 0.6;
    let z0 = m - d * 0.08;
    let z1 = m + d * 0.08;
    push(out, p0, z0);
    push(out, z0, z0 + n * 0.5 + d * 0.04);
    push(out, z0 + n * 0.5 + d * 0.04, z1 - n * 0.5 - d * 0.04);
    push(out, z1 - n * 0.5 - d * 0.04, z1);
    push(out, z1, p1);
    // "UP" label at the foot of the run, always upright on the sheet (plan up
    // is -Z), then the walking line from it to the cut, arrowhead at the end.
    let up_dir = run.normalize_or_zero();
    let h = (span.length() * 0.22).clamp(0.08, 0.2);
    let label = c[0] + span * 0.5 + up_dir * (step_len.length() * 0.3 + h * 0.8);
    up_label(label + Vec3::Z * (h * 0.5), Vec3::X, Vec3::NEG_Z, h, out);
    let s = label + up_dir * (h * 1.4);
    let e = c[0] + span * 0.5 + run * t_cut - step_len * 0.9;
    push(out, s, e);
    let back = (s - e).normalize_or_zero() * 0.18;
    let side = span.normalize_or_zero() * 0.1;
    push(out, e, e + back + side);
    push(out, e, e + back - side);
}

/// Line glyphs for "UP": `base` is the bottom centre, letters `h` tall.
fn up_label(base: Vec3, right: Vec3, up: Vec3, h: f32, out: &mut Vec<Vec3>) {
    let w = h * 0.6;
    let gap = h * 0.3;
    let x0 = -(2.0 * w + gap) * 0.5;
    let at = |x: f32, y: f32| base + right * x + up * (y * h);
    // U
    let (u0, u1) = (x0, x0 + w);
    push(out, at(u0, 1.0), at(u0, 0.0));
    push(out, at(u0, 0.0), at(u1, 0.0));
    push(out, at(u1, 0.0), at(u1, 1.0));
    // P
    let (p0, p1) = (u1 + gap, u1 + gap + w);
    push(out, at(p0, 0.0), at(p0, 1.0));
    push(out, at(p0, 1.0), at(p1, 1.0));
    push(out, at(p1, 1.0), at(p1, 0.5));
    push(out, at(p1, 0.5), at(p0, 0.5));
}

/// Segments drawn by [`up_label`].
#[cfg(test)]
const UP_LABEL_SEGMENTS: usize = 7;

#[cfg(test)]
mod tests {
    use super::*;

    fn frame() -> OpeningFrame {
        OpeningFrame {
            center: Vec3::ZERO,
            along: Vec3::X,
            across: Vec3::Z,
            width: 1.0,
            wall_thickness: 0.2,
        }
    }

    #[test]
    fn door_has_leaf_and_arc() {
        let mut out = Vec::new();
        door_symbol(&frame(), &mut out);
        assert_eq!(out.len(), 2 * (1 + ARC_SEGMENTS));
        // Arc ends at the open leaf tip.
        assert!((out[out.len() - 1] - out[1]).length() < 1e-4);
    }

    #[test]
    fn stair_draws_treads_cut_line_and_arrow() {
        let c = [
            Vec3::new(0.0, 0.0, -0.5),
            Vec3::new(4.0, 0.0, -0.5),
            Vec3::new(4.0, 0.0, 0.5),
            Vec3::new(0.0, 0.0, 0.5),
        ];
        let mut out = Vec::new();
        stair_lines(c, 18, 3.0, &mut out);
        // 3 outline + (cut_step-1) treads + 5 cut + UP label + 3 arrow segments.
        let cut_step = (1.2_f32 / (3.0 / 18.0)).ceil() as usize;
        assert_eq!(
            out.len() / 2,
            3 + (cut_step - 1) + 5 + UP_LABEL_SEGMENTS + 3
        );
        // The arrow points up the run (a→b, +x here) and starts past the label.
        let n = out.len();
        let label = &out[n - 6 - 2 * UP_LABEL_SEGMENTS..n - 6];
        let (start, tip) = (out[n - 6], out[n - 5]);
        assert!(tip.x > start.x + 0.3);
        assert!(label.iter().all(|p| p.x < start.x + 1e-4 && p.x > 0.0));
        // Nothing past the cut line.
        let x_cut = 4.0 * cut_step as f32 / 18.0;
        assert!(out.iter().all(|p| p.x <= x_cut + 0.3));
    }

    #[test]
    fn window_is_parallel_lines_not_an_arc() {
        let mut out = Vec::new();
        window_symbol(&frame(), &mut out);
        assert_eq!(out.len(), 12);
        for pair in out.chunks(2).skip(2) {
            assert!((pair[0].z - pair[1].z).abs() < 1e-6);
        }
    }
}
