//! An element instance: which component it is, where it sits, what its
//! parameters say. Nothing here is specific to any component type.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::level::LevelId;
use crate::param::ParamMap;
use crate::placement::Placement;

/// Identifies a component definition, e.g. `"apex.wall"` or `"acme.myColumn"`.
///
/// A plain string, so a module or the visual editor can introduce new types
/// without touching the core.
pub type ComponentId = String;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ElementId(Uuid);

impl ElementId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }

    pub fn as_u64(&self) -> u64 {
        let bytes = self.0.as_bytes();
        u64::from_le_bytes(bytes[0..8].try_into().expect("uuid slice"))
    }
}

impl Default for ElementId {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Display for ElementId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::str::FromStr for ElementId {
    type Err = uuid::Error;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Ok(Self(Uuid::parse_str(s)?))
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Element {
    pub id: ElementId,
    pub name: String,
    pub component_id: ComponentId,
    pub level_id: LevelId,
    pub placement: Placement,
    pub params: ParamMap,
}

impl Element {
    pub fn new(
        name: impl Into<String>,
        component_id: impl Into<ComponentId>,
        level_id: LevelId,
        placement: Placement,
        params: ParamMap,
    ) -> Self {
        Self {
            id: ElementId::new(),
            name: name.into(),
            component_id: component_id.into(),
            level_id,
            placement,
            params,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::param::ParamValue;
    use glam::Vec3;

    #[test]
    fn an_element_carries_its_component_id_and_params() {
        let level = LevelId::new();
        let el = Element::new(
            "Wall 1",
            "apex.wall",
            level,
            Placement::line(Vec3::ZERO, Vec3::new(4.0, 0.0, 0.0)),
            ParamMap::new().with("height", ParamValue::Length(3.0)),
        );

        assert_eq!(el.component_id, "apex.wall");
        assert_eq!(el.level_id, level);
        assert_eq!(el.params.number("height"), Some(3.0));
        assert!((el.placement.length().unwrap() - 4.0).abs() < 1e-4);
    }

    #[test]
    fn element_ids_are_unique_and_round_trip_as_strings() {
        let a = ElementId::new();
        let b = ElementId::new();
        assert_ne!(a, b);
        assert_eq!(a.to_string().parse::<ElementId>().unwrap(), a);
    }

    #[test]
    fn an_element_round_trips_through_json() {
        let el = Element::new(
            "Column 1",
            "apex.column",
            LevelId::new(),
            Placement::point(Vec3::new(1.0, 0.0, 2.0)),
            ParamMap::new().with("height", ParamValue::Length(3.0)),
        );
        let json = serde_json::to_string(&el).expect("serialize");
        let back: Element = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back.component_id, el.component_id);
        assert_eq!(back.placement, el.placement);
    }
}
