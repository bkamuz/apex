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
            let anchors = wall.placement.anchors();
            let dir = match anchors.as_slice() {
                [a, b, ..] => Vec3::new(b.x - a.x, 0.0, b.z - a.z),
                _ => Vec3::X,
            };
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

/// Leaf drawn open at 90° from the hinge jamb plus a quarter-circle swing.
fn door_symbol(f: &OpeningFrame, out: &mut Vec<Vec3>) {
    let half_t = f.wall_thickness * 0.5;
    let hinge = f.center - f.along * (f.width * 0.5) + f.across * half_t;
    let leaf_end = hinge + f.across * f.width;
    push(out, hinge, leaf_end);
    let mut prev = hinge + f.along * f.width;
    for i in 1..=ARC_SEGMENTS {
        let t = (i as f32 / ARC_SEGMENTS as f32) * std::f32::consts::FRAC_PI_2;
        let next = hinge + (f.along * t.cos() + f.across * t.sin()) * f.width;
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
    fn window_is_parallel_lines_not_an_arc() {
        let mut out = Vec::new();
        window_symbol(&frame(), &mut out);
        assert_eq!(out.len(), 12);
        for pair in out.chunks(2).skip(2) {
            assert!((pair[0].z - pair[1].z).abs() < 1e-6);
        }
    }
}
