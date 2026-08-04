use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::element::{Element, ElementId};
use crate::level::{Level, LevelId};
use crate::mesh::TriangleMesh;

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
    default_level: Option<LevelId>,
}

impl Document {
    pub fn new() -> Self {
        let mut doc = Self::default();
        let level = Level::new("Level 0", 0.0);
        let id = level.id;
        doc.levels.insert(id, level);
        doc.default_level = Some(id);
        doc.version = 1;
        doc
    }

    pub fn version(&self) -> u64 {
        self.version
    }

    pub fn default_level_id(&self) -> Option<LevelId> {
        self.default_level
    }

    pub fn levels(&self) -> impl Iterator<Item = &Level> {
        self.levels.values()
    }

    pub fn get_level(&self, id: LevelId) -> Option<&Level> {
        self.levels.get(&id)
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
