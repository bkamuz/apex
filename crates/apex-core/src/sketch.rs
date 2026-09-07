//! Drawn 2D profiles: vertices, length dimensions, and sketch constraints.
//!
//! This is not a full constraint solver. The first vertex stays put; each
//! following vertex is the previous plus either the drawn offset or
//! `param * unit(drawn edge)`. Closed polygons close geometrically (the last
//! point is not duplicated). A dimension on the closing edge is stored for the
//! editor but does not add a vertex.
//!
//! [`SketchConstraint`] adds equal-length groups and horizontal / vertical locks
//! that compile into the same parametric [`ProfileSpec::Polygon`] path.

use serde::{Deserialize, Serialize};

use crate::component::ProfileSpec;
use crate::expr::Expr;
use crate::param::ParamId;

/// Length dimension on one edge of a sketch, bound to a profile parameter.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SketchDimension {
    /// Edge `i` runs from vertex `i` to vertex `(i + 1) % n`.
    pub edge: u32,
    pub param: ParamId,
}

/// CAD-style constraint on sketch edges (MVP-A: equal length, horizontal, vertical).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SketchConstraint {
    /// Two or more edges share one length parameter.
    EqualLength {
        edges: Vec<u32>,
        param: ParamId,
    },
    /// Edge direction is locked to ±X; length still driven by a dimension when present.
    Horizontal {
        edge: u32,
    },
    /// Edge direction is locked to ±Y; length still driven by a dimension when present.
    Vertical {
        edge: u32,
    },
}

/// Authoring source for a mouse-drawn profile.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProfileSketch {
    /// Seed vertices in profile XY (metres), in draw order.
    pub vertices: Vec<[f32; 2]>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dimensions: Vec<SketchDimension>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub constraints: Vec<SketchConstraint>,
}

impl ProfileSketch {
    pub fn new(vertices: Vec<[f32; 2]>) -> Self {
        Self {
            vertices,
            dimensions: Vec::new(),
            constraints: Vec::new(),
        }
    }

    pub fn param_for_edge(&self, edge: usize) -> Option<&ParamId> {
        self.dimensions
            .iter()
            .rev()
            .find(|dim| dim.edge as usize == edge)
            .map(|dim| &dim.param)
            .or_else(|| self.equal_length_param(edge))
    }

    fn equal_length_param(&self, edge: usize) -> Option<&ParamId> {
        self.constraints.iter().find_map(|constraint| {
            if let SketchConstraint::EqualLength { edges, param } = constraint {
                edges.iter().any(|e| *e as usize == edge).then_some(param)
            } else {
                None
            }
        })
    }

    fn orientation_for_edge(&self, edge: usize) -> EdgeOrientation {
        for constraint in &self.constraints {
            match constraint {
                SketchConstraint::Horizontal { edge: e } if *e as usize == edge => {
                    return EdgeOrientation::Horizontal;
                }
                SketchConstraint::Vertical { edge: e } if *e as usize == edge => {
                    return EdgeOrientation::Vertical;
                }
                _ => {}
            }
        }
        EdgeOrientation::Free
    }

    pub fn referenced_params(&self) -> Vec<ParamId> {
        let mut out: Vec<_> = self
            .dimensions
            .iter()
            .map(|dim| dim.param.clone())
            .chain(self.constraints.iter().filter_map(|constraint| {
                if let SketchConstraint::EqualLength { param, .. } = constraint {
                    Some(param.clone())
                } else {
                    None
                }
            }))
            .collect();
        out.sort();
        out.dedup();
        out
    }

    /// Compile the walk into a parametric polygon. Requires at least 3 vertices.
    pub fn to_profile_spec(&self) -> Result<ProfileSpec, SketchError> {
        let n = self.vertices.len();
        if n < 3 {
            return Err(SketchError::TooSmall(n));
        }

        let mut points: Vec<[Expr; 2]> = Vec::with_capacity(n);
        let origin = self.vertices[0];
        points.push([
            Expr::constant(origin[0] as f64),
            Expr::constant(origin[1] as f64),
        ]);

        for i in 0..n - 1 {
            let a = self.vertices[i];
            let b = self.vertices[i + 1];
            let [ox, oy] = edge_offset(
                a,
                b,
                self.param_for_edge(i),
                self.orientation_for_edge(i),
            );
            let x = points[i][0].clone() + ox;
            let y = points[i][1].clone() + oy;
            points.push([x, y]);
        }

        Ok(ProfileSpec::Polygon { points })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EdgeOrientation {
    Free,
    Horizontal,
    Vertical,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SketchError {
    #[error("a sketch needs at least 3 vertices, got {0}")]
    TooSmall(usize),
}

fn edge_offset(
    a: [f32; 2],
    b: [f32; 2],
    param: Option<&ParamId>,
    orientation: EdgeOrientation,
) -> [Expr; 2] {
    let dx = (b[0] - a[0]) as f64;
    let dy = (b[1] - a[1]) as f64;
    let len = (dx * dx + dy * dy).sqrt();

    match orientation {
        EdgeOrientation::Horizontal => {
            let sign = if dx >= 0.0 { 1.0 } else { -1.0 };
            match param {
                Some(id) if len > 1e-9 => [
                    Expr::param(id) * Expr::constant(sign),
                    Expr::constant(0.0),
                ],
                _ => [Expr::constant(dx), Expr::constant(0.0)],
            }
        }
        EdgeOrientation::Vertical => {
            let sign = if dy >= 0.0 { 1.0 } else { -1.0 };
            match param {
                Some(id) if len > 1e-9 => [
                    Expr::constant(0.0),
                    Expr::param(id) * Expr::constant(sign),
                ],
                _ => [Expr::constant(0.0), Expr::constant(dy)],
            }
        }
        EdgeOrientation::Free => match param {
            Some(id) if len > 1e-9 => [
                Expr::param(id) * Expr::constant(dx / len),
                Expr::param(id) * Expr::constant(dy / len),
            ],
            _ => [Expr::constant(dx), Expr::constant(dy)],
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::param::{ParamMap, ParamValue};

    const EPS: f32 = 1e-4;

    fn rect_sketch() -> ProfileSketch {
        ProfileSketch {
            vertices: vec![[-0.1, -1.5], [0.1, -1.5], [0.1, 1.5], [-0.1, 1.5]],
            dimensions: vec![
                SketchDimension {
                    edge: 0,
                    param: "thickness".into(),
                },
                SketchDimension {
                    edge: 1,
                    param: "height".into(),
                },
                SketchDimension {
                    edge: 2,
                    param: "thickness".into(),
                },
            ],
            constraints: vec![
                SketchConstraint::Horizontal { edge: 0 },
                SketchConstraint::Horizontal { edge: 2 },
                SketchConstraint::Vertical { edge: 1 },
                SketchConstraint::Vertical { edge: 3 },
            ],
        }
    }

    #[test]
    fn a_dimensioned_rectangle_evaluates_to_the_param_sizes() {
        let spec = rect_sketch().to_profile_spec().expect("spec");
        let params = ParamMap::new()
            .with("thickness", ParamValue::Length(0.2))
            .with("height", ParamValue::Length(3.0));
        let profile = spec
            .evaluate(&params, &Default::default())
            .expect("profile");
        let (min, max) = profile.bounds();
        assert!(
            (max[0] - min[0] - 0.2).abs() < EPS,
            "width {}",
            max[0] - min[0]
        );
        assert!(
            (max[1] - min[1] - 3.0).abs() < EPS,
            "height {}",
            max[1] - min[1]
        );
    }

    #[test]
    fn changing_a_dimension_resizes_that_edge() {
        let spec = rect_sketch().to_profile_spec().expect("spec");
        let params = ParamMap::new()
            .with("thickness", ParamValue::Length(0.5))
            .with("height", ParamValue::Length(3.0));
        let profile = spec
            .evaluate(&params, &Default::default())
            .expect("profile");
        let (min, max) = profile.bounds();
        assert!((max[0] - min[0] - 0.5).abs() < EPS);
        assert!((max[1] - min[1] - 3.0).abs() < EPS);
    }

    #[test]
    fn fewer_than_three_vertices_is_refused() {
        let sketch = ProfileSketch::new(vec![[0.0, 0.0], [1.0, 0.0]]);
        assert_eq!(sketch.to_profile_spec(), Err(SketchError::TooSmall(2)));
    }

    #[test]
    fn an_undimensioned_edge_keeps_its_drawn_offset() {
        let sketch = ProfileSketch {
            vertices: vec![[0.0, 0.0], [2.0, 0.0], [2.0, 1.0]],
            dimensions: vec![SketchDimension {
                edge: 0,
                param: "span".into(),
            }],
            constraints: vec![SketchConstraint::Horizontal { edge: 0 }],
        };
        let spec = sketch.to_profile_spec().expect("spec");
        let params = ParamMap::new().with("span", ParamValue::Length(4.0));
        let profile = spec
            .evaluate(&params, &Default::default())
            .expect("profile");
        let (min, max) = profile.bounds();
        assert!((max[0] - min[0] - 4.0).abs() < EPS, "driven base");
        assert!((max[1] - min[1] - 1.0).abs() < EPS, "drawn height stays");
    }

    #[test]
    fn referenced_params_are_unique() {
        let params = rect_sketch().referenced_params();
        assert_eq!(params, vec!["height".to_string(), "thickness".to_string()]);
    }

    #[test]
    fn horizontal_lock_zeros_vertical_offset_even_without_a_dimension() {
        let sketch = ProfileSketch {
            vertices: vec![[0.0, 0.0], [1.0, 0.2], [1.0, 1.0]],
            dimensions: vec![],
            constraints: vec![SketchConstraint::Horizontal { edge: 0 }],
        };
        let spec = sketch.to_profile_spec().expect("spec");
        let profile = spec
            .evaluate(&ParamMap::new(), &Default::default())
            .expect("profile");
        let pts = profile.outer();
        assert!((pts[1][1] - 0.0).abs() < EPS, "second vertex stays on axis");
    }

    #[test]
    fn vertical_lock_zeros_horizontal_offset_with_a_length_param() {
        let sketch = ProfileSketch {
            vertices: vec![[0.0, 0.0], [0.1, 2.0], [1.0, 2.0]],
            dimensions: vec![SketchDimension {
                edge: 1,
                param: "rise".into(),
            }],
            constraints: vec![SketchConstraint::Vertical { edge: 1 }],
        };
        let spec = sketch.to_profile_spec().expect("spec");
        let params = ParamMap::new().with("rise", ParamValue::Length(3.5));
        let profile = spec.evaluate(&params, &Default::default()).expect("profile");
        let pts = profile.outer();
        assert!((pts[2][0] - pts[1][0]).abs() < EPS, "vertical edge keeps x");
        assert!((pts[2][1] - pts[1][1] - 3.5).abs() < EPS, "param drives length");
    }

    #[test]
    fn equal_length_constraint_shares_one_param_across_edges() {
        let sketch = ProfileSketch {
            vertices: vec![[0.0, 0.0], [1.0, 0.0], [1.5, 0.5], [0.5, 0.5]],
            dimensions: vec![],
            constraints: vec![SketchConstraint::EqualLength {
                edges: vec![0, 2],
                param: "side".into(),
            }],
        };
        let spec = sketch.to_profile_spec().expect("spec");
        let params = ParamMap::new().with("side", ParamValue::Length(2.0));
        let profile = spec.evaluate(&params, &Default::default()).expect("profile");
        let pts = profile.outer();
        let len0 = ((pts[1][0] - pts[0][0]).powi(2) + (pts[1][1] - pts[0][1]).powi(2)).sqrt();
        let len2 = ((pts[3][0] - pts[2][0]).powi(2) + (pts[3][1] - pts[2][1]).powi(2)).sqrt();
        assert!((len0 - 2.0).abs() < EPS, "edge 0 length {len0}");
        assert!((len2 - 2.0).abs() < EPS, "edge 2 length {len2}");
    }

    #[test]
    fn changing_equal_length_param_resizes_all_linked_edges() {
        let sketch = ProfileSketch {
            vertices: vec![[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]],
            dimensions: vec![],
            constraints: vec![
                SketchConstraint::EqualLength {
                    edges: vec![0, 2],
                    param: "width".into(),
                },
                SketchConstraint::Horizontal { edge: 0 },
                SketchConstraint::Horizontal { edge: 2 },
                SketchConstraint::Vertical { edge: 1 },
                SketchConstraint::Vertical { edge: 3 },
            ],
        };
        let spec = sketch.to_profile_spec().expect("spec");
        let params = ParamMap::new().with("width", ParamValue::Length(0.6));
        let profile = spec.evaluate(&params, &Default::default()).expect("profile");
        let (min, max) = profile.bounds();
        assert!((max[0] - min[0] - 0.6).abs() < EPS);
    }
}
