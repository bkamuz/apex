//! The component registry, plus the built-in components.
//!
//! Every built-in is registered through [`ComponentRegistry::register`], the
//! same entry point a module or the visual editor uses. If a built-in needed a
//! private back door, the architecture would not be extensible.

use std::collections::BTreeMap;

use apex_geometry::{Frame, Justification, TriangleMesh};
use thiserror::Error;

use crate::component::{
    evaluate_recipe, ComponentDefinition, ComponentSource, DefinitionError, FrameSource,
    GeometryRecipe, MeshBuilder, ProfileId, ProfileLibrary, ProfileSpec, RecipeContext,
    RecipeError,
};
use crate::element::{ComponentId, Element};
use crate::expr::Expr;
use crate::param::{ParamError, ParamMap, ParamSpec};
use crate::placement::{Placement, PlacementKind};

#[derive(Debug, Clone, PartialEq, Error)]
pub enum RegistryError {
    #[error(transparent)]
    Definition(#[from] DefinitionError),
    #[error("component '{0}' is already registered")]
    Duplicate(ComponentId),
    #[error("unknown component '{0}'")]
    Unknown(ComponentId),
    #[error("component '{component}' is placed by {expected}, but the element uses {actual}")]
    PlacementMismatch {
        component: ComponentId,
        expected: &'static str,
        actual: &'static str,
    },
    #[error(transparent)]
    Params(#[from] ParamError),
    #[error(transparent)]
    Recipe(#[from] RecipeError),
}

/// Everything the document needs to turn elements into geometry.
#[derive(Default)]
pub struct ComponentRegistry {
    components: BTreeMap<ComponentId, ComponentDefinition>,
    profiles: ProfileLibrary,
    builders: BTreeMap<String, Box<dyn MeshBuilder>>,
}

impl ComponentRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// A registry preloaded with the shipped components.
    pub fn with_builtins() -> Self {
        let mut registry = Self::new();
        for (id, spec) in builtin_profiles() {
            registry.register_profile(id, spec);
        }
        for definition in builtin_components() {
            registry
                .register(definition)
                .expect("built-in components must be valid");
        }
        registry
    }

    /// Add a component. Validation happens here so an authoring mistake is
    /// reported when the component is installed, not when someone places it.
    pub fn register(&mut self, definition: ComponentDefinition) -> Result<(), RegistryError> {
        definition.validate()?;
        if self.components.contains_key(&definition.id) {
            return Err(RegistryError::Duplicate(definition.id));
        }
        self.components.insert(definition.id.clone(), definition);
        Ok(())
    }

    /// Add or replace a component, for reloading a module during development.
    pub fn upsert(&mut self, definition: ComponentDefinition) -> Result<(), RegistryError> {
        definition.validate()?;
        self.components.insert(definition.id.clone(), definition);
        Ok(())
    }

    pub fn register_profile(&mut self, id: impl Into<ProfileId>, spec: ProfileSpec) {
        self.profiles.insert(id.into(), spec);
    }

    pub fn register_builder(&mut self, id: impl Into<String>, builder: Box<dyn MeshBuilder>) {
        self.builders.insert(id.into(), builder);
    }

    pub fn get(&self, id: &str) -> Option<&ComponentDefinition> {
        self.components.get(id)
    }

    pub fn require(&self, id: &str) -> Result<&ComponentDefinition, RegistryError> {
        self.get(id)
            .ok_or_else(|| RegistryError::Unknown(id.to_string()))
    }

    pub fn components(&self) -> impl Iterator<Item = &ComponentDefinition> {
        self.components.values()
    }

    pub fn profiles(&self) -> &ProfileLibrary {
        &self.profiles
    }

    pub fn len(&self) -> usize {
        self.components.len()
    }

    pub fn is_empty(&self) -> bool {
        self.components.is_empty()
    }

    /// Build the mesh for a placement plus a raw parameter set.
    pub fn build_mesh(
        &self,
        component_id: &str,
        placement: &Placement,
        raw_params: &ParamMap,
        work_plane: Frame,
    ) -> Result<TriangleMesh, RegistryError> {
        let definition = self.require(component_id)?;
        if !definition.placement.accepts(placement) {
            return Err(RegistryError::PlacementMismatch {
                component: definition.id.clone(),
                expected: definition.placement.as_str(),
                actual: placement_name(placement),
            });
        }

        let params = definition.resolve_params(raw_params)?;
        let ctx = RecipeContext {
            placement,
            params: &params,
            work_plane,
            profiles: &self.profiles,
        };
        Ok(evaluate_recipe(&definition.recipe, &ctx, &self.builders)?)
    }

    /// Build the mesh for an existing element.
    pub fn build_element_mesh(
        &self,
        element: &Element,
        work_plane: Frame,
    ) -> Result<TriangleMesh, RegistryError> {
        self.build_mesh(
            &element.component_id,
            &element.placement,
            &element.params,
            work_plane,
        )
    }
}

fn placement_name(placement: &Placement) -> &'static str {
    match placement {
        Placement::Point { .. } => "point",
        Placement::Curve { .. } => "curve",
        Placement::Free { .. } => "free",
    }
}

/// Profiles every project starts with.
fn builtin_profiles() -> Vec<(ProfileId, ProfileSpec)> {
    vec![
        (
            "apex.rect".to_string(),
            ProfileSpec::Rectangle {
                width: Expr::param("width"),
                height: Expr::param("depth"),
            },
        ),
        (
            "apex.round".to_string(),
            ProfileSpec::Circle {
                radius: Expr::param("width") / Expr::constant(2.0),
                segments: 24,
            },
        ),
    ]
}

/// The shipped components, expressed purely as data.
///
/// There is no wall-specific, column-specific or beam-specific geometry code
/// anywhere: each is a profile plus a sweep or an extrude. Variants of a type
/// (rectangular vs round column) are a profile parameter, not a second type.
pub fn builtin_components() -> Vec<ComponentDefinition> {
    vec![
        wall("apex.wall", "Wall", PlacementKind::TwoPoint),
        wall("apex.arc_wall", "Arc wall", PlacementKind::ThreePointArc),
        column(),
        beam(),
    ]
}

/// A wall is a rectangle swept along its centerline, seated on the level.
///
/// Straight and arc walls differ only in how the user picks them.
fn wall(id: &str, display_name: &str, placement: PlacementKind) -> ComponentDefinition {
    ComponentDefinition {
        id: id.to_string(),
        display_name: display_name.to_string(),
        category: "wall".to_string(),
        source: ComponentSource::BuiltIn,
        placement,
        params: vec![
            ParamSpec::length("height", "Height", 3.0),
            ParamSpec::length("thickness", "Thickness", 0.2),
        ],
        recipe: GeometryRecipe::Sweep {
            profile: ProfileSpec::Rectangle {
                width: Expr::param("thickness"),
                height: Expr::param("height"),
            },
            justification: Justification::BaseCenter,
            start_offset: Expr::zero(),
            end_offset: Expr::zero(),
        },
    }
}

/// A column is one type. Rectangle vs round is the `profile` parameter, which
/// is what `ProfileSpec::FromParam` is for: one tool, swappable section.
fn column() -> ComponentDefinition {
    ComponentDefinition {
        id: "apex.column".to_string(),
        display_name: "Column".to_string(),
        category: "column".to_string(),
        source: ComponentSource::BuiltIn,
        placement: PlacementKind::Point,
        params: vec![
            ParamSpec::profile(
                "profile",
                "Profile",
                "apex.rect",
                &["apex.rect", "apex.round"],
            ),
            ParamSpec::length("height", "Height", 3.0),
            ParamSpec::length("width", "Width", 0.4),
            ParamSpec::length("depth", "Depth", 0.4),
        ],
        recipe: GeometryRecipe::Extrude {
            profile: ProfileSpec::FromParam {
                param: "profile".into(),
            },
            frame: FrameSource::PlacementCurve { t: Expr::zero() },
            height: Expr::param("height"),
        },
    }
}

/// A beam is the same sweep as a wall, hung below its line instead of sitting on it.
fn beam() -> ComponentDefinition {
    ComponentDefinition {
        id: "apex.beam".to_string(),
        display_name: "Beam".to_string(),
        category: "beam".to_string(),
        source: ComponentSource::BuiltIn,
        placement: PlacementKind::TwoPoint,
        params: vec![
            ParamSpec::length("width", "Width", 0.2),
            ParamSpec::length("depth", "Depth", 0.4),
        ],
        recipe: GeometryRecipe::Sweep {
            profile: ProfileSpec::Rectangle {
                width: Expr::param("width"),
                height: Expr::param("depth"),
            },
            justification: Justification::TopCenter,
            start_offset: Expr::zero(),
            end_offset: Expr::zero(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::param::ParamValue;
    use glam::Vec3;

    const EPS: f32 = 1e-4;

    fn ground() -> Frame {
        Frame::horizontal(0.0)
    }

    fn size_of(mesh: &TriangleMesh) -> [f32; 3] {
        let (min, max) = mesh.aabb().expect("aabb");
        [max[0] - min[0], max[1] - min[1], max[2] - min[2]]
    }

    #[test]
    fn every_builtin_validates_and_registers() {
        let registry = ComponentRegistry::with_builtins();
        assert_eq!(registry.len(), 4);
        for id in ["apex.wall", "apex.arc_wall", "apex.column", "apex.beam"] {
            let def = registry.get(id).unwrap_or_else(|| panic!("missing {id}"));
            assert_eq!(def.source, ComponentSource::BuiltIn);
            assert!(def.validate().is_ok());
        }
        assert!(
            registry.get("apex.round_column").is_none(),
            "round is a column profile, not a second component"
        );
    }

    #[test]
    fn the_builtin_wall_matches_the_old_hand_written_geometry() {
        let registry = ComponentRegistry::with_builtins();
        let placement = Placement::line(Vec3::ZERO, Vec3::new(5.0, 0.0, 0.0));
        let params = ParamMap::new()
            .with("height", ParamValue::Length(3.0))
            .with("thickness", ParamValue::Length(0.2));

        let mesh = registry
            .build_mesh("apex.wall", &placement, &params, ground())
            .expect("mesh");

        // Same counts and extents the bespoke wall generator produced.
        assert_eq!(mesh.triangle_count(), 12);
        assert_eq!(mesh.edge_count(), 12);
        let size = size_of(&mesh);
        assert!((size[0] - 5.0).abs() < EPS, "length {}", size[0]);
        assert!((size[1] - 3.0).abs() < EPS, "height {}", size[1]);
        assert!((size[2] - 0.2).abs() < EPS, "thickness {}", size[2]);
        assert!(mesh.aabb().unwrap().0[1].abs() < EPS, "sits on the level");
    }

    #[test]
    fn the_wall_falls_back_to_its_declared_defaults() {
        let registry = ComponentRegistry::with_builtins();
        let placement = Placement::line(Vec3::ZERO, Vec3::new(4.0, 0.0, 0.0));
        let mesh = registry
            .build_mesh("apex.wall", &placement, &ParamMap::new(), ground())
            .expect("mesh");

        let size = size_of(&mesh);
        assert!((size[1] - 3.0).abs() < EPS, "default height");
        assert!((size[2] - 0.2).abs() < EPS, "default thickness");
    }

    #[test]
    fn an_arc_wall_reuses_the_wall_recipe_with_a_different_gesture() {
        let registry = ComponentRegistry::with_builtins();
        let straight = registry.get("apex.wall").unwrap();
        let arc = registry.get("apex.arc_wall").unwrap();

        assert_eq!(
            straight.recipe, arc.recipe,
            "only the gesture should differ between a straight and an arc wall"
        );
        assert_eq!(straight.params, arc.params);
        assert_ne!(straight.placement, arc.placement);

        let placement = PlacementKind::ThreePointArc
            .build(
                &[
                    Vec3::new(5.0, 0.0, 0.0),
                    Vec3::new(0.0, 0.0, 5.0),
                    Vec3::new(-5.0, 0.0, 0.0),
                ],
                0.0,
                &ground(),
            )
            .expect("arc placement");

        let mesh = registry
            .build_mesh("apex.arc_wall", &placement, &ParamMap::new(), ground())
            .expect("mesh");
        assert!(mesh.triangle_count() > 12, "a curved wall has more faces");
        let (min, max) = mesh.aabb().unwrap();
        assert!(min[1].abs() < EPS && (max[1] - 3.0).abs() < EPS);
    }

    #[test]
    fn a_column_is_added_with_data_alone() {
        let registry = ComponentRegistry::with_builtins();
        let placement = Placement::point(Vec3::new(2.0, 0.0, 3.0));
        let params = ParamMap::new()
            .with("height", ParamValue::Length(4.0))
            .with("width", ParamValue::Length(0.5))
            .with("depth", ParamValue::Length(0.3));

        let mesh = registry
            .build_mesh("apex.column", &placement, &params, ground())
            .expect("mesh");

        let size = size_of(&mesh);
        assert!((size[0] - 0.5).abs() < EPS, "width {}", size[0]);
        assert!((size[1] - 4.0).abs() < EPS, "height {}", size[1]);
        assert!((size[2] - 0.3).abs() < EPS, "depth {}", size[2]);
    }

    #[test]
    fn switching_a_column_profile_needs_no_new_type() {
        let registry = ComponentRegistry::with_builtins();
        let placement = Placement::point(Vec3::ZERO);
        let rect = ParamMap::new()
            .with("height", ParamValue::Length(3.0))
            .with("width", ParamValue::Length(0.6))
            .with("depth", ParamValue::Length(0.3));
        let round = rect
            .clone()
            .with("profile", ParamValue::ProfileRef("apex.round".into()));

        let rect_mesh = registry
            .build_mesh("apex.column", &placement, &rect, ground())
            .expect("rect");
        let round_mesh = registry
            .build_mesh("apex.column", &placement, &round, ground())
            .expect("round");

        let rect_size = size_of(&rect_mesh);
        let round_size = size_of(&round_mesh);
        assert!((rect_size[0] - 0.6).abs() < EPS, "width {}", rect_size[0]);
        assert!((rect_size[2] - 0.3).abs() < EPS, "depth {}", rect_size[2]);
        assert!(
            (round_size[0] - 0.6).abs() < 1e-2,
            "diameter {}",
            round_size[0]
        );
        assert!(
            (round_size[2] - 0.6).abs() < 1e-2,
            "round in both axes, got {}",
            round_size[2]
        );
        assert!((round_size[1] - 3.0).abs() < EPS);
    }

    #[test]
    fn a_beam_hangs_below_its_line_while_a_wall_sits_on_it() {
        let registry = ComponentRegistry::with_builtins();
        let placement = Placement::line(Vec3::new(0.0, 3.0, 0.0), Vec3::new(6.0, 3.0, 0.0));

        let beam = registry
            .build_mesh("apex.beam", &placement, &ParamMap::new(), ground())
            .expect("mesh");
        let wall = registry
            .build_mesh("apex.wall", &placement, &ParamMap::new(), ground())
            .expect("mesh");

        let (beam_min, beam_max) = beam.aabb().unwrap();
        let (wall_min, _) = wall.aabb().unwrap();
        assert!((beam_max[1] - 3.0).abs() < EPS, "beam top on the line");
        assert!((beam_min[1] - 2.6).abs() < EPS, "0.4 deep, hanging down");
        assert!((wall_min[1] - 3.0).abs() < EPS, "wall base on the line");
    }

    #[test]
    fn placing_a_component_with_the_wrong_gesture_is_rejected() {
        let registry = ComponentRegistry::with_builtins();
        let err = registry
            .build_mesh(
                "apex.wall",
                &Placement::point(Vec3::ZERO),
                &ParamMap::new(),
                ground(),
            )
            .unwrap_err();
        assert_eq!(
            err,
            RegistryError::PlacementMismatch {
                component: "apex.wall".into(),
                expected: "two_point",
                actual: "point"
            }
        );
    }

    #[test]
    fn an_unknown_component_is_reported() {
        let registry = ComponentRegistry::with_builtins();
        assert_eq!(
            registry
                .build_mesh(
                    "acme.nope",
                    &Placement::point(Vec3::ZERO),
                    &ParamMap::new(),
                    ground()
                )
                .unwrap_err(),
            RegistryError::Unknown("acme.nope".into())
        );
    }

    #[test]
    fn registering_the_same_id_twice_is_rejected_but_upsert_replaces() {
        let mut registry = ComponentRegistry::with_builtins();
        let mut def = registry.get("apex.wall").unwrap().clone();
        def.display_name = "Custom wall".into();

        assert_eq!(
            registry.register(def.clone()).unwrap_err(),
            RegistryError::Duplicate("apex.wall".into())
        );
        registry.upsert(def).expect("upsert");
        assert_eq!(
            registry.get("apex.wall").unwrap().display_name,
            "Custom wall"
        );
    }

    #[test]
    fn an_invalid_component_is_refused_at_registration() {
        let mut registry = ComponentRegistry::new();
        let def = ComponentDefinition {
            id: "acme.broken".into(),
            display_name: "Broken".into(),
            category: "generic".into(),
            source: ComponentSource::Visual,
            placement: PlacementKind::Point,
            params: vec![],
            recipe: GeometryRecipe::Extrude {
                profile: ProfileSpec::Circle {
                    radius: Expr::constant(0.5),
                    segments: 8,
                },
                frame: FrameSource::default(),
                height: Expr::param("height"),
            },
        };

        assert!(matches!(
            registry.register(def).unwrap_err(),
            RegistryError::Definition(DefinitionError::UndeclaredParam { .. })
        ));
        assert!(registry.is_empty());
    }

    #[test]
    fn a_user_component_goes_through_the_same_door_as_a_builtin() {
        let mut registry = ComponentRegistry::with_builtins();

        // A table: round top on a single pick, exactly how a module would ship it.
        let table = ComponentDefinition {
            id: "acme.table".into(),
            display_name: "Table".into(),
            category: "furniture".into(),
            source: ComponentSource::Module {
                id: "acme.furniture".into(),
            },
            placement: PlacementKind::Point,
            params: vec![
                ParamSpec::length("radius", "Radius", 0.6),
                ParamSpec::length("thickness", "Top thickness", 0.05),
            ],
            recipe: GeometryRecipe::Extrude {
                profile: ProfileSpec::Circle {
                    radius: Expr::param("radius"),
                    segments: 32,
                },
                frame: FrameSource::WorkPlane,
                height: Expr::param("thickness"),
            },
        };
        registry.register(table).expect("register");

        let mesh = registry
            .build_mesh(
                "acme.table",
                &Placement::point(Vec3::ZERO),
                &ParamMap::new(),
                ground(),
            )
            .expect("mesh");
        let size = size_of(&mesh);
        assert!((size[0] - 1.2).abs() < 1e-2, "diameter {}", size[0]);
        assert!((size[1] - 0.05).abs() < EPS);
        assert_eq!(registry.len(), 5);
    }

    #[test]
    fn a_component_can_be_installed_from_authored_json() {
        let json = r#"{
            "id": "acme.plinth",
            "display_name": "Plinth",
            "category": "furniture",
            "placement": "point",
            "params": [
                {"id": "size", "label": "Size", "kind": "length", "default": 0.8},
                {"id": "height", "label": "Height", "kind": "length", "default": 0.3}
            ],
            "recipe": {
                "op": "extrude",
                "profile": {
                    "shape": "rectangle",
                    "width": {"op": "param", "id": "size"},
                    "height": {"op": "param", "id": "size"}
                },
                "height": {"op": "param", "id": "height"}
            }
        }"#;

        let mut registry = ComponentRegistry::with_builtins();
        let def: ComponentDefinition = serde_json::from_str(json).expect("parse");
        registry.register(def).expect("register");

        let mesh = registry
            .build_mesh(
                "acme.plinth",
                &Placement::point(Vec3::new(1.0, 0.0, 1.0)),
                &ParamMap::new().with("height", ParamValue::Number(0.5)),
                ground(),
            )
            .expect("mesh");

        let size = size_of(&mesh);
        assert!((size[0] - 0.8).abs() < EPS);
        assert!((size[1] - 0.5).abs() < EPS, "overridden height");
    }

    #[test]
    fn a_module_builder_backs_a_custom_recipe_step() {
        let mut registry = ComponentRegistry::new();
        registry.register_builder(
            "acme.marker",
            Box::new(|ctx: &RecipeContext| {
                let o = ctx.placement.origin().to_array();
                let mut mesh = TriangleMesh::empty();
                mesh.push_triangle(
                    o,
                    [o[0] + 1.0, o[1], o[2]],
                    [o[0], o[1] + 1.0, o[2]],
                    [0.0, 0.0, 1.0],
                );
                Ok(mesh)
            }),
        );
        registry
            .register(ComponentDefinition {
                id: "acme.marker".into(),
                display_name: "Marker".into(),
                category: "annotation".into(),
                source: ComponentSource::Module { id: "acme".into() },
                placement: PlacementKind::Point,
                params: vec![],
                recipe: GeometryRecipe::Custom {
                    builder_id: "acme.marker".into(),
                },
            })
            .expect("register");

        let mesh = registry
            .build_mesh(
                "acme.marker",
                &Placement::point(Vec3::new(5.0, 0.0, 0.0)),
                &ParamMap::new(),
                ground(),
            )
            .expect("mesh");
        assert_eq!(mesh.triangle_count(), 1);
        assert_eq!(mesh.positions[0], 5.0, "the builder saw the placement");
    }

    #[test]
    fn building_an_element_uses_its_own_component_and_params() {
        let registry = ComponentRegistry::with_builtins();
        let element = Element::new(
            "Wall 1",
            "apex.wall",
            crate::level::LevelId::new(),
            Placement::line(Vec3::ZERO, Vec3::new(3.0, 0.0, 0.0)),
            ParamMap::new().with("height", ParamValue::Length(2.0)),
        );

        let mesh = registry
            .build_element_mesh(&element, ground())
            .expect("mesh");
        assert!((size_of(&mesh)[1] - 2.0).abs() < EPS);
    }

    #[test]
    fn components_are_listed_in_a_stable_order() {
        let registry = ComponentRegistry::with_builtins();
        let ids: Vec<_> = registry.components().map(|c| c.id.as_str()).collect();
        let mut sorted = ids.clone();
        sorted.sort();
        assert_eq!(ids, sorted, "listing drives the toolbar, so keep it stable");
    }
}
