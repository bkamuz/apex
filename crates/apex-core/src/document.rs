use std::collections::HashMap;

use apex_geometry::TriangleMesh;
use serde::{Deserialize, Serialize};

use crate::element::{ComponentId, Element, ElementId};
use crate::grid_axis::{GridAxis, GridAxisId, GridAxisLibrary};
use crate::level::{Level, LevelId};
use crate::reference::{RefId, Reference, ReferenceLibrary};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DocumentChangeKind {
    Upsert,
    Remove,
    Clear,
    LevelChanged,
    ReferenceChanged,
    GridAxisChanged,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentChange {
    pub kind: DocumentChangeKind,
    pub element_ids: Vec<ElementId>,
    pub version: u64,
}

/// In-memory BIM document: levels + elements + cached meshes.
#[derive(Debug, Default)]
pub struct Document {
    levels: HashMap<LevelId, Level>,
    elements: HashMap<ElementId, Element>,
    meshes: HashMap<ElementId, TriangleMesh>,
    references: ReferenceLibrary,
    grid_axes: GridAxisLibrary,
    version: u64,
    /// Level used for new placements (active work plane).
    active_level: Option<LevelId>,
}

impl Document {
    pub fn new() -> Self {
        let mut doc = Self::default();
        let level = Level::new("Level 0", 0.0);
        let id = level.id;
        doc.levels.insert(id, level);
        doc.active_level = Some(id);
        doc.version = 1;
        doc
    }

    pub fn version(&self) -> u64 {
        self.version
    }

    pub fn active_level_id(&self) -> Option<LevelId> {
        self.active_level
    }

    /// Backward-compatible alias for the active placement level.
    pub fn default_level_id(&self) -> Option<LevelId> {
        self.active_level_id()
    }

    pub fn levels(&self) -> impl Iterator<Item = &Level> {
        self.levels.values()
    }

    pub fn get_level(&self, id: LevelId) -> Option<&Level> {
        self.levels.get(&id)
    }

    pub fn add_level(
        &mut self,
        name: impl Into<String>,
        elevation: f32,
    ) -> (LevelId, DocumentChange) {
        let level = Level::new(name, elevation);
        let id = level.id;
        self.levels.insert(id, level);
        (id, self.bump(DocumentChangeKind::LevelChanged, vec![]))
    }

    pub fn set_active_level(&mut self, id: LevelId) -> Result<DocumentChange, String> {
        if !self.levels.contains_key(&id) {
            return Err("Level not found".into());
        }
        self.active_level = Some(id);
        Ok(self.bump(DocumentChangeKind::LevelChanged, vec![]))
    }

    /// Set level elevation and carry every element on that level with it.
    ///
    /// Returns the ids whose placement moved; their meshes must be rebuilt.
    /// Parent inheritance applies: an element whose parent is on the level is
    /// carried even when its own `level_id` points elsewhere.
    pub fn set_level_elevation(
        &mut self,
        id: LevelId,
        elevation: f32,
    ) -> Result<(DocumentChange, Vec<ElementId>), String> {
        let level = self
            .levels
            .get_mut(&id)
            .ok_or_else(|| "Level not found".to_string())?;
        level.elevation = elevation;

        let carried = self.elements_on_level(id);
        let mut moved = Vec::new();
        for element_id in carried {
            let Some(element) = self.elements.get_mut(&element_id) else {
                continue;
            };
            element.placement = element.placement.with_elevation(elevation);
            moved.push(element_id);
        }

        Ok((
            self.bump(DocumentChangeKind::LevelChanged, moved.clone()),
            moved,
        ))
    }

    /// Re-parent `id`, refusing anything that would create a cycle.
    ///
    /// Returns the ids whose effective level changed as a result.
    pub fn set_parent(
        &mut self,
        id: ElementId,
        parent: Option<ElementId>,
    ) -> Result<Vec<ElementId>, String> {
        if !self.elements.contains_key(&id) {
            return Err("Element not found".into());
        }
        if let Some(parent_id) = parent {
            if parent_id == id {
                return Err("An element cannot be its own parent".into());
            }
            if !self.elements.contains_key(&parent_id) {
                return Err("Parent element not found".into());
            }
            // Walking up from the proposed parent must not reach the child.
            let mut cursor = Some(parent_id);
            let mut guard = 0usize;
            while let Some(current) = cursor {
                if current == id {
                    return Err("That parent is already a descendant of this element".into());
                }
                if guard > 64 {
                    break;
                }
                cursor = self.elements.get(&current).and_then(|e| e.parent_id);
                guard += 1;
            }
        }

        let before = self.level_of_subtree(id);
        if let Some(element) = self.elements.get_mut(&id) {
            element.parent_id = parent;
        }
        let after = self.level_of_subtree(id);

        let mut changed: Vec<ElementId> = std::iter::once(id)
            .chain(self.descendants_of(id))
            .filter(|element_id| before.get(element_id) != after.get(element_id))
            .collect();
        changed.sort_by_key(|element_id| element_id.to_string());
        changed.dedup();

        // Re-seat each moved element on its new level's elevation, the same way
        // set_level_elevation does, so a child that changes level actually
        // changes height rather than just its bookkeeping.
        for element_id in &changed {
            let Some(level_id) = after.get(element_id).copied().flatten() else {
                continue;
            };
            let Some(elevation) = self.levels.get(&level_id).map(|level| level.elevation) else {
                continue;
            };
            if let Some(element) = self.elements.get_mut(element_id) {
                element.placement = element.placement.with_elevation(elevation);
            }
        }

        if !changed.is_empty() {
            self.bump(DocumentChangeKind::Upsert, changed.clone());
        }
        Ok(changed)
    }

    /// Effective level per element for `id` and its descendants.
    fn level_of_subtree(
        &self,
        id: ElementId,
    ) -> std::collections::BTreeMap<ElementId, Option<LevelId>> {
        std::iter::once(id)
            .chain(self.descendants_of(id))
            .map(|element_id| (element_id, self.effective_level_id(element_id)))
            .collect()
    }

    pub fn elements(&self) -> impl Iterator<Item = &Element> {
        self.elements.values()
    }

    pub fn get_element(&self, id: ElementId) -> Option<&Element> {
        self.elements.get(&id)
    }

    /// Direct children of `id`, in a stable order.
    pub fn children_of(&self, id: ElementId) -> Vec<ElementId> {
        let mut children: Vec<ElementId> = self
            .elements
            .values()
            .filter(|element| element.parent_id == Some(id) && element.id != id)
            .map(|element| element.id)
            .collect();
        children.sort_by_key(|child| child.to_string());
        children
    }

    /// Every descendant of `id`, breadth first, excluding `id` itself.
    ///
    /// Visited ids are tracked, so a cycle that somehow reached the document
    /// cannot spin here.
    pub fn descendants_of(&self, id: ElementId) -> Vec<ElementId> {
        let mut out = Vec::new();
        let mut seen = std::collections::BTreeSet::from([id]);
        let mut queue = vec![id];
        while let Some(current) = queue.pop() {
            for child in self.children_of(current) {
                if seen.insert(child) {
                    out.push(child);
                    queue.push(child);
                }
            }
        }
        out
    }

    /// The level an element actually sits on: its own, or the nearest ancestor's.
    ///
    /// Walks up the parent chain. A missing or self-referential parent stops the
    /// walk, so a broken link degrades to the element's own level instead of
    /// looping or panicking.
    pub fn effective_level_id(&self, id: ElementId) -> Option<LevelId> {
        let mut current = id;
        let mut guard = 0usize;
        loop {
            let element = self.elements.get(&current)?;
            match element.parent_id {
                Some(parent) if parent != current && guard < 64 => {
                    // Only follow a parent that really exists in the document.
                    if !self.elements.contains_key(&parent) {
                        return Some(element.level_id);
                    }
                    current = parent;
                    guard += 1;
                }
                _ => return Some(element.level_id),
            }
        }
    }

    /// Elements sitting on `level` once parent inheritance is applied.
    ///
    /// Used instead of comparing `element.level_id` directly, so that a child of
    /// an element on the level counts as being on that level too.
    pub fn elements_on_level(&self, level: LevelId) -> Vec<ElementId> {
        let mut ids: Vec<ElementId> = self
            .elements
            .values()
            .filter(|element| self.effective_level_id(element.id) == Some(level))
            .map(|element| element.id)
            .collect();
        ids.sort_by_key(|id| id.to_string());
        ids
    }

    pub fn get_mesh(&self, id: ElementId) -> Option<&TriangleMesh> {
        self.meshes.get(&id)
    }

    pub fn references(&self) -> impl Iterator<Item = &Reference> {
        self.references.values()
    }

    pub fn get_reference(&self, id: RefId) -> Option<&Reference> {
        self.references.get(&id)
    }

    pub fn upsert_reference(&mut self, reference: Reference) -> DocumentChange {
        let id = reference.id;
        self.references.insert(id, reference);
        self.bump(DocumentChangeKind::ReferenceChanged, vec![])
    }

    pub fn remove_reference(&mut self, id: RefId) -> Option<DocumentChange> {
        self.references.remove(&id)?;
        Some(self.bump(DocumentChangeKind::ReferenceChanged, vec![]))
    }

    pub fn grid_axes(&self) -> impl Iterator<Item = &GridAxis> {
        self.grid_axes.values()
    }

    pub fn get_grid_axis(&self, id: GridAxisId) -> Option<&GridAxis> {
        self.grid_axes.get(&id)
    }

    pub fn upsert_grid_axis(&mut self, axis: GridAxis) -> DocumentChange {
        let id = axis.id;
        self.grid_axes.insert(id, axis);
        self.bump(DocumentChangeKind::GridAxisChanged, vec![])
    }

    pub fn remove_grid_axis(&mut self, id: GridAxisId) -> Option<DocumentChange> {
        self.grid_axes.remove(&id)?;
        Some(self.bump(DocumentChangeKind::GridAxisChanged, vec![]))
    }

    pub fn upsert_element(&mut self, element: Element, mesh: TriangleMesh) -> DocumentChange {
        let id = element.id;
        self.elements.insert(id, element);
        self.meshes.insert(id, mesh);
        self.bump(DocumentChangeKind::Upsert, vec![id])
    }

    pub fn update_element(&mut self, element: Element, mesh: TriangleMesh) -> DocumentChange {
        self.upsert_element(element, mesh)
    }

    pub fn remove_element(&mut self, id: ElementId) -> Option<DocumentChange> {
        let removed = self.elements.remove(&id)?;
        self.meshes.remove(&id);
        let _ = removed;
        Some(self.bump(DocumentChangeKind::Remove, vec![id]))
    }

    pub fn clear(&mut self) -> DocumentChange {
        let ids: Vec<_> = self.elements.keys().copied().collect();
        self.elements.clear();
        self.meshes.clear();
        self.bump(DocumentChangeKind::Clear, ids)
    }

    /// Delete an element, detaching its children rather than deleting them.
    ///
    /// A child keeps its own `level_id`, so losing a parent leaves the child
    /// standing where it was instead of jumping levels. Returns the detached
    /// children along with the change.
    pub fn remove_element_detaching_children(
        &mut self,
        id: ElementId,
    ) -> Option<(DocumentChange, Vec<ElementId>)> {
        let orphans = self.descendants_of(id);
        for orphan in &orphans {
            // Only direct children get detached; deeper ones follow them.
            let is_direct = self
                .elements
                .get(orphan)
                .and_then(|element| element.parent_id)
                == Some(id);
            if is_direct {
                if let Some(element) = self.elements.get_mut(orphan) {
                    element.parent_id = None;
                }
            }
        }
        let change = self.remove_element(id)?;
        Some((change, orphans))
    }

    /// Replace levels and elements. Meshes must be rebuilt by the caller.
    pub fn load_contents(
        &mut self,
        mut levels: Vec<Level>,
        active_level: Option<LevelId>,
        elements: Vec<Element>,
        references: Vec<Reference>,
        grid_axes: Vec<GridAxis>,
    ) {
        if levels.is_empty() {
            levels.push(Level::new("Level 0", 0.0));
        }
        self.levels = levels.into_iter().map(|level| (level.id, level)).collect();
        self.elements = elements
            .into_iter()
            .map(|element| (element.id, element))
            .collect();
        self.references = references
            .into_iter()
            .map(|reference| (reference.id, reference))
            .collect();
        self.grid_axes = grid_axes.into_iter().map(|axis| (axis.id, axis)).collect();
        self.meshes.clear();
        self.active_level = active_level.filter(|id| self.levels.contains_key(id));
        if self.active_level.is_none() {
            self.active_level = self
                .levels
                .values()
                .min_by(|a, b| {
                    a.elevation
                        .partial_cmp(&b.elevation)
                        .unwrap_or(std::cmp::Ordering::Equal)
                        .then_with(|| a.name.cmp(&b.name))
                })
                .map(|level| level.id);
        }
        self.version = self.version.saturating_add(1);
    }

    /// Build a single scene mesh with per-triangle element pick ids and CAD edges.
    pub fn build_scene_buffers(&self) -> SceneBuffers {
        let mut positions = Vec::new();
        let mut normals = Vec::new();
        let mut indices = Vec::new();
        let mut pick_ids = Vec::new();
        let mut edge_positions = Vec::new();
        let mut element_index = Vec::new();

        let mut elements: Vec<_> = self.elements.values().collect();
        elements.sort_by_key(|e| e.id.to_string());

        for (ei, element) in elements.iter().enumerate() {
            let Some(mesh) = self.meshes.get(&element.id) else {
                continue;
            };
            let base = (positions.len() / 3) as u32;
            // 1-based sequential id — fits in RGBA8 picking.
            let pick = (ei as u64) + 1;

            positions.extend_from_slice(&mesh.positions);
            normals.extend_from_slice(&mesh.normals);
            edge_positions.extend_from_slice(&mesh.edges);

            for tri in mesh.indices.as_chunks::<3>().0 {
                indices.push(base + tri[0]);
                indices.push(base + tri[1]);
                indices.push(base + tri[2]);
                pick_ids.push(pick);
            }

            element_index.push(ElementSceneEntry {
                id: element.id,
                name: element.name.clone(),
                component_id: element.component_id.clone(),
                level_id: element.level_id,
                pick_id: pick,
                list_index: ei as u32,
            });
        }

        SceneBuffers {
            positions,
            normals,
            indices,
            pick_ids,
            edge_positions,
            elements: element_index,
            version: self.version,
        }
    }

    fn bump(&mut self, kind: DocumentChangeKind, element_ids: Vec<ElementId>) -> DocumentChange {
        self.version = self.version.saturating_add(1);
        DocumentChange {
            kind,
            element_ids,
            version: self.version,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ElementSceneEntry {
    pub id: ElementId,
    pub name: String,
    /// Display name and category are resolved from the component registry.
    pub component_id: ComponentId,
    pub level_id: LevelId,
    pub pick_id: u64,
    pub list_index: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SceneBuffers {
    pub positions: Vec<f32>,
    pub normals: Vec<f32>,
    pub indices: Vec<u32>,
    /// One pick id per triangle (indices.len() / 3).
    pub pick_ids: Vec<u64>,
    /// CAD edge segments: consecutive xyz pairs.
    pub edge_positions: Vec<f32>,
    pub elements: Vec<ElementSceneEntry>,
    pub version: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::param::{ParamMap, ParamValue};
    use crate::placement::Placement;
    use glam::Vec3;

    fn wall_on(level: LevelId, a: Vec3, b: Vec3) -> Element {
        Element::new(
            "Wall 1",
            "apex.wall",
            level,
            Placement::line(a, b),
            ParamMap::new().with("height", ParamValue::Length(3.0)),
        )
    }

    #[test]
    fn new_document_has_level_zero_active() {
        let doc = Document::new();
        let levels: Vec<_> = doc.levels().collect();
        assert_eq!(levels.len(), 1);
        assert_eq!(levels[0].name, "Level 0");
        assert_eq!(levels[0].elevation, 0.0);
        assert_eq!(doc.active_level_id(), Some(levels[0].id));
    }

    #[test]
    fn add_and_activate_level() {
        let mut doc = Document::new();
        let (id, _) = doc.add_level("Level 1", 3.0);
        assert_eq!(doc.levels().count(), 2);
        doc.set_active_level(id).unwrap();
        assert_eq!(doc.active_level_id(), Some(id));
        assert_eq!(doc.get_level(id).unwrap().elevation, 3.0);
    }

    #[test]
    fn set_elevation_carries_every_element_on_the_level() {
        let mut doc = Document::new();
        let level0 = doc.active_level_id().unwrap();
        let element = wall_on(level0, Vec3::ZERO, Vec3::new(4.0, 0.0, 0.0));
        let id = element.id;
        doc.upsert_element(element, TriangleMesh::empty());

        let (_change, moved) = doc.set_level_elevation(level0, 2.5).unwrap();
        assert_eq!(moved, vec![id]);

        let placement = &doc.get_element(id).unwrap().placement;
        for anchor in placement.anchors() {
            assert_eq!(anchor.y, 2.5, "anchor {anchor} should follow the level");
        }
        assert_eq!(doc.get_level(level0).unwrap().elevation, 2.5);
    }

    #[test]
    fn moving_one_level_leaves_the_others_alone() {
        let mut doc = Document::new();
        let level0 = doc.active_level_id().unwrap();
        let (level1, _) = doc.add_level("Level 1", 3.0);

        let stays = wall_on(level0, Vec3::ZERO, Vec3::new(4.0, 0.0, 0.0));
        let stays_id = stays.id;
        doc.upsert_element(stays, TriangleMesh::empty());
        let moves = wall_on(level1, Vec3::ZERO, Vec3::new(4.0, 3.0, 0.0));
        let moves_id = moves.id;
        doc.upsert_element(moves, TriangleMesh::empty());

        let (_, moved) = doc.set_level_elevation(level1, 6.0).unwrap();
        assert_eq!(moved, vec![moves_id]);
        assert_eq!(doc.get_element(stays_id).unwrap().placement.origin().y, 0.0);
        assert_eq!(doc.get_element(moves_id).unwrap().placement.origin().y, 6.0);
    }

    #[test]
    fn scene_entries_expose_the_component_id_for_the_ui_to_resolve() {
        let mut doc = Document::new();
        let level0 = doc.active_level_id().unwrap();
        doc.upsert_element(
            wall_on(level0, Vec3::ZERO, Vec3::new(4.0, 0.0, 0.0)),
            TriangleMesh::empty(),
        );

        let buffers = doc.build_scene_buffers();
        assert_eq!(buffers.elements.len(), 1);
        assert_eq!(buffers.elements[0].component_id, "apex.wall");
        assert_eq!(buffers.elements[0].level_id, level0);
        assert_eq!(buffers.elements[0].pick_id, 1, "pick ids are 1-based");
    }

    #[test]
    fn the_document_holds_any_component_type_without_knowing_it() {
        let mut doc = Document::new();
        let level = doc.active_level_id().unwrap();
        for component in ["apex.wall", "apex.column", "acme.customThing"] {
            doc.upsert_element(
                Element::new(
                    component,
                    component,
                    level,
                    Placement::point(Vec3::ZERO),
                    ParamMap::new(),
                ),
                TriangleMesh::empty(),
            );
        }

        let ids: std::collections::BTreeSet<_> = doc
            .build_scene_buffers()
            .elements
            .iter()
            .map(|e| e.component_id.clone())
            .collect();
        assert_eq!(ids.len(), 3, "no component type is privileged");
    }
}
