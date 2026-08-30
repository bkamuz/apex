//! Where an element sits, and how its local coordinate system is derived.
//!
//! A placement stores only the anchors the user actually picked. Orientation is
//! never stored: it is computed by [`Placement::frame_at`], which is the single
//! source of "which way is this element facing" in the whole system. Keeping a
//! `Frame` on an anchor would duplicate what the curve already says and drift
//! away from it on the first edit.

use apex_geometry::{Curve, Frame, MIN_CURVE_LENGTH};
use glam::Vec3;
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum PlacementError {
    #[error("{kind} placement needs {expected} points, got {got}")]
    WrongPointCount {
        kind: &'static str,
        expected: &'static str,
        got: usize,
    },
    #[error("the picked points are degenerate for a {0} placement")]
    Degenerate(&'static str),
}

/// The input gesture a component is placed with. Drives which generic tool the
/// UI offers, so a new component needs no new tool code.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlacementKind {
    /// One pick plus a rotation about the work plane normal.
    Point,
    /// Two picks spanning a straight line.
    TwoPoint,
    /// Three picks: start, a point on the arc, end.
    ThreePointArc,
    /// Any number of picks forming a chain.
    Polyline,
    /// Any curve. The tool chooses line, arc, or polyline per placement.
    ///
    /// `build` infers line from two picks and polyline from three or more; it
    /// never infers an arc, because three picks are also a polyline in progress.
    /// Pass [`ThreePointArc`] explicitly when the user asked for an arc.
    Path,
    /// No picking; the frame is supplied directly.
    Free,
}

impl PlacementKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Point => "point",
            Self::TwoPoint => "two_point",
            Self::ThreePointArc => "three_point_arc",
            Self::Polyline => "polyline",
            Self::Path => "path",
            Self::Free => "free",
        }
    }

    /// Parse the snake_case name used on the wire and in authored JSON.
    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "point" => Some(Self::Point),
            "two_point" => Some(Self::TwoPoint),
            "three_point_arc" => Some(Self::ThreePointArc),
            "polyline" => Some(Self::Polyline),
            "path" => Some(Self::Path),
            "free" => Some(Self::Free),
            _ => None,
        }
    }

    /// How many picks the gesture needs; `None` means "as many as the user wants".
    pub fn required_points(self) -> Option<usize> {
        match self {
            Self::Point => Some(1),
            Self::TwoPoint => Some(2),
            Self::ThreePointArc => Some(3),
            Self::Polyline | Self::Path => None,
            Self::Free => Some(0),
        }
    }

    /// Turn raw picks into a placement. The bridge from "user clicked" to the model.
    pub fn build(
        self,
        points: &[Vec3],
        rotation: f32,
        work_plane: &Frame,
    ) -> Result<Placement, PlacementError> {
        let wrong = |expected: &'static str| PlacementError::WrongPointCount {
            kind: self.as_str(),
            expected,
            got: points.len(),
        };

        match self {
            Self::Point => {
                let [origin] = points else {
                    return Err(wrong("1"));
                };
                Ok(Placement::Point {
                    origin: *origin,
                    rotation,
                })
            }
            Self::TwoPoint => {
                let [a, b] = points else {
                    return Err(wrong("2"));
                };
                if (*b - *a).length() < MIN_CURVE_LENGTH {
                    return Err(PlacementError::Degenerate(self.as_str()));
                }
                Ok(Placement::Curve {
                    curve: Curve::line(*a, *b),
                })
            }
            Self::ThreePointArc => {
                let [a, b, c] = points else {
                    return Err(wrong("3"));
                };
                let curve = Curve::arc_from_three_points(*a, *b, *c)
                    .ok_or(PlacementError::Degenerate(self.as_str()))?;
                Ok(Placement::Curve { curve })
            }
            Self::Polyline => {
                if points.len() < 2 {
                    return Err(wrong("at least 2"));
                }
                let curve = Curve::Polyline {
                    points: points.to_vec(),
                };
                if curve.length() < MIN_CURVE_LENGTH {
                    return Err(PlacementError::Degenerate(self.as_str()));
                }
                Ok(Placement::Curve { curve })
            }
            Self::Path => match points.len() {
                0 | 1 => Err(wrong("at least 2")),
                2 => Self::TwoPoint.build(points, rotation, work_plane),
                _ => Self::Polyline.build(points, rotation, work_plane),
            },
            Self::Free => Ok(Placement::Free { frame: *work_plane }),
        }
    }

    /// Whether a placement value was produced by this gesture.
    pub fn accepts(self, placement: &Placement) -> bool {
        match (self, placement) {
            (Self::Point, Placement::Point { .. }) => true,
            (Self::Free, Placement::Free { .. }) => true,
            (Self::TwoPoint, Placement::Curve { curve }) => matches!(curve, Curve::Line { .. }),
            (Self::ThreePointArc, Placement::Curve { curve }) => {
                matches!(curve, Curve::Arc { .. } | Curve::Circle { .. })
            }
            (Self::Polyline, Placement::Curve { curve }) => matches!(curve, Curve::Polyline { .. }),
            (Self::Path, Placement::Curve { .. }) => true,
            _ => false,
        }
    }
}

/// The anchors an element was placed with.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Placement {
    /// A single anchor. Orientation comes from the work plane plus `rotation`;
    /// the point itself carries no direction of its own.
    Point { origin: Vec3, rotation: f32 },
    /// Driven by a path. Orientation comes from the tangent.
    Curve { curve: Curve },
    /// An explicit frame, for elements that are not picked in the viewport.
    Free { frame: Frame },
}

impl Placement {
    pub fn point(origin: Vec3) -> Self {
        Self::Point {
            origin,
            rotation: 0.0,
        }
    }

    pub fn line(a: Vec3, b: Vec3) -> Self {
        Self::Curve {
            curve: Curve::line(a, b),
        }
    }

    /// The local coordinate system at `t` along the placement.
    ///
    /// Every recipe orients itself through this one call, which is also the hook
    /// a user-authored reference point would later plug into.
    pub fn frame_at(&self, t: f32, work_plane: &Frame) -> Result<Frame, PlacementError> {
        match self {
            Self::Point { origin, rotation } => {
                Ok(work_plane.rotated(*rotation).with_origin(*origin))
            }
            Self::Curve { curve } => curve
                .frame_at(t, work_plane.z)
                .map_err(|_| PlacementError::Degenerate("curve")),
            Self::Free { frame } => Ok(*frame),
        }
    }

    pub fn curve(&self) -> Option<&Curve> {
        match self {
            Self::Curve { curve } => Some(curve),
            _ => None,
        }
    }

    pub fn origin(&self) -> Vec3 {
        match self {
            Self::Point { origin, .. } => *origin,
            Self::Curve { curve } => curve.start(),
            Self::Free { frame } => frame.origin,
        }
    }

    /// Length along the placement, or `None` for point-like placements.
    pub fn length(&self) -> Option<f32> {
        self.curve().map(|c| c.length())
    }

    /// Coarse family used in mismatch errors: point, curve, or free.
    pub fn family(&self) -> &'static str {
        match self {
            Self::Point { .. } => "point",
            Self::Curve { .. } => "curve",
            Self::Free { .. } => "free",
        }
    }

    /// The concrete gesture that produced this placement.
    ///
    /// Used when re-placing an existing element so a path component keeps its
    /// line as a line and its arc as an arc, instead of re-inferring from
    /// [`PlacementKind::Path`]'s default `build`.
    pub fn source_kind(&self) -> PlacementKind {
        match self {
            Self::Point { .. } => PlacementKind::Point,
            Self::Free { .. } => PlacementKind::Free,
            Self::Curve { curve } => match curve {
                Curve::Line { .. } => PlacementKind::TwoPoint,
                Curve::Arc { .. } | Curve::Circle { .. } => PlacementKind::ThreePointArc,
                Curve::Polyline { .. } => PlacementKind::Polyline,
            },
        }
    }

    /// The picked anchors, for round-tripping to the UI.
    pub fn anchors(&self) -> Vec<Vec3> {
        match self {
            Self::Point { origin, .. } => vec![*origin],
            Self::Curve { curve } => match curve {
                Curve::Line { a, b } => vec![*a, *b],
                Curve::Polyline { points } => points.clone(),
                Curve::Arc { .. } => vec![curve.start(), curve.point_at(0.5), curve.end()],
                Curve::Circle { .. } => vec![curve.start(), curve.point_at(0.5)],
            },
            Self::Free { frame } => vec![frame.origin],
        }
    }

    /// Move every defining point to world `elevation`, keeping the plan shape.
    ///
    /// This is how a level carries its elements when it moves.
    pub fn with_elevation(&self, elevation: f32) -> Self {
        let flatten = |p: Vec3| Vec3::new(p.x, elevation, p.z);
        match self {
            Self::Point { origin, rotation } => Self::Point {
                origin: flatten(*origin),
                rotation: *rotation,
            },
            Self::Curve { curve } => Self::Curve {
                curve: match curve {
                    Curve::Line { a, b } => Curve::Line {
                        a: flatten(*a),
                        b: flatten(*b),
                    },
                    Curve::Polyline { points } => Curve::Polyline {
                        points: points.iter().map(|p| flatten(*p)).collect(),
                    },
                    Curve::Arc {
                        center,
                        normal,
                        radius,
                        start_angle,
                        sweep,
                    } => Curve::Arc {
                        center: flatten(*center),
                        normal: *normal,
                        radius: *radius,
                        start_angle: *start_angle,
                        sweep: *sweep,
                    },
                    Curve::Circle {
                        center,
                        normal,
                        radius,
                    } => Curve::Circle {
                        center: flatten(*center),
                        normal: *normal,
                        radius: *radius,
                    },
                },
            },
            Self::Free { frame } => Self::Free {
                frame: frame.with_origin(flatten(frame.origin)),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const EPS: f32 = 1e-4;

    fn ground() -> Frame {
        Frame::horizontal(0.0)
    }

    #[test]
    fn a_point_gesture_takes_one_pick() {
        let p = PlacementKind::Point
            .build(&[Vec3::new(1.0, 0.0, 2.0)], 0.0, &ground())
            .expect("placement");
        assert_eq!(p, Placement::point(Vec3::new(1.0, 0.0, 2.0)));
        assert_eq!(PlacementKind::Point.required_points(), Some(1));
    }

    #[test]
    fn a_two_point_gesture_builds_a_line() {
        let a = Vec3::ZERO;
        let b = Vec3::new(4.0, 0.0, 0.0);
        let p = PlacementKind::TwoPoint
            .build(&[a, b], 0.0, &ground())
            .expect("placement");
        assert_eq!(p.curve(), Some(&Curve::line(a, b)));
        assert!((p.length().unwrap() - 4.0).abs() < EPS);
    }

    #[test]
    fn a_three_point_gesture_builds_an_arc_through_the_middle_pick() {
        let a = Vec3::new(2.0, 0.0, 0.0);
        let mid = Vec3::new(0.0, 0.0, 2.0);
        let c = Vec3::new(-2.0, 0.0, 0.0);
        let p = PlacementKind::ThreePointArc
            .build(&[a, mid, c], 0.0, &ground())
            .expect("placement");

        let curve = p.curve().expect("curve");
        assert!(matches!(curve, Curve::Arc { .. }));
        assert!((curve.point_at(0.5) - mid).length() < EPS);
    }

    #[test]
    fn the_wrong_number_of_picks_is_rejected() {
        let err = PlacementKind::TwoPoint
            .build(&[Vec3::ZERO], 0.0, &ground())
            .unwrap_err();
        assert_eq!(
            err,
            PlacementError::WrongPointCount {
                kind: "two_point",
                expected: "2",
                got: 1
            }
        );
    }

    #[test]
    fn coincident_picks_are_rejected() {
        assert_eq!(
            PlacementKind::TwoPoint
                .build(&[Vec3::ONE, Vec3::ONE], 0.0, &ground())
                .unwrap_err(),
            PlacementError::Degenerate("two_point")
        );
        assert_eq!(
            PlacementKind::ThreePointArc
                .build(
                    &[
                        Vec3::ZERO,
                        Vec3::new(1.0, 0.0, 0.0),
                        Vec3::new(2.0, 0.0, 0.0)
                    ],
                    0.0,
                    &ground()
                )
                .unwrap_err(),
            PlacementError::Degenerate("three_point_arc"),
            "collinear picks cannot make an arc"
        );
    }

    #[test]
    fn a_point_placement_takes_its_orientation_from_the_work_plane() {
        let p = Placement::point(Vec3::new(1.0, 2.0, 3.0));
        let f = p.frame_at(0.0, &Frame::horizontal(0.0)).expect("frame");
        assert_eq!(f.origin, Vec3::new(1.0, 2.0, 3.0));
        assert_eq!(f.z, Vec3::Y, "extrusion axis is the work plane normal");
    }

    #[test]
    fn rotating_a_point_placement_turns_its_frame_but_not_its_axis() {
        let p = Placement::Point {
            origin: Vec3::ZERO,
            rotation: std::f32::consts::FRAC_PI_2,
        };
        let f = p.frame_at(0.0, &Frame::horizontal(0.0)).expect("frame");
        assert!((f.z - Vec3::Y).length() < EPS, "axis must not move");
        assert!(
            (f.x - (-Vec3::Z)).length() < EPS,
            "a quarter turn should swing local x, got {}",
            f.x
        );
    }

    #[test]
    fn a_curve_placement_takes_its_orientation_from_the_tangent() {
        let p = Placement::line(Vec3::ZERO, Vec3::new(0.0, 0.0, 5.0));
        let f = p.frame_at(0.0, &Frame::horizontal(0.0)).expect("frame");
        assert!((f.z - Vec3::Z).length() < EPS, "z follows the tangent");
        assert!((f.y - Vec3::Y).length() < EPS, "y stays upright");
    }

    #[test]
    fn frame_at_walks_along_the_curve() {
        let p = Placement::line(Vec3::ZERO, Vec3::new(10.0, 0.0, 0.0));
        let start = p.frame_at(0.0, &ground()).unwrap().origin;
        let mid = p.frame_at(0.5, &ground()).unwrap().origin;
        assert_eq!(start, Vec3::ZERO);
        assert_eq!(mid, Vec3::new(5.0, 0.0, 0.0));
    }

    #[test]
    fn anchors_round_trip_the_original_picks() {
        let a = Vec3::new(1.0, 0.0, 1.0);
        let b = Vec3::new(5.0, 0.0, 1.0);
        assert_eq!(Placement::line(a, b).anchors(), vec![a, b]);
        assert_eq!(Placement::point(a).anchors(), vec![a]);

        let mid = Vec3::new(3.0, 0.0, 3.0);
        let arc = PlacementKind::ThreePointArc
            .build(&[a, mid, b], 0.0, &ground())
            .expect("arc");
        let anchors = arc.anchors();
        assert_eq!(anchors.len(), 3);
        assert!((anchors[1] - mid).length() < EPS, "middle pick preserved");
    }

    #[test]
    fn changing_elevation_moves_every_defining_point() {
        let p = Placement::line(Vec3::new(1.0, 0.0, 2.0), Vec3::new(4.0, 0.0, 2.0));
        let moved = p.with_elevation(3.5);
        for anchor in moved.anchors() {
            assert!((anchor.y - 3.5).abs() < EPS, "anchor {anchor} did not move");
        }
        assert_eq!(
            moved.length().unwrap(),
            p.length().unwrap(),
            "the plan shape must survive the move"
        );
    }

    #[test]
    fn changing_elevation_moves_an_arc_without_reshaping_it() {
        let arc = PlacementKind::ThreePointArc
            .build(
                &[
                    Vec3::new(2.0, 0.0, 0.0),
                    Vec3::new(0.0, 0.0, 2.0),
                    Vec3::new(-2.0, 0.0, 0.0),
                ],
                0.0,
                &ground(),
            )
            .expect("arc");
        let moved = arc.with_elevation(4.0);
        assert!((moved.length().unwrap() - arc.length().unwrap()).abs() < EPS);
        assert!((moved.origin().y - 4.0).abs() < EPS);
    }

    #[test]
    fn a_kind_recognizes_the_placements_it_produces() {
        let line = PlacementKind::TwoPoint
            .build(&[Vec3::ZERO, Vec3::X], 0.0, &ground())
            .unwrap();
        assert!(PlacementKind::TwoPoint.accepts(&line));
        assert!(!PlacementKind::Point.accepts(&line));
        assert!(!PlacementKind::ThreePointArc.accepts(&line));
        assert!(PlacementKind::Path.accepts(&line));
        assert!(!PlacementKind::Path.accepts(&Placement::point(Vec3::ZERO)));
    }

    #[test]
    fn path_infers_a_line_from_two_picks_and_a_polyline_from_more() {
        let a = Vec3::ZERO;
        let b = Vec3::new(4.0, 0.0, 0.0);
        let c = Vec3::new(4.0, 0.0, 3.0);
        let line = PlacementKind::Path
            .build(&[a, b], 0.0, &ground())
            .expect("line");
        assert!(matches!(line.curve(), Some(Curve::Line { .. })));
        assert_eq!(line.source_kind(), PlacementKind::TwoPoint);

        let poly = PlacementKind::Path
            .build(&[a, b, c], 0.0, &ground())
            .expect("polyline");
        assert!(
            matches!(poly.curve(), Some(Curve::Polyline { .. })),
            "three picks must not become an arc; that gesture is explicit"
        );
        assert_eq!(poly.source_kind(), PlacementKind::Polyline);
        assert_eq!(PlacementKind::Path.required_points(), None);
    }

    #[test]
    fn from_name_round_trips_every_kind() {
        for kind in [
            PlacementKind::Point,
            PlacementKind::TwoPoint,
            PlacementKind::ThreePointArc,
            PlacementKind::Polyline,
            PlacementKind::Path,
            PlacementKind::Free,
        ] {
            assert_eq!(PlacementKind::from_name(kind.as_str()), Some(kind));
        }
        assert_eq!(PlacementKind::from_name("nope"), None);
    }

    #[test]
    fn placements_round_trip_through_json() {
        let p = Placement::line(Vec3::new(1.0, 0.0, 2.0), Vec3::new(3.0, 0.0, 4.0));
        let json = serde_json::to_string(&p).expect("serialize");
        assert!(json.contains(r#""kind":"curve""#), "json was {json}");
        assert!(json.contains("[1.0,0.0,2.0]"), "points stay plain: {json}");
        assert_eq!(serde_json::from_str::<Placement>(&json).unwrap(), p);

        let p = Placement::Point {
            origin: Vec3::new(1.0, 2.0, 3.0),
            rotation: 0.5,
        };
        assert_eq!(
            serde_json::from_str::<Placement>(&serde_json::to_string(&p).unwrap()).unwrap(),
            p
        );
    }
}
