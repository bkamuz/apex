//! Dynamic parameters: the schema a component publishes and the values an
//! element carries. Nothing here knows about any specific component.

use std::collections::BTreeMap;

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use thiserror::Error;

pub type ParamId = String;

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ParamError {
    #[error("parameter '{id}' is required but missing")]
    Missing { id: ParamId },
    #[error("parameter '{id}' expected {expected}")]
    TypeMismatch { id: ParamId, expected: &'static str },
    #[error("parameter '{id}' is out of range")]
    OutOfRange { id: ParamId },
    #[error("parameter '{id}' is not one of the allowed options")]
    BadChoice { id: ParamId },
}

/// Whether a parameter belongs to a profile/component type or to one element.
///
/// Type values are shared: editing them rebuilds every element that uses the
/// type. Instance values live on the element. Missing `binding` in authored
/// JSON means instance, so older definitions keep working.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ParamBinding {
    Type,
    #[default]
    Instance,
}

impl ParamBinding {
    pub fn is_type(self) -> bool {
        matches!(self, Self::Type)
    }

    pub fn is_instance(self) -> bool {
        matches!(self, Self::Instance)
    }
}

fn binding_is_instance(binding: &ParamBinding) -> bool {
    binding.is_instance()
}

/// What a parameter accepts. Drives both validation and the generated UI control.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ParamKind {
    /// A distance in metres.
    Length,
    /// An angle in radians.
    Angle,
    /// A plain scalar.
    Number,
    Bool,
    Text,
    Choice {
        options: Vec<String>,
    },
    /// Reference to a named profile, which is what makes profiles swappable
    /// per element rather than per component (one Column tool, many sections).
    Profile {
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        options: Vec<String>,
    },
}

impl ParamKind {
    pub fn is_numeric(&self) -> bool {
        matches!(self, Self::Length | Self::Angle | Self::Number)
    }

    fn describe(&self) -> &'static str {
        match self {
            Self::Length => "a length",
            Self::Angle => "an angle",
            Self::Number => "a number",
            Self::Bool => "a boolean",
            Self::Text => "text",
            Self::Choice { .. } => "one of the allowed options",
            Self::Profile { .. } => "a profile id",
        }
    }
}

/// A parameter value. Serializes as a bare JSON scalar so authored JSON stays
/// natural (`{"height": 3.0}`); the [`ParamSpec`] is what assigns meaning.
#[derive(Debug, Clone, PartialEq)]
pub enum ParamValue {
    Length(f64),
    Angle(f64),
    Number(f64),
    Bool(bool),
    Text(String),
    Choice(String),
    ProfileRef(String),
}

impl ParamValue {
    pub fn as_number(&self) -> Option<f64> {
        match self {
            Self::Length(v) | Self::Angle(v) | Self::Number(v) => Some(*v),
            Self::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
            _ => None,
        }
    }

    pub fn as_text(&self) -> Option<&str> {
        match self {
            Self::Text(s) | Self::Choice(s) | Self::ProfileRef(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Self::Bool(b) => Some(*b),
            _ => None,
        }
    }

    /// Reinterpret a loosely-typed value (as parsed from JSON) under a declared kind.
    pub fn coerce(&self, id: &str, kind: &ParamKind) -> Result<ParamValue, ParamError> {
        let mismatch = || ParamError::TypeMismatch {
            id: id.to_string(),
            expected: kind.describe(),
        };
        match kind {
            ParamKind::Length => self
                .as_number()
                .map(ParamValue::Length)
                .ok_or_else(mismatch),
            ParamKind::Angle => self.as_number().map(ParamValue::Angle).ok_or_else(mismatch),
            ParamKind::Number => self
                .as_number()
                .map(ParamValue::Number)
                .ok_or_else(mismatch),
            ParamKind::Bool => self.as_bool().map(ParamValue::Bool).ok_or_else(mismatch),
            ParamKind::Text => self
                .as_text()
                .map(|s| ParamValue::Text(s.to_string()))
                .ok_or_else(mismatch),
            ParamKind::Choice { options } => {
                let text = self.as_text().ok_or_else(mismatch)?;
                if options.iter().any(|o| o == text) {
                    Ok(ParamValue::Choice(text.to_string()))
                } else {
                    Err(ParamError::BadChoice { id: id.to_string() })
                }
            }
            ParamKind::Profile { options } => {
                let text = self.as_text().ok_or_else(mismatch)?;
                if !options.is_empty() && !options.iter().any(|o| o == text) {
                    return Err(ParamError::BadChoice { id: id.to_string() });
                }
                Ok(ParamValue::ProfileRef(text.to_string()))
            }
        }
    }
}

/// Bare JSON shape of a parameter value, used only at the serde boundary.
#[derive(Serialize, Deserialize)]
#[serde(untagged)]
enum RawValue {
    Bool(bool),
    Number(f64),
    Text(String),
}

impl Serialize for ParamValue {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Length(v) | Self::Angle(v) | Self::Number(v) => serializer.serialize_f64(*v),
            Self::Bool(b) => serializer.serialize_bool(*b),
            Self::Text(s) | Self::Choice(s) | Self::ProfileRef(s) => serializer.serialize_str(s),
        }
    }
}

impl<'de> Deserialize<'de> for ParamValue {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Ok(match RawValue::deserialize(deserializer)? {
            RawValue::Bool(b) => Self::Bool(b),
            RawValue::Number(v) => Self::Number(v),
            RawValue::Text(s) => Self::Text(s),
        })
    }
}

/// One entry of a component's parameter schema.
///
/// A spec always holds a default matching its own `kind`, including when it is
/// parsed from authored JSON where scalars carry no type.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(try_from = "ParamSpecRaw")]
pub struct ParamSpec {
    pub id: ParamId,
    pub label: String,
    #[serde(flatten)]
    pub kind: ParamKind,
    pub default: ParamValue,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unit: Option<String>,
    #[serde(default, skip_serializing_if = "binding_is_instance")]
    pub binding: ParamBinding,
}

/// Wire shape of a [`ParamSpec`], before the default is typed against `kind`.
#[derive(Deserialize)]
struct ParamSpecRaw {
    id: ParamId,
    label: String,
    #[serde(flatten)]
    kind: ParamKind,
    default: ParamValue,
    #[serde(default)]
    min: Option<f64>,
    #[serde(default)]
    max: Option<f64>,
    #[serde(default)]
    unit: Option<String>,
    #[serde(default)]
    binding: ParamBinding,
}

impl TryFrom<ParamSpecRaw> for ParamSpec {
    type Error = ParamError;

    fn try_from(raw: ParamSpecRaw) -> Result<Self, Self::Error> {
        let default = raw.default.coerce(&raw.id, &raw.kind)?;
        Ok(Self {
            id: raw.id,
            label: raw.label,
            kind: raw.kind,
            default,
            min: raw.min,
            max: raw.max,
            unit: raw.unit,
            binding: raw.binding,
        })
    }
}

impl ParamSpec {
    pub fn length(id: &str, label: &str, default: f64) -> Self {
        Self {
            id: id.to_string(),
            label: label.to_string(),
            kind: ParamKind::Length,
            default: ParamValue::Length(default),
            min: Some(f64::MIN_POSITIVE),
            max: None,
            unit: Some("m".to_string()),
            binding: ParamBinding::Instance,
        }
    }

    pub fn number(id: &str, label: &str, default: f64) -> Self {
        Self {
            id: id.to_string(),
            label: label.to_string(),
            kind: ParamKind::Number,
            default: ParamValue::Number(default),
            min: None,
            max: None,
            unit: None,
            binding: ParamBinding::Instance,
        }
    }

    pub fn angle(id: &str, label: &str, default: f64) -> Self {
        Self {
            id: id.to_string(),
            label: label.to_string(),
            kind: ParamKind::Angle,
            default: ParamValue::Angle(default),
            min: None,
            max: None,
            unit: Some("rad".to_string()),
            binding: ParamBinding::Instance,
        }
    }

    pub fn choice(id: &str, label: &str, options: &[&str], default: &str) -> Self {
        Self {
            id: id.to_string(),
            label: label.to_string(),
            kind: ParamKind::Choice {
                options: options.iter().map(|s| s.to_string()).collect(),
            },
            default: ParamValue::Choice(default.to_string()),
            min: None,
            max: None,
            unit: None,
            binding: ParamBinding::Instance,
        }
    }

    pub fn profile(id: &str, label: &str, default: &str, options: &[&str]) -> Self {
        Self {
            id: id.to_string(),
            label: label.to_string(),
            kind: ParamKind::Profile {
                options: options.iter().map(|s| s.to_string()).collect(),
            },
            default: ParamValue::ProfileRef(default.to_string()),
            min: None,
            max: None,
            unit: None,
            binding: ParamBinding::Instance,
        }
    }

    pub fn as_type(mut self) -> Self {
        self.binding = ParamBinding::Type;
        self
    }

    pub fn with_range(mut self, min: Option<f64>, max: Option<f64>) -> Self {
        self.min = min;
        self.max = max;
        self
    }

    pub(crate) fn check_range(&self, value: &ParamValue) -> Result<(), ParamError> {
        let Some(n) = value.as_number() else {
            return Ok(());
        };
        let below = self.min.is_some_and(|min| n < min);
        let above = self.max.is_some_and(|max| n > max);
        if below || above {
            return Err(ParamError::OutOfRange {
                id: self.id.clone(),
            });
        }
        Ok(())
    }
}

/// Values attached to one element, keyed by parameter id.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ParamMap(BTreeMap<ParamId, ParamValue>);

impl ParamMap {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get(&self, id: &str) -> Option<&ParamValue> {
        self.0.get(id)
    }

    pub fn set(&mut self, id: impl Into<ParamId>, value: ParamValue) {
        self.0.insert(id.into(), value);
    }

    pub fn with(mut self, id: impl Into<ParamId>, value: ParamValue) -> Self {
        self.set(id, value);
        self
    }

    pub fn remove(&mut self, id: &str) -> Option<ParamValue> {
        self.0.remove(id)
    }

    pub fn iter(&self) -> impl Iterator<Item = (&ParamId, &ParamValue)> {
        self.0.iter()
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn number(&self, id: &str) -> Option<f64> {
        self.0.get(id).and_then(ParamValue::as_number)
    }

    pub fn text(&self, id: &str) -> Option<&str> {
        self.0.get(id).and_then(ParamValue::as_text)
    }

    pub fn bool(&self, id: &str) -> Option<bool> {
        self.0.get(id).and_then(ParamValue::as_bool)
    }

    /// Overlay `patch` on top of these values.
    pub fn merged(&self, patch: &ParamMap) -> Self {
        let mut out = self.clone();
        for (id, value) in patch.iter() {
            out.set(id.clone(), value.clone());
        }
        out
    }

    /// Ids present here that the schema does not declare.
    pub fn unknown_ids(&self, specs: &[ParamSpec]) -> Vec<ParamId> {
        self.0
            .keys()
            .filter(|id| !specs.iter().any(|s| &&s.id == id))
            .cloned()
            .collect()
    }

    /// Produce a complete, typed, validated value set for `specs`.
    ///
    /// Missing entries fall back to defaults and loosely-typed entries are
    /// coerced to the declared kind. Undeclared ids are dropped, so a component
    /// can drop a parameter without invalidating existing elements.
    pub fn resolve(&self, specs: &[ParamSpec]) -> Result<ParamMap, ParamError> {
        let mut out = ParamMap::new();
        for spec in specs {
            let value = match self.0.get(&spec.id) {
                Some(raw) => raw.coerce(&spec.id, &spec.kind)?,
                None => spec.default.coerce(&spec.id, &spec.kind)?,
            };
            spec.check_range(&value)?;
            out.set(spec.id.clone(), value);
        }
        Ok(out)
    }
}

impl FromIterator<(ParamId, ParamValue)> for ParamMap {
    fn from_iter<T: IntoIterator<Item = (ParamId, ParamValue)>>(iter: T) -> Self {
        Self(iter.into_iter().collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wall_specs() -> Vec<ParamSpec> {
        vec![
            ParamSpec::length("height", "Height", 3.0),
            ParamSpec::length("thickness", "Thickness", 0.2),
        ]
    }

    #[test]
    fn resolve_fills_missing_values_from_defaults() {
        let resolved = ParamMap::new().resolve(&wall_specs()).expect("resolve");
        assert_eq!(resolved.number("height"), Some(3.0));
        assert_eq!(resolved.number("thickness"), Some(0.2));
    }

    #[test]
    fn resolve_coerces_loose_json_numbers_to_the_declared_kind() {
        let raw = ParamMap::new().with("height", ParamValue::Number(4.5));
        let resolved = raw.resolve(&wall_specs()).expect("resolve");
        assert_eq!(
            resolved.get("height"),
            Some(&ParamValue::Length(4.5)),
            "a length parameter must come back typed as a length"
        );
    }

    #[test]
    fn resolve_drops_undeclared_ids_but_can_report_them() {
        let raw = ParamMap::new()
            .with("height", ParamValue::Number(4.0))
            .with("legacy", ParamValue::Number(1.0));
        let specs = wall_specs();

        assert_eq!(raw.unknown_ids(&specs), vec!["legacy".to_string()]);
        let resolved = raw.resolve(&specs).expect("resolve");
        assert!(resolved.get("legacy").is_none());
        assert_eq!(resolved.len(), 2);
    }

    #[test]
    fn resolve_rejects_a_value_of_the_wrong_type() {
        let raw = ParamMap::new().with("height", ParamValue::Text("tall".into()));
        assert_eq!(
            raw.resolve(&wall_specs()).unwrap_err(),
            ParamError::TypeMismatch {
                id: "height".into(),
                expected: "a length"
            }
        );
    }

    #[test]
    fn resolve_enforces_the_declared_range() {
        let specs = vec![ParamSpec::number("count", "Count", 2.0).with_range(Some(1.0), Some(8.0))];
        let too_high = ParamMap::new().with("count", ParamValue::Number(9.0));
        let ok = ParamMap::new().with("count", ParamValue::Number(8.0));

        assert_eq!(
            too_high.resolve(&specs).unwrap_err(),
            ParamError::OutOfRange { id: "count".into() }
        );
        assert!(ok.resolve(&specs).is_ok(), "the bound itself is allowed");
    }

    #[test]
    fn lengths_must_stay_positive() {
        let raw = ParamMap::new().with("thickness", ParamValue::Number(0.0));
        assert_eq!(
            raw.resolve(&wall_specs()).unwrap_err(),
            ParamError::OutOfRange {
                id: "thickness".into()
            }
        );
    }

    #[test]
    fn a_choice_only_accepts_its_options() {
        let specs = vec![ParamSpec::choice(
            "align",
            "Alignment",
            &["left", "center", "right"],
            "center",
        )];

        let good = ParamMap::new().with("align", ParamValue::Text("left".into()));
        assert_eq!(
            good.resolve(&specs).expect("resolve").get("align"),
            Some(&ParamValue::Choice("left".into()))
        );

        let bad = ParamMap::new().with("align", ParamValue::Text("sideways".into()));
        assert_eq!(
            bad.resolve(&specs).unwrap_err(),
            ParamError::BadChoice { id: "align".into() }
        );
    }

    #[test]
    fn merging_lets_a_patch_win() {
        let base = ParamMap::new()
            .with("height", ParamValue::Length(3.0))
            .with("thickness", ParamValue::Length(0.2));
        let patch = ParamMap::new().with("height", ParamValue::Length(4.0));

        let merged = base.merged(&patch);
        assert_eq!(merged.number("height"), Some(4.0));
        assert_eq!(merged.number("thickness"), Some(0.2));
    }

    #[test]
    fn values_round_trip_as_bare_json_scalars() {
        let map = ParamMap::new()
            .with("height", ParamValue::Length(3.0))
            .with("visible", ParamValue::Bool(true))
            .with("profile", ParamValue::ProfileRef("apex.rect".into()));

        let json = serde_json::to_string(&map).expect("serialize");
        assert_eq!(
            json, r#"{"height":3.0,"profile":"apex.rect","visible":true}"#,
            "authored JSON should stay plain"
        );

        let back: ParamMap = serde_json::from_str(&json).expect("deserialize");
        // Round-tripped values are loosely typed until resolved against a schema.
        assert_eq!(back.number("height"), Some(3.0));
        assert_eq!(back.bool("visible"), Some(true));
        assert_eq!(back.text("profile"), Some("apex.rect"));
    }

    #[test]
    fn a_spec_serializes_its_kind_inline_and_retypes_its_default() {
        let spec = ParamSpec::length("height", "Height", 3.0);
        let json = serde_json::to_string(&spec).expect("serialize");
        assert!(json.contains(r#""kind":"length""#), "json was {json}");

        let back: ParamSpec = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, spec);
        assert_eq!(
            back.default,
            ParamValue::Length(3.0),
            "a bare JSON scalar must come back typed as the declared kind"
        );
    }

    #[test]
    fn a_spec_with_a_default_of_the_wrong_type_fails_to_parse() {
        let json = r#"{"id":"height","label":"Height","kind":"length","default":"tall"}"#;
        let err = serde_json::from_str::<ParamSpec>(json).unwrap_err();
        assert!(
            err.to_string().contains("expected a length"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn a_choice_spec_parses_its_options_and_default() {
        let json =
            r#"{"id":"align","label":"Align","kind":"choice","options":["a","b"],"default":"b"}"#;
        let spec: ParamSpec = serde_json::from_str(json).expect("deserialize");
        assert_eq!(spec.default, ParamValue::Choice("b".into()));
        assert_eq!(
            spec.kind,
            ParamKind::Choice {
                options: vec!["a".into(), "b".into()]
            }
        );
    }

    #[test]
    fn a_profile_spec_carries_its_allowed_ids() {
        let spec = ParamSpec::profile(
            "profile",
            "Profile",
            "apex.rect",
            &["apex.rect", "apex.round"],
        );
        let json = serde_json::to_string(&spec).expect("serialize");
        assert!(json.contains(r#""kind":"profile""#), "json was {json}");
        assert!(json.contains("apex.round"), "json was {json}");

        let back: ParamSpec = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back.default, ParamValue::ProfileRef("apex.rect".into()));
        assert_eq!(
            back.kind,
            ParamKind::Profile {
                options: vec!["apex.rect".into(), "apex.round".into()]
            }
        );
    }
}
