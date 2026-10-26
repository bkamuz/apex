//! Machine-readable descriptors.
//!
//! Every registered element type, command, query and annotation kind carries a
//! [`Descriptor`]: what it is for, examples, units and constraints. Agents (the
//! MCP server) and docs read these instead of guessing from code, so a type
//! without one is refused at registration. JSON Schemas for element params are
//! derived from the definition's [`ParamSpec`] list so they can never drift.

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::param::{ParamKind, ParamSpec, ParamValue};

/// Units every value in Apex uses unless a descriptor says otherwise.
pub const DEFAULT_UNITS: &str =
    "lengths in metres, angles in radians, plan is the XZ plane, +Y is up";

/// One worked example: a short description plus the payload an agent would send.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DescriptorExample {
    pub description: String,
    /// Example input (params for an element type, the command body for a command).
    pub input: Value,
}

/// What a registered thing is for, in a form an agent can act on.
///
/// `id` and `name` come from the thing itself (the component id and display
/// name), so they are not repeated here.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Descriptor {
    /// One or two sentences: what it models and when to use it. Required.
    pub purpose: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub examples: Vec<DescriptorExample>,
    /// Rules the core enforces or the caller must respect.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub constraints: Vec<String>,
    /// Unit notes; empty means [`DEFAULT_UNITS`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub units: Option<String>,
    /// How the placement points are read (e.g. "two points: start and end of the centreline").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub points: Option<String>,
}

impl Descriptor {
    pub fn new(purpose: impl Into<String>) -> Self {
        Self {
            purpose: purpose.into(),
            ..Self::default()
        }
    }

    pub fn points(mut self, text: impl Into<String>) -> Self {
        self.points = Some(text.into());
        self
    }

    pub fn constraint(mut self, text: impl Into<String>) -> Self {
        self.constraints.push(text.into());
        self
    }

    pub fn example(mut self, description: impl Into<String>, input: Value) -> Self {
        self.examples.push(DescriptorExample {
            description: description.into(),
            input,
        });
        self
    }

    pub fn units(mut self, text: impl Into<String>) -> Self {
        self.units = Some(text.into());
        self
    }

    /// True when the descriptor says nothing an agent could use.
    pub fn is_missing(&self) -> bool {
        self.purpose.trim().is_empty()
    }
}

/// Fully expanded descriptor as published to agents.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PublishedDescriptor {
    pub id: String,
    pub name: String,
    pub kind: &'static str,
    #[serde(flatten)]
    pub descriptor: Descriptor,
    pub units: String,
    pub params_schema: Value,
}

impl PublishedDescriptor {
    pub fn new(
        kind: &'static str,
        id: impl Into<String>,
        name: impl Into<String>,
        descriptor: &Descriptor,
        params_schema: Value,
    ) -> Self {
        let units = descriptor
            .units
            .clone()
            .unwrap_or_else(|| DEFAULT_UNITS.to_string());
        Self {
            id: id.into(),
            name: name.into(),
            kind,
            descriptor: descriptor.clone(),
            units,
            params_schema,
        }
    }
}

fn value_json(value: &ParamValue) -> Value {
    match value {
        ParamValue::Length(v) | ParamValue::Angle(v) | ParamValue::Number(v) => json!(v),
        ParamValue::Bool(b) => json!(b),
        ParamValue::Text(s)
        | ParamValue::Choice(s)
        | ParamValue::ProfileRef(s)
        | ParamValue::ReferenceRef(s) => json!(s),
    }
}

/// JSON Schema (draft 2020-12 subset) for one parameter's wire value.
///
/// Params travel as bare JSON scalars (`{"height": 3.0}`); the spec types them.
pub fn param_json_schema(spec: &ParamSpec) -> Value {
    let mut s = Map::new();
    s.insert("title".into(), json!(spec.label));
    let unit = spec.unit.clone().or_else(|| match spec.kind {
        ParamKind::Length => Some("m".into()),
        ParamKind::Angle => Some("rad".into()),
        _ => None,
    });
    match &spec.kind {
        ParamKind::Length | ParamKind::Angle | ParamKind::Number => {
            s.insert("type".into(), json!("number"));
            if let Some(min) = spec.min {
                s.insert("minimum".into(), json!(min));
            }
            if let Some(max) = spec.max {
                s.insert("maximum".into(), json!(max));
            }
        }
        ParamKind::Bool => {
            s.insert("type".into(), json!("boolean"));
        }
        ParamKind::Text => {
            s.insert("type".into(), json!("string"));
        }
        ParamKind::Choice { options } => {
            s.insert("type".into(), json!("string"));
            s.insert("enum".into(), json!(options));
        }
        ParamKind::Profile { options } | ParamKind::Reference { options, .. } => {
            s.insert("type".into(), json!("string"));
            if !options.is_empty() {
                s.insert("examples".into(), json!(options));
            }
        }
    }
    s.insert("default".into(), value_json(&spec.default));
    let mut desc = format!("{} ({:?} param", spec.label, spec.binding);
    if let Some(unit) = unit {
        desc.push_str(&format!(", unit {unit}"));
    }
    desc.push(')');
    s.insert("description".into(), json!(desc));
    Value::Object(s)
}

/// Object schema for a whole param list. Every param is optional: omitted ones
/// keep their default.
pub fn params_json_schema(specs: &[ParamSpec]) -> Value {
    let props: Map<String, Value> = specs
        .iter()
        .map(|spec| (spec.id.clone(), param_json_schema(spec)))
        .collect();
    json!({
        "type": "object",
        "properties": props,
        "additionalProperties": false,
    })
}
