//! Parametric solid booleans between arbitrary elements.
//!
//! An `apex.boolean` element names two operand elements and an operation.
//! Its mesh is recomputed from the operands' live meshes (general mesh CSG,
//! any closed solid: arc walls, roofs, beams, components), and the operands
//! themselves stop rendering while they are consumed. Editing an operand,
//! the boolean, or deleting either recomputes through `solid_dependents`,
//! so undo/redo restore everything via the normal snapshot path.

use apex_geometry::{mesh_boolean, BooleanOp, TriangleMesh};

use crate::element::{Element, ElementId};
use crate::param::ParamMap;

use super::Project;

pub(crate) const BOOLEAN: &str = "apex.boolean";
const MAX_DEPTH: usize = 16;

pub(crate) fn boolean_operands(element: &Element) -> Option<(ElementId, ElementId, BooleanOp)> {
    if element.component_id != BOOLEAN {
        return None;
    }
    let a = element.params.text("operand_a")?.parse().ok()?;
    let b = element.params.text("operand_b")?.parse().ok()?;
    let op = match element.params.text("operation").unwrap_or("subtract") {
        "union" => BooleanOp::Union,
        "intersect" => BooleanOp::Intersect,
        _ => BooleanOp::Subtract,
    };
    Some((a, b, op))
}

/// Params for a new boolean element.
pub fn boolean_params(a: ElementId, b: ElementId, operation: &str) -> ParamMap {
    use crate::param::ParamValue;
    let mut p = ParamMap::default();
    p.set("operand_a", ParamValue::Text(a.to_string()));
    p.set("operand_b", ParamValue::Text(b.to_string()));
    p.set("operation", ParamValue::Choice(operation.to_string()));
    p
}

impl Project {
    /// Boolean elements that consume `id` as an operand.
    pub(crate) fn boolean_consumers(&self, id: ElementId) -> Vec<ElementId> {
        self.document
            .elements()
            .filter(|e| {
                boolean_operands(e).is_some_and(|(a, b, _)| (a == id || b == id) && e.id != id)
            })
            .map(|e| e.id)
            .collect()
    }

    /// True when a boolean consumes `id` and none of its consumers asks to
    /// show its operands (so they can be picked and edited in place).
    pub(crate) fn boolean_hides(&self, id: ElementId) -> bool {
        let consumers = self.boolean_consumers(id);
        !consumers.is_empty()
            && consumers.iter().all(|c| {
                self.document
                    .get_element(*c)
                    .and_then(|e| e.params.bool("show_operands"))
                    != Some(true)
            })
    }

    /// Everything whose mesh depends on `element` through booleans: the
    /// booleans consuming it (transitively), and a boolean's own operands
    /// (they hide or show as it comes and goes).
    pub(crate) fn boolean_dependents(&self, element: &Element) -> Vec<ElementId> {
        let mut out = Vec::new();
        let mut stack = vec![element.id];
        while let Some(id) = stack.pop() {
            for c in self.boolean_consumers(id) {
                if !out.contains(&c) && out.len() < 256 {
                    out.push(c);
                    stack.push(c);
                }
            }
        }
        if let Some((a, b, _)) = boolean_operands(element) {
            out.extend([a, b]);
            // Join neighbours of an operand re-render too: whether they
            // keep the faces shared with it depends on it being consumed.
            for op in [a, b] {
                if let Some(el) = self.document().get_element(op) {
                    if self.joinable(el) {
                        out.extend(self.join_candidates(el));
                    }
                }
            }
        }
        out
    }

    /// The mesh an operand contributes (its own geometry, even while hidden).
    fn operand_mesh(&self, id: ElementId, depth: usize, unpinch: bool) -> TriangleMesh {
        let Some(el) = self.document.get_element(id) else {
            return TriangleMesh::empty();
        };
        if depth >= MAX_DEPTH {
            return TriangleMesh::empty();
        }
        if el.component_id == BOOLEAN {
            return self.boolean_mesh_at(el, depth + 1);
        }
        let closed = if unpinch {
            self.closed_operand_mesh(el)
        } else {
            self.closed_solid_mesh(el)
        };
        if let Some(closed) = closed {
            return closed;
        }
        self.build_uncombined_mesh(el).unwrap_or_default()
    }

    fn boolean_mesh_at(&self, element: &Element, depth: usize) -> TriangleMesh {
        let Some((a, b, op)) = boolean_operands(element) else {
            return TriangleMesh::empty();
        };
        if a == element.id || b == element.id {
            return TriangleMesh::empty();
        }
        // A failed kernel call (non-closed operand) degrades to A unchanged
        // rather than losing geometry. A join can pinch an operand at one
        // plan vertex, which the kernel rejects or mis-cuts: retry with the
        // pinch opened.
        let run = |unpinch: bool| {
            let ma = self.operand_mesh(a, depth, unpinch);
            let mb = self.operand_mesh(b, depth, unpinch);
            let r = mesh_boolean(&ma, &mb, op)
                .ok()
                .filter(apex_geometry::is_closed);
            (r, ma)
        };
        match run(false) {
            (Some(r), _) => r,
            (None, ma) => run(true).0.unwrap_or(ma),
        }
    }

    pub(crate) fn boolean_mesh(&self, element: &Element) -> TriangleMesh {
        self.boolean_mesh_at(element, 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::placement::Placement;
    use apex_geometry::{is_watertight, mesh_volume};
    use glam::Vec3;

    fn wall(p: &mut Project, a: Vec3, b: Vec3) -> ElementId {
        p.create_element("apex.wall", Placement::line(a, b), ParamMap::default())
            .expect("wall")
    }

    fn column(p: &mut Project, at: Vec3) -> ElementId {
        p.create_element("apex.column", Placement::point(at), ParamMap::default())
            .expect("column")
    }

    fn vol(p: &Project, id: ElementId) -> f64 {
        mesh_volume(p.document().get_mesh(id).expect("mesh"))
    }

    #[test]
    fn joined_wall_with_door_minus_column_cuts() {
        // Joined walls render open at the join (shared faces are dropped);
        // the boolean must still see a closed operand and actually cut.
        let mut p = Project::new();
        let s = wall(&mut p, Vec3::ZERO, Vec3::new(6.0, 0.0, 0.0));
        wall(&mut p, Vec3::new(6.0, 0.0, 0.0), Vec3::new(6.0, 0.0, 5.0));
        wall(&mut p, Vec3::new(3.5, 0.0, 0.0), Vec3::new(3.5, 0.0, 5.0));
        p.create_element_with_parent(
            "apex.door",
            Placement::point(Vec3::new(1.6, 0.0, 0.0)),
            ParamMap::default(),
            Some(s),
        )
        .expect("door");
        let c = column(&mut p, Vec3::new(5.0, 0.0, 0.0));
        let b = p
            .create_element(
                BOOLEAN,
                Placement::point(Vec3::ZERO),
                boolean_params(s, c, "subtract"),
            )
            .expect("boolean");
        let m = p.document().get_mesh(b).unwrap();
        assert!(is_watertight(m));
        let before = mesh_volume(
            &p.closed_solid_mesh(p.document().get_element(s).unwrap())
                .unwrap(),
        );
        let after = mesh_volume(m);
        assert!(after < before - 1e-3, "{after} vs {before}");
    }

    #[test]
    fn subtract_is_parametric_hides_operands_and_undoes() {
        let mut p = Project::new();
        let w = wall(&mut p, Vec3::ZERO, Vec3::new(4.0, 0.0, 0.0));
        let c = column(&mut p, Vec3::new(2.0, 0.0, 0.0));
        let wall_v = vol(&p, w);
        let col_v = vol(&p, c);
        assert!(wall_v > 0.0 && col_v > 0.0);
        let b = p
            .create_element(
                BOOLEAN,
                Placement::point(Vec3::ZERO),
                boolean_params(w, c, "subtract"),
            )
            .expect("boolean");
        let m = p.document().get_mesh(b).unwrap().clone();
        assert!(is_watertight(&m));
        let v = mesh_volume(&m);
        assert!(
            v < wall_v - 1e-4 && v > wall_v - col_v - 1e-4,
            "{v} {wall_v} {col_v}"
        );
        // Operands are consumed: they no longer render.
        assert!(p.document().get_mesh(w).unwrap().is_empty());
        assert!(p.document().get_mesh(c).unwrap().is_empty());
        // Move the column off the wall: the boolean recomputes.
        p.update_element(
            c,
            None,
            Some(Placement::point(Vec3::new(2.0, 0.0, 3.0))),
            true,
        )
        .expect("move");
        assert!((vol(&p, b) - wall_v).abs() < 1e-3, "{}", vol(&p, b));
        p.undo().unwrap();
        assert!((vol(&p, b) - v).abs() < 1e-3);
        // Switch to union / intersect via params.
        for (op, check) in [("union", wall_v + col_v), ("intersect", wall_v + col_v - v)] {
            p.update_element(b, Some(boolean_params(w, c, op)), None, true)
                .expect("op");
            let r = p.document().get_mesh(b).unwrap();
            assert!(is_watertight(r), "{op}");
            assert!(mesh_volume(r) <= check + 1e-3, "{op}");
        }
        // Deleting the boolean brings the operands back.
        p.delete_element(b);
        assert!((vol(&p, w) - wall_v).abs() < 1e-3);
        assert!((vol(&p, c) - col_v).abs() < 1e-3);
        p.undo().unwrap();
        assert!(p.document().get_mesh(w).unwrap().is_empty());
        assert!(!p.document().get_mesh(b).unwrap().is_empty());
        // "Show operands" brings them back for picking; the result stays.
        let mut shown = boolean_params(w, c, "subtract");
        shown.set("show_operands", crate::param::ParamValue::Bool(true));
        p.update_element(b, Some(shown), None, true).expect("show");
        assert!((vol(&p, w) - wall_v).abs() < 1e-3);
        assert!(!p.document().get_mesh(b).unwrap().is_empty());
        p.undo().unwrap();
        assert!(p.document().get_mesh(w).unwrap().is_empty());
    }

    #[test]
    fn arc_wall_minus_column_is_watertight() {
        let mut p = Project::new();
        let w = p
            .create_element(
                "apex.wall",
                Placement::Curve {
                    curve: apex_geometry::Curve::arc_from_three_points(
                        Vec3::new(3.0, 0.0, 0.0),
                        Vec3::new(0.0, 0.0, 3.0),
                        Vec3::new(-3.0, 0.0, 0.0),
                    )
                    .expect("arc"),
                },
                ParamMap::default(),
            )
            .expect("arc wall");
        let c = column(&mut p, Vec3::new(0.0, 0.0, 3.0));
        let wall_v = vol(&p, w);
        let b = p
            .create_element(
                BOOLEAN,
                Placement::point(Vec3::ZERO),
                boolean_params(w, c, "subtract"),
            )
            .expect("boolean");
        let m = p.document().get_mesh(b).unwrap();
        assert!(is_watertight(m));
        assert!(mesh_volume(m) < wall_v - 1e-4);
    }
}
