//! Drawn 2D profiles: vertices plus length dimensions on edges.
//!
//! This is not a full constraint solver. The first vertex stays put; each
//! following vertex is the previous plus either the drawn offset or
//! `param * unit(drawn edge)`. Closed polygons close geometrically (the last
//! point is not duplicated). A dimension on the closing edge is stored for the
//! editor but does not add a vertex.

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

/// Authoring source for a mouse-drawn profile.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProfileSketch {
    /// Seed vertices in profile XY (metres), in draw order.
    pub vertices: Vec<[f32; 2]>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dimensions: Vec<SketchDimension>,
}

impl ProfileSketch {
    pub fn new(vertices: Vec<[f32; 2]>) -> Self {
        Self {
            vertices,
            dimensions: Vec::new(),
        }
    }

    pub fn param_for_edge(&self, edge: usize) -> Option<&ParamId> {
        self.dimensions
            .iter()
            .rev()
            .find(|dim| dim.edge as usize == edge)
            .map(|dim| &dim.param)
    }

    pub fn referenced_params(&self) -> Vec<ParamId> {
        let mut out: Vec<_> = self
            .dimensions
            .iter()
            .map(|dim| dim.param.clone())
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
            let [ox, oy] = edge_offset(a, b, self.param_for_edge(i));
            let x = points[i][0].clone() + ox;
            let y = points[i][1].clone() + oy;
            points.push([x, y]);
        }

        Ok(ProfileSpec::Polygon { points })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SketchError {
    #[error("a sketch needs at least 3 vertices, got {0}")]
    TooSmall(usize),
}

fn edge_offset(a: [f32; 2], b: [f32; 2], param: Option<&ParamId>) -> [Expr; 2] {
    let dx = (b[0] - a[0]) as f64;
    let dy = (b[1] - a[1]) as f64;
    let len = (dx * dx + dy * dy).sqrt();
    match param {
        Some(id) if len > 1e-9 => [
            Expr::param(id) * Expr::constant(dx / len),
            Expr::param(id) * Expr::constant(dy / len),
        ],
        _ => [Expr::constant(dx), Expr::constant(dy)],
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
}
