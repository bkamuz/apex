//! Room-name placement that keeps tags off grid lines.

use glam::Vec3;

use crate::space::{Space, SpaceOverlay};

use super::Project;

/// A room tag closer than this to a grid line reads as sitting on it.
const CLEAR: f32 = 0.45;

fn dist_to_line_xz(p: Vec3, a: Vec3, b: Vec3) -> Option<(f32, Vec3)> {
    let d = Vec3::new(b.x - a.x, 0.0, b.z - a.z).try_normalize()?;
    let n = Vec3::new(-d.z, 0.0, d.x);
    let off = (Vec3::new(p.x - a.x, 0.0, p.z - a.z)).dot(n);
    Some((off.abs(), if off >= 0.0 { n } else { -n }))
}

fn inside(poly: &[Vec3], p: Vec3) -> bool {
    let mut c = false;
    let n = poly.len();
    for i in 0..n {
        let (a, b) = (poly[i], poly[(i + n - 1) % n]);
        if (a.z > p.z) != (b.z > p.z) && p.x < (b.x - a.x) * (p.z - a.z) / (b.z - a.z) + a.x {
            c = !c;
        }
    }
    c
}

impl Project {
    /// A space's overlay with its labels nudged clear of grid axes.
    pub fn space_overlay(&self, space: &Space) -> SpaceOverlay {
        let work_plane = self.work_plane(space.level_id);
        let mut overlay = space.overlay_geometry(&work_plane).unwrap_or_default();
        let axes: Vec<(Vec3, Vec3)> = self
            .document()
            .grid_axes()
            .filter_map(|axis| {
                let pts = axis.placement.anchors();
                (pts.len() >= 2).then(|| (pts[0], pts[pts.len() - 1]))
            })
            .collect();
        let poly = space.placement.anchors();
        let clearance = |p: Vec3| {
            axes.iter()
                .filter_map(|(a, b)| dist_to_line_xz(p, *a, *b).map(|d| d.0))
                .fold(f32::MAX, f32::min)
        };
        for label in &mut overlay.labels {
            for _ in 0..2 {
                let p = label.position;
                let Some((d, away)) = axes
                    .iter()
                    .filter_map(|(a, b)| dist_to_line_xz(p, *a, *b))
                    .min_by(|x, y| x.0.total_cmp(&y.0))
                else {
                    break;
                };
                if d >= CLEAR {
                    break;
                }
                let candidates = [p + away * (CLEAR * 1.6 - d), p - away * (CLEAR * 1.6 + d)];
                let best = candidates
                    .into_iter()
                    .filter(|c| poly.len() < 3 || inside(&poly, *c))
                    .max_by(|x, y| clearance(*x).total_cmp(&clearance(*y)));
                match best {
                    Some(c) => label.position = c,
                    None => break,
                }
            }
        }
        overlay
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::param::ParamMap;
    use crate::placement::Placement;

    #[test]
    fn label_moves_off_a_grid_line_but_stays_in_the_room() {
        let mut p = Project::new();
        p.create_grid_axis(
            Placement::line(Vec3::new(-2.0, 0.0, 4.0), Vec3::new(12.0, 0.0, 4.0)),
            ParamMap::new(),
        )
        .expect("axis");
        let pts = [
            Vec3::new(0.0, 0.0, 0.0),
            Vec3::new(5.0, 0.0, 0.0),
            Vec3::new(5.0, 0.0, 8.0),
            Vec3::new(0.0, 0.0, 8.0),
        ];
        let placement = crate::placement::PlacementKind::Polyline
            .build(&pts, 0.0, &apex_geometry::Frame::horizontal(0.0))
            .expect("placement");
        let id = p.create_space(placement, ParamMap::new()).expect("space");
        let space = p.document().get_space(id).unwrap().clone();
        let label = p.space_overlay(&space).labels[0].position;
        assert!((label.z - 4.0).abs() >= CLEAR - 1e-4, "{label:?}");
        assert!(label.z > 0.0 && label.z < 8.0);
    }
}
