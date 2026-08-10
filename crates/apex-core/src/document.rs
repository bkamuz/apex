use std::collections::HashMap;

use apex_geometry::TriangleMesh;
use serde::{Deserialize, Serialize};

use crate::element::{Element, ElementId};
use crate::level::{Level, LevelId};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DocumentChangeKind {
    Upsert,
    Remove,
    Clear,
    LevelChanged,
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

    pub fn add_level(&mut self, name: impl Into<String>, elevation: f32) -> (LevelId, DocumentChange) {
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

    /// Set level elevation and move wall feet on that level to the new Y.
    /// Returns element ids whose wall params changed (meshes must be regenerated).
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

        let mut moved = Vec::new();
        for element in self.elements.values_mut() {
            if element.level_id != id {
                continue;
            }
            if let Some(wall) = element.wall.as_mut() {
                wall.start[1] = elevation;
                wall.end[1] = elevation;
                moved.push(element.id);
            }
        }

        Ok((self.bump(DocumentChangeKind::LevelChanged, moved.clone()), moved))
    }

    pub fn elements(&self) -> impl Iterator<Item = &Element> {
        self.elements.values()
    }

    pub fn get_element(&self, id: ElementId) -> Option<&Element> {
        self.elements.get(&id)
    }

    pub fn get_mesh(&self, id: ElementId) -> Option<&TriangleMesh> {
        self.meshes.get(&id)
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

            for tri in mesh.indices.chunks_exact(3) {
                indices.push(base + tri[0]);
                indices.push(base + tri[1]);
                indices.push(base + tri[2]);
                pick_ids.push(pick);
            }

            element_index.push(ElementSceneEntry {
                id: element.id,
                name: element.name.clone(),
                category: element.category.as_str().to_string(),
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
    pub category: String,
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
    use apex_geometry::WallParams;

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
    fn set_elevation_moves_wall_feet() {
        let mut doc = Document::new();
        let level0 = doc.active_level_id().unwrap();
        let wall = WallParams {
            start: [0.0, 0.0, 0.0],
            end: [4.0, 0.0, 0.0],
            height: 3.0,
            thickness: 0.2,
        };
        let element = Element::wall("Wall 1", level0, wall);
        let id = element.id;
        doc.upsert_element(element, TriangleMesh::empty());

        let (_change, moved) = doc.set_level_elevation(level0, 2.5).unwrap();
        assert_eq!(moved, vec![id]);
        let el = doc.get_element(id).unwrap();
        let w = el.wall.as_ref().unwrap();
        assert_eq!(w.start[1], 2.5);
        assert_eq!(w.end[1], 2.5);
        assert_eq!(doc.get_level(level0).unwrap().elevation, 2.5);
    }
}
