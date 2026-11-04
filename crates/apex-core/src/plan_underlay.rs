//! Linked DXF (or other CAD) plan underlays — non-editable reference geometry.
//!
//! Stored as parsed world-XZ polylines plus a 2D transform (origin, rotation,
//! scale). Never explode into walls/fences; snap-to-underlay is a later phase.

use std::collections::BTreeMap;
use std::str::FromStr;

use glam::Vec3;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use crate::dxf_import::{parse_dxf_r12, DxfImportError, ParsedDxf, ParsedPolyline};
use crate::param::{ParamBinding, ParamKind, ParamMap, ParamSpec, ParamValue};

pub type PlanUnderlayLibrary = BTreeMap<PlanUnderlayId, PlanUnderlay>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct PlanUnderlayId(Uuid);

impl PlanUnderlayId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for PlanUnderlayId {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Display for PlanUnderlayId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl FromStr for PlanUnderlayId {
    type Err = uuid::Error;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Ok(Self(Uuid::parse_str(s)?))
    }
}

#[derive(Debug, Clone, PartialEq, Error)]
pub enum PlanUnderlayError {
    #[error(transparent)]
    Dxf(#[from] DxfImportError),
    #[error("underlay '{0}' not found")]
    NotFound(String),
}

/// One polyline of underlay geometry in **metres**, DXF-XY already mapped to
/// local underlay XZ (before origin/rotation/scale on the underlay).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UnderlayPolyline {
    pub layer: String,
    pub closed: bool,
    /// Local points as [x, z] metres (Y is seating elevation at draw time).
    pub points: Vec<[f64; 2]>,
}

/// Linked plan underlay — additive reference, not a model element.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlanUnderlay {
    pub id: PlanUnderlayId,
    pub name: String,
    /// Original file name (for inspector / browser).
    #[serde(default)]
    pub source_name: String,
    pub visible: bool,
    pub locked: bool,
    /// 0..1 plan overlay opacity.
    pub opacity: f32,
    /// World X of underlay local origin.
    pub origin_x: f64,
    /// World Z of underlay local origin.
    pub origin_z: f64,
    /// Rotation about world Y (radians).
    pub rotation: f64,
    /// Uniform scale on local metres (usually 1 after `$INSUNITS` bake).
    pub scale: f64,
    /// Seating elevation (world Y) for overlay linework.
    pub elevation: f64,
    pub polylines: Vec<UnderlayPolyline>,
    /// Optional embedded source DXF text (capped); empty when only parsed payload kept.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub source_dxf: String,
    /// Instance params for the inspector (name mirror, opacity, …).
    #[serde(default)]
    pub params: ParamMap,
}

/// Parameter schema for underlay instances (inspector-driven).
pub fn plan_underlay_param_specs() -> Vec<ParamSpec> {
    vec![
        ParamSpec {
            id: "name".to_string(),
            label: "Name".to_string(),
            kind: ParamKind::Text,
            default: ParamValue::Text(String::new()),
            min: None,
            max: None,
            unit: None,
            binding: ParamBinding::Instance,
        },
        ParamSpec {
            id: "opacity".to_string(),
            label: "Opacity".to_string(),
            kind: ParamKind::Number,
            default: ParamValue::Number(0.55),
            min: Some(0.05),
            max: Some(1.0),
            unit: None,
            binding: ParamBinding::Instance,
        },
        ParamSpec {
            id: "locked".to_string(),
            label: "Locked".to_string(),
            kind: ParamKind::Bool,
            default: ParamValue::Bool(false),
            min: None,
            max: None,
            unit: None,
            binding: ParamBinding::Instance,
        },
        ParamSpec {
            id: "visible".to_string(),
            label: "Visible".to_string(),
            kind: ParamKind::Bool,
            default: ParamValue::Bool(true),
            min: None,
            max: None,
            unit: None,
            binding: ParamBinding::Instance,
        },
        ParamSpec::length("origin_x", "Origin X", 0.0),
        ParamSpec::length("origin_z", "Origin Z", 0.0),
        ParamSpec {
            id: "rotation_deg".to_string(),
            label: "Rotation".to_string(),
            kind: ParamKind::Number,
            default: ParamValue::Number(0.0),
            min: None,
            max: None,
            unit: Some("°".into()),
            binding: ParamBinding::Instance,
        },
        ParamSpec {
            id: "scale".to_string(),
            label: "Scale".to_string(),
            kind: ParamKind::Number,
            default: ParamValue::Number(1.0),
            min: Some(1e-6),
            max: Some(1e6),
            unit: None,
            binding: ParamBinding::Instance,
        },
    ]
}

fn underlay_specs_static() -> &'static [ParamSpec] {
    static SPECS: std::sync::OnceLock<Vec<ParamSpec>> = std::sync::OnceLock::new();
    SPECS.get_or_init(plan_underlay_param_specs)
}

/// Keep embedding source DXF only when small enough for project JSON.
const EMBED_SOURCE_MAX_BYTES: usize = 256_000;

impl PlanUnderlay {
    pub fn from_parsed(
        name: impl Into<String>,
        source_name: impl Into<String>,
        parsed: ParsedDxf,
        source_dxf: &str,
        elevation: f64,
    ) -> Self {
        let name = name.into();
        let source_name = source_name.into();
        let polylines = bake_polylines(&parsed.polylines, parsed.to_metres);
        let mut params = ParamMap::default();
        params.set("name", ParamValue::Text(name.clone()));
        params.set("opacity", ParamValue::Number(0.55));
        params.set("locked", ParamValue::Bool(false));
        params.set("visible", ParamValue::Bool(true));
        params.set("origin_x", ParamValue::Number(0.0));
        params.set("origin_z", ParamValue::Number(0.0));
        params.set("rotation_deg", ParamValue::Number(0.0));
        params.set("scale", ParamValue::Number(1.0));

        Self {
            id: PlanUnderlayId::new(),
            name,
            source_name,
            visible: true,
            locked: false,
            opacity: 0.55,
            origin_x: 0.0,
            origin_z: 0.0,
            rotation: 0.0,
            scale: 1.0,
            elevation,
            polylines,
            source_dxf: if source_dxf.len() <= EMBED_SOURCE_MAX_BYTES {
                source_dxf.to_string()
            } else {
                String::new()
            },
            params,
        }
    }

    pub fn from_dxf_text(
        name: impl Into<String>,
        source_name: impl Into<String>,
        dxf_text: &str,
        elevation: f64,
    ) -> Result<Self, PlanUnderlayError> {
        let parsed = parse_dxf_r12(dxf_text)?;
        Ok(Self::from_parsed(
            name,
            source_name,
            parsed,
            dxf_text,
            elevation,
        ))
    }

    pub fn apply_params(&mut self, patch: &ParamMap) {
        self.params = self.params.merged(patch);
        if let Some(name) = self.params.text("name") {
            if !name.is_empty() {
                self.name = name.to_string();
            }
        }
        if let Some(v) = self.params.number("opacity") {
            self.opacity = (v as f32).clamp(0.05, 1.0);
        }
        if let Some(v) = self.params.bool("locked") {
            self.locked = v;
        }
        if let Some(v) = self.params.bool("visible") {
            self.visible = v;
        }
        if let Some(v) = self.params.number("origin_x") {
            self.origin_x = v;
        }
        if let Some(v) = self.params.number("origin_z") {
            self.origin_z = v;
        }
        if let Some(v) = self.params.number("rotation_deg") {
            self.rotation = v.to_radians();
        }
        if let Some(v) = self.params.number("scale") {
            if v.abs() > 1e-12 {
                self.scale = v;
            }
        }
        // Keep params in sync with struct fields for inspector round-trip.
        self.sync_params_from_fields();
    }

    pub fn sync_params_from_fields(&mut self) {
        self.params.set("name", ParamValue::Text(self.name.clone()));
        self.params
            .set("opacity", ParamValue::Number(self.opacity as f64));
        self.params.set("locked", ParamValue::Bool(self.locked));
        self.params.set("visible", ParamValue::Bool(self.visible));
        self.params
            .set("origin_x", ParamValue::Number(self.origin_x));
        self.params
            .set("origin_z", ParamValue::Number(self.origin_z));
        self.params.set(
            "rotation_deg",
            ParamValue::Number(self.rotation.to_degrees()),
        );
        self.params.set("scale", ParamValue::Number(self.scale));
    }

    pub fn resolved_params(&self) -> ParamMap {
        self.params
            .resolve(underlay_specs_static())
            .unwrap_or_else(|_| self.params.clone())
    }

    /// World-space segment pairs for WebGL overlay (`[a,b, a,b, …]`).
    pub fn overlay_line_segments(&self) -> Vec<Vec3> {
        if !self.visible {
            return Vec::new();
        }
        let mut out = Vec::new();
        let cos = self.rotation.cos();
        let sin = self.rotation.sin();
        let s = self.scale;
        let y = self.elevation as f32;
        let map = |p: [f64; 2]| -> Vec3 {
            let lx = p[0] * s;
            let lz = p[1] * s;
            let wx = self.origin_x + lx * cos - lz * sin;
            let wz = self.origin_z + lx * sin + lz * cos;
            Vec3::new(wx as f32, y, wz as f32)
        };
        for pl in &self.polylines {
            if pl.points.len() < 2 {
                continue;
            }
            for w in pl.points.windows(2) {
                out.push(map(w[0]));
                out.push(map(w[1]));
            }
            if pl.closed {
                let a = pl.points[pl.points.len() - 1];
                let b = pl.points[0];
                out.push(map(a));
                out.push(map(b));
            }
        }
        out
    }

    pub fn param_specs() -> &'static [ParamSpec] {
        underlay_specs_static()
    }
}

fn bake_polylines(raw: &[ParsedPolyline], to_metres: f64) -> Vec<UnderlayPolyline> {
    raw.iter()
        .filter(|p| p.points.len() >= 2)
        .map(|p| UnderlayPolyline {
            layer: p.layer.clone(),
            closed: p.closed,
            points: p
                .points
                .iter()
                .map(|xy| [xy[0] * to_metres, xy[1] * to_metres])
                .collect(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn from_dxf_builds_overlay_segments() {
        let dxf = r#"  0
SECTION
  2
HEADER
  9
$INSUNITS
 70
6
  0
ENDSEC
  0
SECTION
  2
ENTITIES
  0
LINE
  8
0
 10
0
 20
0
 11
2
 21
0
  0
ENDSEC
  0
EOF
"#;
        let underlay =
            PlanUnderlay::from_dxf_text("Survey", "site.dxf", dxf, 0.0).expect("underlay");
        assert_eq!(underlay.polylines.len(), 1);
        let segs = underlay.overlay_line_segments();
        assert_eq!(segs.len(), 2);
        assert!((segs[0].x - 0.0).abs() < 1e-5);
        assert!((segs[1].x - 2.0).abs() < 1e-5);
    }

    #[test]
    fn mm_units_bake_to_metres() {
        let dxf = r#"  0
SECTION
  2
HEADER
  9
$INSUNITS
 70
4
  0
ENDSEC
  0
SECTION
  2
ENTITIES
  0
LINE
  8
0
 10
0
 20
0
 11
1000
 21
0
  0
ENDSEC
  0
EOF
"#;
        let underlay = PlanUnderlay::from_dxf_text("U", "a.dxf", dxf, 0.0).expect("u");
        let segs = underlay.overlay_line_segments();
        assert!((segs[1].x - 1.0).abs() < 1e-5);
    }

    #[test]
    fn project_link_round_trips_in_snapshot() {
        use crate::Project;
        let mut project = Project::new();
        let dxf = r#"  0
SECTION
  2
HEADER
  9
$INSUNITS
 70
6
  0
ENDSEC
  0
SECTION
  2
ENTITIES
  0
LINE
  8
0
 10
0
 20
0
 11
5
 21
0
  0
ENDSEC
  0
EOF
"#;
        let id = project.link_dxf_underlay(dxf, "survey.dxf").expect("link");
        assert_eq!(project.underlays().count(), 1);
        let snap = project.export_snapshot();
        assert_eq!(snap.format, crate::project::PROJECT_FORMAT);
        assert_eq!(snap.underlays.len(), 1);
        assert_eq!(snap.underlays[0].id, id);

        let mut restored = Project::new();
        restored.import_snapshot(snap).expect("import");
        assert_eq!(restored.underlays().count(), 1);
        let segs = restored
            .get_underlay(id)
            .expect("underlay")
            .overlay_line_segments();
        assert_eq!(segs.len(), 2);
        assert!((segs[1].x - 5.0).abs() < 1e-4);

        // Format ≤10 imports with empty underlays.
        let mut legacy = restored.export_snapshot();
        legacy.format = 10;
        legacy.underlays.clear();
        restored.import_snapshot(legacy).expect("legacy");
        assert_eq!(restored.underlays().count(), 0);
    }
}
