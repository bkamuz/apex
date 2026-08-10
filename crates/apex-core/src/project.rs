//! Document plus registry: the operations a host application drives.
//!
//! Keeping this in the core means the WASM façade stays a thin translation
//! layer, and any other host gets the same behaviour for free.

use apex_geometry::{Frame, TriangleMesh};
use glam::Vec3;

use crate::component::ComponentDefinition;
use crate::document::Document;
use crate::element::{Element, ElementId};
use crate::level::LevelId;
use crate::param::ParamMap;
use crate::placement::Placement;
use crate::registry::{ComponentRegistry, RegistryError};

pub struct Project {
    document: Document,
    registry: ComponentRegistry,
    /// Per-component instance counters, so names read "Wall 1", "Wall 2".
    counters: std::collections::BTreeMap<String, u32>,
    level_counter: u32,
}

impl Default for Project {
    fn default() -> Self {
        Self::new()
    }
}

impl Project {
    pub fn new() -> Self {
        Self {
            document: Document::new(),
            registry: ComponentRegistry::with_builtins(),
            counters: Default::default(),
            level_counter: 0,
        }
    }

    pub fn document(&self) -> &Document {
        &self.document
    }

    pub fn document_mut(&mut self) -> &mut Document {
        &mut self.document
    }

    pub fn registry(&self) -> &ComponentRegistry {
        &self.registry
    }

    pub fn registry_mut(&mut self) -> &mut ComponentRegistry {
        &mut self.registry
    }

    /// The work plane of a level: horizontal at its elevation.
    pub fn work_plane(&self, level_id: LevelId) -> Frame {
        let elevation = self
            .document
            .get_level(level_id)
            .map(|l| l.elevation)
            .unwrap_or(0.0);
        Frame::horizontal(elevation)
    }

    pub fn active_work_plane(&self) -> Frame {
        self.document
            .active_level_id()
            .map(|id| self.work_plane(id))
            .unwrap_or_else(|| Frame::horizontal(0.0))
    }

    /// Build geometry without touching the document, for placement previews.
    pub fn preview(
        &self,
        component_id: &str,
        placement: &Placement,
        params: &ParamMap,
    ) -> Result<TriangleMesh, RegistryError> {
        self.registry
            .build_mesh(component_id, placement, params, self.active_work_plane())
    }

    /// Place a new element of any component type on the active level.
    pub fn create_element(
        &mut self,
        component_id: &str,
        placement: Placement,
        params: ParamMap,
    ) -> Result<ElementId, RegistryError> {
        let level_id = self
            .document
            .active_level_id()
            .ok_or_else(|| RegistryError::Unknown("no active level".to_string()))?;
        let display_name = self.registry.require(component_id)?.display_name.clone();
        let name = self.next_name(component_id, &display_name);

        // Seat the placement on the level so a pick from any view lands right.
        let elevation = self.work_plane(level_id).origin.y;
        let placement = placement.with_elevation(elevation);

        let mesh = self.registry.build_mesh(
            component_id,
            &placement,
            &params,
            self.work_plane(level_id),
        )?;

        let element = Element::new(name, component_id, level_id, placement, params);
        let id = element.id;
        self.document.upsert_element(element, mesh);
        Ok(id)
    }

    /// Apply a parameter patch and/or a new placement, then rebuild the mesh.
    pub fn update_element(
        &mut self,
        id: ElementId,
        params: Option<ParamMap>,
        placement: Option<Placement>,
    ) -> Result<(), RegistryError> {
        let mut element = self
            .document
            .get_element(id)
            .cloned()
            .ok_or_else(|| RegistryError::Unknown(id.to_string()))?;

        if let Some(patch) = params {
            element.params = element.params.merged(&patch);
        }
        if let Some(placement) = placement {
            let elevation = self.work_plane(element.level_id).origin.y;
            element.placement = placement.with_elevation(elevation);
        }

        let mesh = self
            .registry
            .build_element_mesh(&element, self.work_plane(element.level_id))?;
        self.document.update_element(element, mesh);
        Ok(())
    }

    /// Rebuild an element's mesh from its current state, after the level moved.
    pub fn rebuild_element(&mut self, id: ElementId) -> Result<(), RegistryError> {
        self.update_element(id, None, None)
    }

    pub fn delete_element(&mut self, id: ElementId) -> bool {
        self.document.remove_element(id).is_some()
    }

    pub fn add_level(&mut self, name: &str, elevation: f32) -> LevelId {
        self.level_counter += 1;
        let label = if name.trim().is_empty() {
            format!("Level {}", self.level_counter)
        } else {
            name.trim().to_string()
        };
        let (id, _) = self.document.add_level(label, elevation);
        id
    }

    /// Move a level and rebuild everything that travelled with it.
    pub fn set_level_elevation(
        &mut self,
        id: LevelId,
        elevation: f32,
    ) -> Result<(), RegistryError> {
        let (_, moved) = self
            .document
            .set_level_elevation(id, elevation)
            .map_err(RegistryError::Unknown)?;
        for element_id in moved {
            self.rebuild_element(element_id)?;
        }
        Ok(())
    }

    /// Install a component at runtime, from a module or the visual editor.
    pub fn register_component(
        &mut self,
        definition: ComponentDefinition,
    ) -> Result<(), RegistryError> {
        self.registry.upsert(definition)
    }

    /// Turn raw picks into a placement using the component's own gesture.
    pub fn placement_from_points(
        &self,
        component_id: &str,
        points: &[Vec3],
        rotation: f32,
    ) -> Result<Placement, RegistryError> {
        let definition = self.registry.require(component_id)?;
        definition
            .placement
            .build(points, rotation, &self.active_work_plane())
            .map_err(|e| RegistryError::Recipe(e.into()))
    }

    fn next_name(&mut self, component_id: &str, display_name: &str) -> String {
        let counter = self.counters.entry(component_id.to_string()).or_insert(0);
        *counter += 1;
        format!("{display_name} {counter}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::param::ParamValue;

    const EPS: f32 = 1e-4;

    fn size_of(mesh: &TriangleMesh) -> [f32; 3] {
        let (min, max) = mesh.aabb().expect("aabb");
        [max[0] - min[0], max[1] - min[1], max[2] - min[2]]
    }

    #[test]
    fn a_new_project_ships_with_the_builtin_components() {
        let project = Project::new();
        assert_eq!(project.registry().len(), 5);
        assert!(project.document().active_level_id().is_some());
    }

    #[test]
    fn creating_an_element_names_and_meshes_it() {
        let mut project = Project::new();
        let placement = Placement::line(Vec3::ZERO, Vec3::new(5.0, 0.0, 0.0));
        let id = project
            .create_element("apex.wall", placement, ParamMap::new())
            .expect("create");

        let element = project.document().get_element(id).expect("element");
        assert_eq!(element.name, "Wall 1");
        assert_eq!(element.component_id, "apex.wall");

        let mesh = project.document().get_mesh(id).expect("mesh");
        assert!((size_of(mesh)[0] - 5.0).abs() < EPS);
    }

    #[test]
    fn instance_names_count_per_component() {
        let mut project = Project::new();
        for _ in 0..2 {
            project
                .create_element(
                    "apex.wall",
                    Placement::line(Vec3::ZERO, Vec3::new(4.0, 0.0, 0.0)),
                    ParamMap::new(),
                )
                .expect("create");
        }
        project
            .create_element("apex.column", Placement::point(Vec3::ZERO), ParamMap::new())
            .expect("create");

        let names: Vec<_> = project
            .document()
            .elements()
            .map(|e| e.name.clone())
            .collect();
        assert!(names.contains(&"Wall 1".to_string()));
        assert!(names.contains(&"Wall 2".to_string()));
        assert!(names.contains(&"Column 1".to_string()));
    }

    #[test]
    fn every_builtin_can_be_placed_end_to_end() {
        let mut project = Project::new();
        let line = [Vec3::ZERO, Vec3::new(5.0, 0.0, 0.0)];
        let arc = [
            Vec3::new(5.0, 0.0, 0.0),
            Vec3::new(0.0, 0.0, 5.0),
            Vec3::new(-5.0, 0.0, 0.0),
        ];
        let point = [Vec3::new(1.0, 0.0, 1.0)];

        for (component, picks) in [
            ("apex.wall", &line[..]),
            ("apex.arc_wall", &arc[..]),
            ("apex.column", &point[..]),
            ("apex.round_column", &point[..]),
            ("apex.beam", &line[..]),
        ] {
            let placement = project
                .placement_from_points(component, picks, 0.0)
                .unwrap_or_else(|e| panic!("{component} placement: {e}"));
            let id = project
                .create_element(component, placement, ParamMap::new())
                .unwrap_or_else(|e| panic!("{component} create: {e}"));
            let mesh = project.document().get_mesh(id).expect("mesh");
            assert!(
                mesh.triangle_count() > 0,
                "{component} produced no geometry"
            );
        }
        assert_eq!(project.document().elements().count(), 5);
    }

    #[test]
    fn updating_a_param_rebuilds_the_mesh() {
        let mut project = Project::new();
        let id = project
            .create_element(
                "apex.wall",
                Placement::line(Vec3::ZERO, Vec3::new(5.0, 0.0, 0.0)),
                ParamMap::new(),
            )
            .expect("create");
        assert!((size_of(project.document().get_mesh(id).unwrap())[1] - 3.0).abs() < EPS);

        project
            .update_element(
                id,
                Some(ParamMap::new().with("height", ParamValue::Number(5.0))),
                None,
            )
            .expect("update");

        let mesh = project.document().get_mesh(id).expect("mesh");
        assert!((size_of(mesh)[1] - 5.0).abs() < EPS, "height must follow");
        assert!(
            (size_of(mesh)[2] - 0.2).abs() < EPS,
            "a partial patch must keep the other params"
        );
    }

    #[test]
    fn updating_a_placement_rebuilds_the_mesh() {
        let mut project = Project::new();
        let id = project
            .create_element(
                "apex.wall",
                Placement::line(Vec3::ZERO, Vec3::new(5.0, 0.0, 0.0)),
                ParamMap::new(),
            )
            .expect("create");

        project
            .update_element(
                id,
                None,
                Some(Placement::line(Vec3::ZERO, Vec3::new(9.0, 0.0, 0.0))),
            )
            .expect("update");

        assert!((size_of(project.document().get_mesh(id).unwrap())[0] - 9.0).abs() < EPS);
    }

    #[test]
    fn an_invalid_param_leaves_the_element_untouched() {
        let mut project = Project::new();
        let id = project
            .create_element(
                "apex.wall",
                Placement::line(Vec3::ZERO, Vec3::new(5.0, 0.0, 0.0)),
                ParamMap::new(),
            )
            .expect("create");

        let err = project.update_element(
            id,
            Some(ParamMap::new().with("height", ParamValue::Number(-1.0))),
            None,
        );
        assert!(err.is_err(), "a negative height must be refused");

        let mesh = project.document().get_mesh(id).expect("mesh");
        assert!(
            (size_of(mesh)[1] - 3.0).abs() < EPS,
            "the old geometry must survive a rejected edit"
        );
    }

    #[test]
    fn elements_are_created_on_the_active_level_plane() {
        let mut project = Project::new();
        let upper = project.add_level("", 4.0);
        project
            .document_mut()
            .set_active_level(upper)
            .expect("activate");

        let id = project
            .create_element(
                "apex.wall",
                // Picked at y=0; it must be seated on the active level.
                Placement::line(Vec3::ZERO, Vec3::new(5.0, 0.0, 0.0)),
                ParamMap::new(),
            )
            .expect("create");

        let mesh = project.document().get_mesh(id).expect("mesh");
        assert!((mesh.aabb().unwrap().0[1] - 4.0).abs() < EPS);
    }

    #[test]
    fn moving_a_level_carries_and_rebuilds_its_elements() {
        let mut project = Project::new();
        let level = project.document().active_level_id().unwrap();
        let id = project
            .create_element(
                "apex.wall",
                Placement::line(Vec3::ZERO, Vec3::new(5.0, 0.0, 0.0)),
                ParamMap::new(),
            )
            .expect("create");

        project.set_level_elevation(level, 7.5).expect("move level");

        let mesh = project.document().get_mesh(id).expect("mesh");
        let (min, max) = mesh.aabb().unwrap();
        assert!((min[1] - 7.5).abs() < EPS, "base followed the level");
        assert!((max[1] - 10.5).abs() < EPS, "and kept its height");
    }

    #[test]
    fn a_registered_component_is_placeable_immediately() {
        let mut project = Project::new();
        let json = r#"{
            "id": "acme.bollard",
            "display_name": "Bollard",
            "category": "site",
            "source": "visual",
            "placement": "point",
            "params": [{"id": "height", "label": "Height", "kind": "length", "default": 1.0}],
            "recipe": {
                "op": "extrude",
                "profile": {"shape": "circle", "radius": {"op": "const", "value": 0.1}},
                "height": {"op": "param", "id": "height"}
            }
        }"#;
        project
            .register_component(serde_json::from_str(json).expect("parse"))
            .expect("register");

        let placement = project
            .placement_from_points("acme.bollard", &[Vec3::new(2.0, 0.0, 2.0)], 0.0)
            .expect("placement");
        let id = project
            .create_element("acme.bollard", placement, ParamMap::new())
            .expect("create");

        let mesh = project.document().get_mesh(id).expect("mesh");
        assert!((size_of(mesh)[1] - 1.0).abs() < EPS);
        assert_eq!(
            project.document().get_element(id).unwrap().name,
            "Bollard 1"
        );
    }

    #[test]
    fn preview_builds_geometry_without_adding_an_element() {
        let project = Project::new();
        let mesh = project
            .preview(
                "apex.wall",
                &Placement::line(Vec3::ZERO, Vec3::new(6.0, 0.0, 0.0)),
                &ParamMap::new(),
            )
            .expect("preview");

        assert!((size_of(&mesh)[0] - 6.0).abs() < EPS);
        assert_eq!(project.document().elements().count(), 0);
    }

    #[test]
    fn deleting_removes_the_element_and_its_mesh() {
        let mut project = Project::new();
        let id = project
            .create_element(
                "apex.wall",
                Placement::line(Vec3::ZERO, Vec3::new(5.0, 0.0, 0.0)),
                ParamMap::new(),
            )
            .expect("create");

        assert!(project.delete_element(id));
        assert!(project.document().get_element(id).is_none());
        assert!(project.document().get_mesh(id).is_none());
        assert!(!project.delete_element(id), "deleting twice is a no-op");
    }

    #[test]
    fn placement_from_points_enforces_the_components_gesture() {
        let project = Project::new();
        assert!(project
            .placement_from_points("apex.wall", &[Vec3::ZERO], 0.0)
            .is_err());
        assert!(project
            .placement_from_points("apex.column", &[Vec3::ZERO], 0.0)
            .is_ok());
    }
}
