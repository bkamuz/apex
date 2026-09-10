//! Document plus registry: the operations a host application drives.
//!
//! Keeping this in the core means the WASM façade stays a thin translation
//! layer, and any other host gets the same behaviour for free.

use std::collections::BTreeMap;

use apex_geometry::{Frame, TriangleMesh};
use glam::Vec3;
use serde::{Deserialize, Serialize};

use crate::component::{ComponentDefinition, ComponentSource, ProfileType};
use crate::document::Document;
use crate::element::{Element, ElementId};
use crate::grid_axis::{grid_axis_param_specs, GridAxis, GridAxisId};
use crate::history::History;
use crate::level::{Level, LevelId};
use crate::param::ParamMap;
use crate::placement::{Placement, PlacementKind};
use crate::reference::{RefId, Reference, ReferenceKind};
use crate::registry::{ComponentRegistry, RegistryError};

pub struct Project {
    document: Document,
    registry: ComponentRegistry,
    /// Per-component instance counters, so names read "Wall 1", "Wall 2".
    counters: BTreeMap<String, u32>,
    /// Per-reference-kind counters, so names read "Ref point 1", "Ref plane 2".
    ref_counters: BTreeMap<String, u32>,
    grid_axis_counter: u32,
    level_counter: u32,
    history: History,
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
            ref_counters: Default::default(),
            grid_axis_counter: 0,
            level_counter: 0,
            history: History::default(),
        }
    }

    pub fn can_undo(&self) -> bool {
        self.history.can_undo()
    }

    pub fn can_redo(&self) -> bool {
        self.history.can_redo()
    }

    pub fn clear_history(&mut self) {
        self.history.clear();
    }

    /// Open a coalesced edit (e.g. anchor drag). Call before intermediate mutations.
    pub fn begin_undo_group(&mut self) {
        let before = self.export_snapshot();
        self.history.begin_transaction(before);
    }

    /// Finalize a coalesced edit started with [`Self::begin_undo_group`].
    pub fn commit_undo_group(&mut self) {
        self.history.commit_transaction();
    }

    /// Restore the previous project state. Returns `false` when the stack is empty.
    pub fn undo(&mut self) -> Result<bool, RegistryError> {
        let Some(prev) = self.history.pop_undo() else {
            return Ok(false);
        };
        let current = self.export_snapshot();
        self.history.push_redo(current);
        self.restore_snapshot(prev)?;
        Ok(true)
    }

    /// Re-apply a undone mutation. Returns `false` when the stack is empty.
    pub fn redo(&mut self) -> Result<bool, RegistryError> {
        let Some(next) = self.history.pop_redo() else {
            return Ok(false);
        };
        let current = self.export_snapshot();
        self.history.push_undo(current);
        self.restore_snapshot(next)?;
        Ok(true)
    }

    fn finish_recorded_edit(&mut self, before: Option<ProjectSnapshot>) {
        if let Some(snap) = before {
            self.history.record_before(snap);
        } else {
            self.history.commit_transaction();
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
        self.registry.build_mesh(
            component_id,
            placement,
            params,
            self.active_work_plane(),
            self.document.references(),
        )
    }

    /// Place a new element of any component type on the active level.
    pub fn create_element(
        &mut self,
        component_id: &str,
        placement: Placement,
        params: ParamMap,
    ) -> Result<ElementId, RegistryError> {
        let before = self.export_snapshot();
        let level_id = self
            .document
            .active_level_id()
            .ok_or_else(|| RegistryError::Unknown("no active level".to_string()))?;
        let display_name = self.registry.require(component_id)?.display_name.clone();
        let name = self.next_name(component_id, &display_name);

        // Seat the placement on the level so a pick from any view lands right.
        let elevation = self.work_plane(level_id).origin.y;
        let placement = placement.with_elevation(elevation);

        let params = self.registry.persistable_params(component_id, &params)?;
        let mesh = self.registry.build_mesh(
            component_id,
            &placement,
            &params,
            self.work_plane(level_id),
            self.document.references(),
        )?;
        let element = Element::new(name, component_id, level_id, placement, params);
        let id = element.id;
        self.document.upsert_element(element, mesh);
        self.history.record_before(before);
        Ok(id)
    }

    /// Apply a parameter patch and/or a new placement, then rebuild the mesh.
    ///
    /// When `record` is false, intermediate edits (e.g. live anchor drags) skip
    /// history. When a coalesced edit is open ([`Self::begin_undo_group`]),
    /// pass `record: true` on the final mutation to commit one undo step.
    pub fn update_element(
        &mut self,
        id: ElementId,
        params: Option<ParamMap>,
        placement: Option<Placement>,
        record: bool,
    ) -> Result<(), RegistryError> {
        let before = if record && !self.history.has_pending() {
            Some(self.export_snapshot())
        } else {
            None
        };
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
        element.params = self
            .registry
            .persistable_params(&element.component_id, &element.params)?;

        let mesh = self.registry.build_element_mesh(
            &element,
            self.work_plane(element.level_id),
            self.document.references(),
        )?;
        self.document.update_element(element, mesh);
        if record {
            self.finish_recorded_edit(before);
        }
        Ok(())
    }

    /// Rebuild an element's mesh from its current state, after the level moved.
    pub fn rebuild_element(&mut self, id: ElementId) -> Result<(), RegistryError> {
        self.update_element(id, None, None, false)
    }

    /// Turn raw picks into a reference placement on the active work plane.
    pub fn placement_for_reference(
        &self,
        kind: ReferenceKind,
        points: &[Vec3],
        rotation: f32,
    ) -> Result<Placement, crate::placement::PlacementError> {
        kind.placement_kind()
            .build(points, rotation, &self.active_work_plane())
    }

    /// Place a reference point or plane on the active level.
    pub fn create_reference(
        &mut self,
        kind: ReferenceKind,
        placement: Placement,
    ) -> Result<RefId, RegistryError> {
        let before = self.export_snapshot();
        let level_id = self
            .document
            .active_level_id()
            .ok_or_else(|| RegistryError::Unknown("no active level".to_string()))?;
        let name = self.next_ref_name(kind);
        let elevation = self.work_plane(level_id).origin.y;
        let placement = placement.with_elevation(elevation);
        let reference = Reference::new(name, level_id, kind, placement);
        let id = reference.id;
        self.document.upsert_reference(reference);
        self.history.record_before(before);
        Ok(id)
    }

    pub fn update_reference(
        &mut self,
        id: RefId,
        placement: Placement,
        record: bool,
    ) -> Result<(), RegistryError> {
        let before = if record && !self.history.has_pending() {
            Some(self.export_snapshot())
        } else {
            None
        };
        let mut reference = self
            .document
            .get_reference(id)
            .cloned()
            .ok_or_else(|| RegistryError::Unknown(id.to_string()))?;
        let elevation = self.work_plane(reference.level_id).origin.y;
        reference.placement = placement.with_elevation(elevation);
        self.document.upsert_reference(reference);
        self.rebuild_reference_dependents(&id.to_string())?;
        if record {
            self.finish_recorded_edit(before);
        }
        Ok(())
    }

    pub fn delete_reference(&mut self, id: RefId) -> bool {
        if self.document.get_reference(id).is_none() {
            return false;
        }
        let before = self.export_snapshot();
        let removed = self.document.remove_reference(id).is_some();
        if removed {
            self.history.record_before(before);
        }
        removed
    }

    /// Turn raw picks into a two-point line on the active work plane.
    pub fn placement_for_grid_axis(
        &self,
        points: &[Vec3],
        rotation: f32,
    ) -> Result<Placement, crate::placement::PlacementError> {
        PlacementKind::TwoPoint.build(points, rotation, &self.active_work_plane())
    }

    /// Place a grid axis on the active level.
    pub fn create_grid_axis(
        &mut self,
        placement: Placement,
        params: ParamMap,
    ) -> Result<GridAxisId, RegistryError> {
        let before = self.export_snapshot();
        let level_id = self
            .document
            .active_level_id()
            .ok_or_else(|| RegistryError::Unknown("no active level".to_string()))?;
        let name = self.next_grid_axis_name();
        let elevation = self.work_plane(level_id).origin.y;
        let placement = placement.with_elevation(elevation);
        let params = params.resolve(&grid_axis_param_specs())?;
        let axis = GridAxis::new(name, level_id, placement, params);
        let id = axis.id;
        self.document.upsert_grid_axis(axis);
        self.history.record_before(before);
        Ok(id)
    }

    pub fn update_grid_axis(
        &mut self,
        id: GridAxisId,
        params: Option<ParamMap>,
        placement: Option<Placement>,
        record: bool,
    ) -> Result<(), RegistryError> {
        let before = if record && !self.history.has_pending() {
            Some(self.export_snapshot())
        } else {
            None
        };
        let mut axis = self
            .document
            .get_grid_axis(id)
            .cloned()
            .ok_or_else(|| RegistryError::Unknown(id.to_string()))?;
        if let Some(patch) = params {
            axis.params = axis.params.merged(&patch);
        }
        if let Some(placement) = placement {
            let elevation = self.work_plane(axis.level_id).origin.y;
            axis.placement = placement.with_elevation(elevation);
        }
        axis.params = axis.params.resolve(&grid_axis_param_specs())?;
        self.document.upsert_grid_axis(axis);
        if record {
            self.finish_recorded_edit(before);
        }
        Ok(())
    }

    pub fn delete_grid_axis(&mut self, id: GridAxisId) -> bool {
        if self.document.get_grid_axis(id).is_none() {
            return false;
        }
        let before = self.export_snapshot();
        let removed = self.document.remove_grid_axis(id).is_some();
        if removed {
            self.history.record_before(before);
        }
        removed
    }

    pub fn delete_element(&mut self, id: ElementId) -> bool {
        if self.document.get_element(id).is_none() {
            return false;
        }
        let before = self.export_snapshot();
        let removed = self.document.remove_element(id).is_some();
        if removed {
            self.history.record_before(before);
        }
        removed
    }

    /// Move one or more elements by a plan-space offset.
    pub fn translate_elements(
        &mut self,
        ids: &[ElementId],
        delta: Vec3,
        record: bool,
    ) -> Result<(), RegistryError> {
        if ids.is_empty() {
            return Ok(());
        }
        let before = if record && !self.history.has_pending() {
            Some(self.export_snapshot())
        } else {
            None
        };
        for id in ids {
            let element = self
                .document
                .get_element(*id)
                .cloned()
                .ok_or_else(|| RegistryError::Unknown(id.to_string()))?;
            let placement = element.placement.translated(delta);
            self.update_element(*id, None, Some(placement), false)?;
        }
        if record {
            self.finish_recorded_edit(before);
        }
        Ok(())
    }

    /// Duplicate elements, optionally offsetting the copies. One undo step.
    pub fn copy_elements(
        &mut self,
        ids: &[ElementId],
        delta: Vec3,
    ) -> Result<Vec<ElementId>, RegistryError> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let before = self.export_snapshot();
        let mut new_ids = Vec::with_capacity(ids.len());
        for id in ids {
            let source = self
                .document
                .get_element(*id)
                .cloned()
                .ok_or_else(|| RegistryError::Unknown(id.to_string()))?;
            let display_name = self
                .registry
                .require(&source.component_id)?
                .display_name
                .clone();
            let name = self.next_name(&source.component_id, &display_name);
            let placement = source.placement.translated(delta);
            let params = self
                .registry
                .persistable_params(&source.component_id, &source.params)?;
            let mesh = self.registry.build_mesh(
                &source.component_id,
                &placement,
                &params,
                self.work_plane(source.level_id),
                self.document.references(),
            )?;
            let element = Element::new(
                name,
                source.component_id,
                source.level_id,
                placement,
                params,
            );
            let new_id = element.id;
            self.document.upsert_element(element, mesh);
            new_ids.push(new_id);
        }
        self.history.record_before(before);
        Ok(new_ids)
    }

    pub fn translate_reference(
        &mut self,
        id: RefId,
        delta: Vec3,
        record: bool,
    ) -> Result<(), RegistryError> {
        let reference = self
            .document
            .get_reference(id)
            .cloned()
            .ok_or_else(|| RegistryError::Unknown(id.to_string()))?;
        let placement = reference.placement.translated(delta);
        self.update_reference(id, placement, record)
    }

    pub fn copy_reference(&mut self, id: RefId, delta: Vec3) -> Result<RefId, RegistryError> {
        let before = self.export_snapshot();
        let source = self
            .document
            .get_reference(id)
            .cloned()
            .ok_or_else(|| RegistryError::Unknown(id.to_string()))?;
        let name = self.next_ref_name(source.kind);
        let placement = source.placement.translated(delta);
        let reference = Reference::new(name, source.level_id, source.kind, placement);
        let new_id = reference.id;
        self.document.upsert_reference(reference);
        self.rebuild_reference_dependents(&new_id.to_string())?;
        self.history.record_before(before);
        Ok(new_id)
    }

    pub fn translate_grid_axis(
        &mut self,
        id: GridAxisId,
        delta: Vec3,
        record: bool,
    ) -> Result<(), RegistryError> {
        let axis = self
            .document
            .get_grid_axis(id)
            .cloned()
            .ok_or_else(|| RegistryError::Unknown(id.to_string()))?;
        let placement = axis.placement.translated(delta);
        self.update_grid_axis(id, None, Some(placement), record)
    }

    pub fn copy_grid_axis(
        &mut self,
        id: GridAxisId,
        delta: Vec3,
    ) -> Result<GridAxisId, RegistryError> {
        let before = self.export_snapshot();
        let source = self
            .document
            .get_grid_axis(id)
            .cloned()
            .ok_or_else(|| RegistryError::Unknown(id.to_string()))?;
        let name = self.next_grid_axis_name();
        let placement = source.placement.translated(delta);
        let params = source.params.resolve(&grid_axis_param_specs())?;
        let axis = GridAxis::new(name, source.level_id, placement, params);
        let new_id = axis.id;
        self.document.upsert_grid_axis(axis);
        self.history.record_before(before);
        Ok(new_id)
    }

    pub fn add_level(&mut self, name: &str, elevation: f32) -> LevelId {
        let before = self.export_snapshot();
        self.level_counter += 1;
        let label = if name.trim().is_empty() {
            format!("Level {}", self.level_counter)
        } else {
            name.trim().to_string()
        };
        let (id, _) = self.document.add_level(label, elevation);
        self.history.record_before(before);
        id
    }

    pub fn set_active_level(&mut self, id: LevelId) -> Result<(), String> {
        let before = self.export_snapshot();
        self.document.set_active_level(id)?;
        self.history.record_before(before);
        Ok(())
    }

    /// Move a level and rebuild everything that travelled with it.
    pub fn set_level_elevation(
        &mut self,
        id: LevelId,
        elevation: f32,
    ) -> Result<(), RegistryError> {
        let before = self.export_snapshot();
        let (_, moved) = self
            .document
            .set_level_elevation(id, elevation)
            .map_err(RegistryError::Unknown)?;
        for element_id in moved {
            self.rebuild_element(element_id)?;
        }
        self.history.record_before(before);
        Ok(())
    }

    /// Install a component at runtime, from a module or the visual editor.
    pub fn register_component(
        &mut self,
        definition: ComponentDefinition,
    ) -> Result<(), RegistryError> {
        let before = self.export_snapshot();
        self.registry.upsert(definition)?;
        self.history.record_before(before);
        Ok(())
    }

    /// Install or replace a profile type, then rebuild every element that uses it.
    pub fn register_profile(&mut self, profile: ProfileType) -> Result<(), RegistryError> {
        let before = self.export_snapshot();
        let id = profile.id.clone();
        self.registry.upsert_profile(profile)?;
        self.rebuild_profile_dependents(&id)?;
        self.history.record_before(before);
        Ok(())
    }

    /// Patch type-level values on a profile and rebuild every dependent element.
    pub fn update_profile_type(&mut self, id: &str, patch: ParamMap) -> Result<(), RegistryError> {
        let before = self.export_snapshot();
        self.registry.update_profile_type_values(id, &patch)?;
        self.rebuild_profile_dependents(id)?;
        self.history.record_before(before);
        Ok(())
    }

    fn rebuild_reference_dependents(&mut self, ref_id: &str) -> Result<(), RegistryError> {
        let ids: Vec<_> = self
            .document
            .elements()
            .filter(|element| self.registry.element_uses_reference(element, ref_id))
            .map(|element| element.id)
            .collect();
        for id in ids {
            self.rebuild_element(id)?;
        }
        Ok(())
    }

    fn rebuild_profile_dependents(&mut self, profile_id: &str) -> Result<(), RegistryError> {
        let ids: Vec<_> = self
            .document
            .elements()
            .filter(|element| {
                self.registry.element_profile_id(element).as_deref() == Some(profile_id)
            })
            .map(|element| element.id)
            .collect();
        for id in ids {
            self.rebuild_element(id)?;
        }
        Ok(())
    }

    /// Turn raw picks into a placement using the component's own gesture.
    pub fn placement_from_points(
        &self,
        component_id: &str,
        points: &[Vec3],
        rotation: f32,
    ) -> Result<Placement, RegistryError> {
        self.placement_from_gesture(component_id, None, points, rotation)
    }

    /// Turn raw picks into a placement, optionally overriding the gesture.
    ///
    /// A path component (wall) accepts line, arc, or polyline. The override is
    /// how the tool says which of those the user picked. Without an override,
    /// [`PlacementKind::Path`] infers line vs polyline and never infers an arc.
    pub fn placement_from_gesture(
        &self,
        component_id: &str,
        kind: Option<PlacementKind>,
        points: &[Vec3],
        rotation: f32,
    ) -> Result<Placement, RegistryError> {
        let definition = self.registry.require(component_id)?;
        let gesture = kind.unwrap_or(definition.placement);
        let placement = gesture
            .build(points, rotation, &self.active_work_plane())
            .map_err(|e| RegistryError::Recipe(e.into()))?;
        if !definition.placement.accepts(&placement) {
            return Err(RegistryError::PlacementMismatch {
                component: definition.id.clone(),
                expected: definition.placement.as_str(),
                actual: placement.family(),
            });
        }
        Ok(placement)
    }

    fn next_name(&mut self, component_id: &str, display_name: &str) -> String {
        let counter = self.counters.entry(component_id.to_string()).or_insert(0);
        *counter += 1;
        format!("{display_name} {counter}")
    }

    fn next_ref_name(&mut self, kind: ReferenceKind) -> String {
        let key = kind.as_str().to_string();
        let counter = self.ref_counters.entry(key).or_insert(0);
        *counter += 1;
        format!("{} {counter}", kind.display_name())
    }

    fn next_grid_axis_name(&mut self) -> String {
        self.grid_axis_counter += 1;
        format!("Grid {}", self.grid_axis_counter)
    }

    /// Serializable project: levels, elements, profiles, and extra components.
    /// Meshes are rebuilt on load.
    pub fn export_snapshot(&self) -> ProjectSnapshot {
        let mut levels: Vec<Level> = self.document.levels().cloned().collect();
        levels.sort_by(|a, b| {
            a.elevation
                .partial_cmp(&b.elevation)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.name.cmp(&b.name))
        });

        let mut elements: Vec<Element> = self.document.elements().cloned().collect();
        elements.sort_by_key(|element| element.id.to_string());

        let mut profiles: Vec<ProfileType> = self.registry.profiles().values().cloned().collect();
        profiles.sort_by(|a, b| a.id.cmp(&b.id));

        let mut components: Vec<ComponentDefinition> = self
            .registry
            .components()
            .filter(|definition| !matches!(definition.source, ComponentSource::BuiltIn))
            .cloned()
            .collect();
        components.sort_by(|a, b| a.id.cmp(&b.id));

        let mut references: Vec<Reference> = self.document.references().cloned().collect();
        references.sort_by(|a, b| a.name.cmp(&b.name));

        let mut grid_axes: Vec<GridAxis> = self.document.grid_axes().cloned().collect();
        grid_axes.sort_by(|a, b| a.name.cmp(&b.name));

        ProjectSnapshot {
            format: PROJECT_FORMAT,
            levels,
            active_level: self.document.active_level_id(),
            elements,
            references,
            grid_axes,
            profiles,
            components,
            counters: self.counters.clone(),
            ref_counters: self.ref_counters.clone(),
            grid_axis_counter: self.grid_axis_counter,
            level_counter: self.level_counter,
        }
    }

    /// Replace this project from a snapshot. On failure, `self` is left unchanged.
    pub fn import_snapshot(&mut self, snap: ProjectSnapshot) -> Result<(), RegistryError> {
        self.history.clear();
        self.restore_snapshot(snap)
    }

    fn restore_snapshot(&mut self, snap: ProjectSnapshot) -> Result<(), RegistryError> {
        if snap.format != PROJECT_FORMAT && snap.format != 1 && snap.format != 2 {
            return Err(RegistryError::Unknown(format!(
                "unsupported project format {}",
                snap.format
            )));
        }

        let mut next = Project::new();
        next.history = std::mem::take(&mut self.history);
        next.counters = snap.counters;
        next.ref_counters = snap.ref_counters;
        next.grid_axis_counter = snap.grid_axis_counter;
        next.level_counter = snap.level_counter;

        for profile in snap.profiles {
            next.registry.upsert_profile(profile)?;
        }
        for definition in snap.components {
            next.registry.upsert(definition)?;
        }

        next.document.load_contents(
            snap.levels,
            snap.active_level,
            snap.elements,
            snap.references,
            snap.grid_axes,
        );

        let ids: Vec<ElementId> = next.document.elements().map(|element| element.id).collect();
        for id in ids {
            next.rebuild_element(id)?;
        }

        *self = next;
        Ok(())
    }
}

/// On-disk / download format. Bump [`PROJECT_FORMAT`] when the shape changes.
pub const PROJECT_FORMAT: u32 = 3;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectSnapshot {
    pub format: u32,
    pub levels: Vec<Level>,
    pub active_level: Option<LevelId>,
    pub elements: Vec<Element>,
    #[serde(default)]
    pub references: Vec<Reference>,
    #[serde(default)]
    pub grid_axes: Vec<GridAxis>,
    pub profiles: Vec<ProfileType>,
    #[serde(default)]
    pub components: Vec<ComponentDefinition>,
    #[serde(default)]
    pub counters: BTreeMap<String, u32>,
    #[serde(default)]
    pub ref_counters: BTreeMap<String, u32>,
    #[serde(default)]
    pub grid_axis_counter: u32,
    #[serde(default)]
    pub level_counter: u32,
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
        assert_eq!(project.registry().len(), 4);
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
        let point = [Vec3::new(1.0, 0.0, 1.0)];

        let slab = [
            Vec3::ZERO,
            Vec3::new(4.0, 0.0, 0.0),
            Vec3::new(4.0, 0.0, 3.0),
            Vec3::new(0.0, 0.0, 3.0),
        ];

        for (component, picks) in [
            ("apex.wall", &line[..]),
            ("apex.column", &point[..]),
            ("apex.beam", &line[..]),
            ("apex.slab", &slab[..]),
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
        assert_eq!(project.document().elements().count(), 4);
    }

    #[test]
    fn a_wall_is_placed_as_line_arc_or_polyline_through_the_same_type() {
        let mut project = Project::new();
        let line = [Vec3::ZERO, Vec3::new(5.0, 0.0, 0.0)];
        let arc = [
            Vec3::new(5.0, 0.0, 0.0),
            Vec3::new(0.0, 0.0, 5.0),
            Vec3::new(-5.0, 0.0, 0.0),
        ];
        let poly = [
            Vec3::ZERO,
            Vec3::new(4.0, 0.0, 0.0),
            Vec3::new(4.0, 0.0, 3.0),
        ];

        let line_p = project
            .placement_from_gesture("apex.wall", Some(PlacementKind::TwoPoint), &line, 0.0)
            .expect("line");
        let arc_p = project
            .placement_from_gesture("apex.wall", Some(PlacementKind::ThreePointArc), &arc, 0.0)
            .expect("arc");
        let poly_p = project
            .placement_from_gesture("apex.wall", Some(PlacementKind::Polyline), &poly, 0.0)
            .expect("poly");

        assert_eq!(line_p.source_kind(), PlacementKind::TwoPoint);
        assert_eq!(arc_p.source_kind(), PlacementKind::ThreePointArc);
        assert_eq!(poly_p.source_kind(), PlacementKind::Polyline);

        let line_id = project
            .create_element("apex.wall", line_p, ParamMap::new())
            .expect("create line");
        let arc_id = project
            .create_element("apex.wall", arc_p, ParamMap::new())
            .expect("create arc");
        let poly_id = project
            .create_element("apex.wall", poly_p, ParamMap::new())
            .expect("create poly");
        assert_eq!(project.document().elements().count(), 3);
        assert_eq!(
            project.document().get_element(line_id).unwrap().name,
            "Wall 1"
        );
        assert_eq!(
            project.document().get_element(arc_id).unwrap().name,
            "Wall 2"
        );
        assert_eq!(
            project.document().get_element(poly_id).unwrap().name,
            "Wall 3"
        );

        // Re-placing an arc must keep it an arc: Path::build would turn three
        // picks into a polyline.
        let wall = project.document().get_element(arc_id).unwrap();
        let kind = wall.placement.source_kind();
        let rebuilt = project
            .placement_from_gesture("apex.wall", Some(kind), &wall.placement.anchors(), 0.0)
            .expect("rebuild");
        assert_eq!(rebuilt.source_kind(), PlacementKind::ThreePointArc);

        assert!(
            project
                .placement_from_gesture("apex.wall", Some(PlacementKind::Point), &[Vec3::ZERO], 0.0)
                .is_err(),
            "a wall still rejects a point gesture"
        );
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
                true,
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
    fn translate_and_copy_elements() {
        let mut project = Project::new();
        let id = project
            .create_element("apex.column", Placement::point(Vec3::ZERO), ParamMap::new())
            .expect("create");
        project
            .translate_elements(&[id], Vec3::new(2.0, 0.0, 1.0), true)
            .expect("translate");
        let moved = project.document().get_element(id).expect("element");
        assert!((moved.placement.origin().x - 2.0).abs() < EPS);
        assert!((moved.placement.origin().z - 1.0).abs() < EPS);

        let copies = project
            .copy_elements(&[id], Vec3::new(1.0, 0.0, 0.0))
            .expect("copy");
        assert_eq!(copies.len(), 1);
        assert_eq!(project.document().elements().count(), 2);
        let copy = project.document().get_element(copies[0]).expect("copy");
        assert!((copy.placement.origin().x - 3.0).abs() < EPS);
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
                true,
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
            true,
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

    #[test]
    fn a_type_edit_rebuilds_every_element_of_that_profile() {
        let mut project = Project::new();
        let a = project
            .create_element(
                "apex.wall",
                Placement::line(Vec3::ZERO, Vec3::new(5.0, 0.0, 0.0)),
                ParamMap::new(),
            )
            .expect("a");
        let b = project
            .create_element(
                "apex.wall",
                Placement::line(Vec3::new(0.0, 0.0, 2.0), Vec3::new(5.0, 0.0, 2.0)),
                ParamMap::new(),
            )
            .expect("b");

        project
            .update_profile_type(
                "apex.wall.rect",
                ParamMap::new().with("thickness", ParamValue::Number(0.5)),
            )
            .expect("type");

        assert!((size_of(project.document().get_mesh(a).unwrap())[2] - 0.5).abs() < EPS);
        assert!((size_of(project.document().get_mesh(b).unwrap())[2] - 0.5).abs() < EPS);

        project
            .update_element(
                a,
                Some(ParamMap::new().with("height", ParamValue::Number(6.0))),
                None,
                true,
            )
            .expect("instance");
        assert!((size_of(project.document().get_mesh(a).unwrap())[1] - 6.0).abs() < EPS);
        assert!(
            (size_of(project.document().get_mesh(b).unwrap())[1] - 3.0).abs() < EPS,
            "instance height must not leak to the other wall"
        );
        assert!((size_of(project.document().get_mesh(b).unwrap())[2] - 0.5).abs() < EPS);
    }

    #[test]
    fn switching_profile_drops_instance_keys_the_new_type_does_not_have() {
        let mut project = Project::new();
        let id = project
            .create_element(
                "apex.wall",
                Placement::line(Vec3::ZERO, Vec3::new(4.0, 0.0, 0.0)),
                ParamMap::new().with("height", ParamValue::Number(5.0)),
            )
            .expect("create");
        assert_eq!(
            project
                .document()
                .get_element(id)
                .unwrap()
                .params
                .number("height"),
            Some(5.0)
        );

        project
            .update_element(
                id,
                Some(
                    ParamMap::new()
                        .with("profile", ParamValue::ProfileRef("apex.wall.round".into())),
                ),
                None,
                true,
            )
            .expect("switch");

        let params = &project.document().get_element(id).unwrap().params;
        assert_eq!(params.text("profile"), Some("apex.wall.round"));
        assert!(
            params.get("height").is_none(),
            "round walls have no instance height"
        );
    }

    #[test]
    fn a_sketched_profile_drives_the_wall_thickness() {
        use crate::param::ParamSpec;
        use crate::sketch::{ProfileSketch, SketchDimension};
        use crate::{Expr, ProfileSpec, ProfileType};

        let mut project = Project::new();
        let profile = ProfileType {
            id: "user.wall.drawn".into(),
            display_name: "Drawn".into(),
            category: "wall".into(),
            params: vec![
                ParamSpec::length("thickness", "Thickness", 0.3).as_type(),
                ParamSpec::length("height", "Height", 3.0),
            ],
            spec: ProfileSpec::Rectangle {
                width: Expr::param("thickness"),
                height: Expr::param("height"),
            },
            type_values: ParamMap::new(),
            formulas: Default::default(),
            sketch: Some(ProfileSketch {
                vertices: vec![[-0.15, -1.5], [0.15, -1.5], [0.15, 1.5], [-0.15, 1.5]],
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
                constraints: vec![],
            }),
        };
        project.register_profile(profile).expect("register");

        let id = project
            .create_element(
                "apex.wall",
                Placement::line(Vec3::ZERO, Vec3::new(4.0, 0.0, 0.0)),
                ParamMap::new().with(
                    "profile",
                    crate::param::ParamValue::ProfileRef("user.wall.drawn".into()),
                ),
            )
            .expect("create");
        assert!((size_of(project.document().get_mesh(id).unwrap())[2] - 0.3).abs() < EPS);

        project
            .update_profile_type(
                "user.wall.drawn",
                ParamMap::new().with("thickness", crate::param::ParamValue::Number(0.6)),
            )
            .expect("type");
        assert!((size_of(project.document().get_mesh(id).unwrap())[2] - 0.6).abs() < EPS);
    }

    #[test]
    fn a_project_snapshot_round_trips_elements_and_type_values() {
        let mut project = Project::new();
        let id = project
            .create_element(
                "apex.wall",
                Placement::line(Vec3::ZERO, Vec3::new(5.0, 0.0, 0.0)),
                ParamMap::new().with("height", crate::param::ParamValue::Number(4.0)),
            )
            .expect("create");
        project
            .update_profile_type(
                "apex.wall.rect",
                ParamMap::new().with("thickness", crate::param::ParamValue::Number(0.35)),
            )
            .expect("type");

        let json = serde_json::to_string(&project.export_snapshot()).expect("json");
        let snap: ProjectSnapshot = serde_json::from_str(&json).expect("parse");

        let mut restored = Project::new();
        restored.import_snapshot(snap).expect("import");

        let element = restored.document().get_element(id).expect("element");
        assert_eq!(element.name, "Wall 1");
        assert_eq!(element.params.number("height"), Some(4.0));
        assert!(
            (size_of(restored.document().get_mesh(id).unwrap())[1] - 4.0).abs() < EPS,
            "instance height survived"
        );
        assert!(
            (size_of(restored.document().get_mesh(id).unwrap())[2] - 0.35).abs() < EPS,
            "shared type thickness survived"
        );

        let next = restored
            .create_element(
                "apex.wall",
                Placement::line(Vec3::ZERO, Vec3::new(2.0, 0.0, 0.0)),
                ParamMap::new(),
            )
            .expect("next");
        assert_eq!(
            restored.document().get_element(next).unwrap().name,
            "Wall 2",
            "name counters must resume"
        );
    }

    #[test]
    fn import_rejects_an_unknown_format_and_leaves_the_project() {
        let mut project = Project::new();
        project
            .create_element("apex.column", Placement::point(Vec3::ZERO), ParamMap::new())
            .expect("create");
        let mut snap = project.export_snapshot();
        snap.format = 99;
        assert!(project.import_snapshot(snap).is_err());
        assert_eq!(project.document().elements().count(), 1);
    }

    #[test]
    fn undo_redo_place_delete_and_param_edit() {
        let mut project = Project::new();
        assert!(!project.can_undo());
        assert!(!project.can_redo());

        let id = project
            .create_element(
                "apex.wall",
                Placement::line(Vec3::ZERO, Vec3::new(5.0, 0.0, 0.0)),
                ParamMap::new(),
            )
            .expect("create");
        assert!(project.can_undo());
        assert_eq!(project.document().elements().count(), 1);

        project.undo().expect("undo create");
        assert_eq!(project.document().elements().count(), 0);
        assert!(project.can_redo());

        project.redo().expect("redo create");
        assert_eq!(project.document().elements().count(), 1);
        assert_eq!(project.document().get_element(id).unwrap().name, "Wall 1");

        project
            .update_element(
                id,
                Some(ParamMap::new().with("height", ParamValue::Number(5.0))),
                None,
                true,
            )
            .expect("update");
        assert!((size_of(project.document().get_mesh(id).unwrap())[1] - 5.0).abs() < EPS);

        project.undo().expect("undo param");
        assert!((size_of(project.document().get_mesh(id).unwrap())[1] - 3.0).abs() < EPS);

        assert!(project.delete_element(id));
        assert_eq!(project.document().elements().count(), 0);

        project.undo().expect("undo delete");
        assert_eq!(project.document().elements().count(), 1);
    }

    #[test]
    fn import_and_new_clear_history() {
        let mut project = Project::new();
        project
            .create_element("apex.column", Placement::point(Vec3::ZERO), ParamMap::new())
            .expect("create");
        assert!(project.can_undo());

        let snap = project.export_snapshot();
        project.import_snapshot(snap).expect("import");
        assert!(!project.can_undo());
        assert!(!project.can_redo());
    }

    #[test]
    fn grid_axes_round_trip_params_and_undo() {
        let mut project = Project::new();
        let axis_id = project
            .create_grid_axis(
                Placement::line(Vec3::ZERO, Vec3::new(8.0, 0.0, 0.0)),
                ParamMap::new()
                    .with("label", ParamValue::Text("A".into()))
                    .with("extension", ParamValue::Length(0.75)),
            )
            .expect("create axis");
        assert_eq!(project.document().grid_axes().count(), 1);

        let json = serde_json::to_string(&project.export_snapshot()).expect("json");
        let snap: ProjectSnapshot = serde_json::from_str(&json).expect("parse");
        assert_eq!(snap.format, PROJECT_FORMAT);
        let mut restored = Project::new();
        restored.import_snapshot(snap).expect("import");
        let axis = restored.document().get_grid_axis(axis_id).expect("axis");
        assert_eq!(axis.params.text("label"), Some("A"));

        project
            .update_grid_axis(
                axis_id,
                Some(ParamMap::new().with("label", ParamValue::Text("B".into()))),
                None,
                true,
            )
            .expect("update");
        project.undo().expect("undo label");
        assert_eq!(
            project
                .document()
                .get_grid_axis(axis_id)
                .unwrap()
                .params
                .text("label"),
            Some("A")
        );
    }

    #[test]
    fn references_round_trip_and_undo() {
        let mut project = Project::new();
        let ref_id = project
            .create_reference(
                ReferenceKind::Point,
                Placement::point(Vec3::new(2.0, 0.0, 3.0)),
            )
            .expect("create ref");
        assert_eq!(project.document().references().count(), 1);

        let json = serde_json::to_string(&project.export_snapshot()).expect("json");
        let snap: ProjectSnapshot = serde_json::from_str(&json).expect("parse");
        let mut restored = Project::new();
        restored.import_snapshot(snap).expect("import");
        assert_eq!(restored.document().references().count(), 1);
        assert_eq!(
            restored.document().get_reference(ref_id).unwrap().name,
            "Ref point 1"
        );

        project.undo().expect("undo ref create");
        assert_eq!(project.document().references().count(), 0);
    }

    #[test]
    fn a_column_can_extrude_from_a_reference_point_frame() {
        let mut project = Project::new();
        let ref_id = project
            .create_reference(
                ReferenceKind::Point,
                Placement::point(Vec3::new(4.0, 0.0, 0.0)),
            )
            .expect("ref");
        let column_id = project
            .create_element(
                "apex.column",
                Placement::point(Vec3::ZERO),
                ParamMap::new().with("frame_ref", ParamValue::ReferenceRef(ref_id.to_string())),
            )
            .expect("column");
        let mesh = project.document().get_mesh(column_id).expect("mesh");
        let (min, max) = mesh.aabb().expect("aabb");
        assert!(
            (min[0] - 3.8).abs() < EPS,
            "column sits on ref x {}",
            min[0]
        );
        assert!((max[1] - 3.0).abs() < EPS);
    }

    #[test]
    fn coalesced_placement_edit_is_one_undo_step() {
        let mut project = Project::new();
        let id = project
            .create_element(
                "apex.wall",
                Placement::line(Vec3::ZERO, Vec3::new(5.0, 0.0, 0.0)),
                ParamMap::new(),
            )
            .expect("create");
        project.undo().expect("undo create");
        project.redo().expect("redo create");

        project.begin_undo_group();
        project
            .update_element(
                id,
                None,
                Some(Placement::line(Vec3::ZERO, Vec3::new(7.0, 0.0, 0.0))),
                false,
            )
            .expect("preview");
        project
            .update_element(
                id,
                None,
                Some(Placement::line(Vec3::ZERO, Vec3::new(9.0, 0.0, 0.0))),
                true,
            )
            .expect("commit");
        assert!((size_of(project.document().get_mesh(id).unwrap())[0] - 9.0).abs() < EPS);

        project.undo().expect("undo drag");
        assert!((size_of(project.document().get_mesh(id).unwrap())[0] - 5.0).abs() < EPS);
    }
}
