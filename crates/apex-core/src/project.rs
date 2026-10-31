//! Document plus registry: the operations a host application drives.
//!
//! Keeping this in the core means the WASM façade stays a thin translation
//! layer, and any other host gets the same behaviour for free.

use std::collections::BTreeMap;

mod booleans;
pub mod commands;
mod genus_build;
pub mod kernel;
mod memo;
mod roof_attach;
mod slab_shape;
pub use genus_build::GenusParamInput;
pub use roof_attach::AttachEnd;
pub use slab_shape::{ShapeHandle, ShapeInfo, SlabShape};
mod solids;
pub use solids::{element_build_ms, element_builds};
mod space_labels;
pub use booleans::boolean_params;

use apex_geometry::{Frame, TriangleMesh};
use glam::Vec3;
use serde::{Deserialize, Serialize};

use crate::component::{ComponentDefinition, ComponentSource, ProfileType};
use crate::construction_line::{
    construction_line_param_specs, ConstructionLine, ConstructionLineId,
};
use crate::document::Document;
use crate::element::{Element, ElementId};
use crate::genus::SPECIES_PARAM;
use crate::grid_axis::{grid_axis_param_specs, GridAxis, GridAxisId};
use crate::history::History;
use crate::level::{Level, LevelId};
use crate::param::{ParamMap, ParamValue};
use crate::path_join::{joinable_segment, peers_for, plan_joins};
use crate::path_snap::{collect_joinable_snap_targets, PathSnapTarget};
use crate::path_stretch::{plan_stretch_from_edit, plan_stretch_translate};
use crate::placement::{Placement, PlacementKind};
use crate::reference::{RefId, Reference, ReferenceKind};
use crate::registry::{ComponentRegistry, RegistryError};
use crate::room_detect::{detect_room_polygons, wall_centerline_segments, ENDPOINT_SNAP};
use crate::section_cut::{section_cut_param_specs, SectionCut, SectionCutId};
use crate::space::{space_is_auto, space_param_specs, Space, SpaceId};

/// Fallback storey height when a level has no level above it.
const DEFAULT_STOREY_RISE: f32 = 3.0;
const STAIR_COMPONENT: &str = "apex.stair";

/// Axis-aligned void for a hosted opening, used by [`TriangleMesh::punch_aabbs`].
/// Punch a box that is axis-aligned in a frame yawed by `yaw` about +Y
/// through `center` (the box is given in world coordinates as if yaw = 0).
fn punch_rotated_box(
    mesh: &TriangleMesh,
    yaw: f32,
    center: Vec3,
    min: [f32; 3],
    max: [f32; 3],
) -> TriangleMesh {
    if yaw.abs() < 1e-6 {
        return mesh.punch_aabbs(&[(min, max)]);
    }
    let rotate = |m: &TriangleMesh, a: f32| rotate_about_y(m, a, center);
    // Rotating by -yaw with this convention maps the wall direction onto +X.
    let local = rotate(mesh, -yaw);
    rotate(&local.punch_aabbs(&[(min, max)]), yaw)
}

/// The solid of a rotated box void (see [`punch_rotated_box`]).
fn rotated_box_mesh(yaw: f32, center: Vec3, min: [f32; 3], max: [f32; 3]) -> TriangleMesh {
    let b = apex_geometry::box_mesh(min, max);
    if yaw.abs() < 1e-6 {
        b
    } else {
        rotate_about_y(&b, yaw, center)
    }
}

/// Rotate a mesh by `a` about +Y through `center`.
fn rotate_about_y(m: &TriangleMesh, a: f32, center: Vec3) -> TriangleMesh {
    let (s, c) = a.sin_cos();
    let mut out = m.clone();
    let rot = |x: f32, z: f32, ox: f32, oz: f32| {
        let (dx, dz) = (x - ox, z - oz);
        (ox + dx * c + dz * s, oz - dx * s + dz * c)
    };
    for p in out.positions.chunks_mut(3) {
        let (x, z) = rot(p[0], p[2], center.x, center.z);
        p[0] = x;
        p[2] = z;
    }
    for p in out.edges.chunks_mut(3) {
        let (x, z) = rot(p[0], p[2], center.x, center.z);
        p[0] = x;
        p[2] = z;
    }
    for n in out.normals.chunks_mut(3) {
        let (x, z) = rot(n[0], n[2], 0.0, 0.0);
        n[0] = x;
        n[2] = z;
    }
    out
}

fn opening_void_aabb(
    opening: &Element,
    definition: &ComponentDefinition,
) -> Option<([f32; 3], [f32; 3])> {
    let params = definition.resolve_params(&opening.params).ok()?;
    let origin = opening.placement.origin();
    if definition.placement == PlacementKind::Polyline {
        let anchors = opening.placement.anchors();
        if anchors.len() < 3 {
            return None;
        }
        let depth = params.number("depth").unwrap_or(0.5) as f32;
        let mut min = anchors[0].to_array();
        let mut max = min;
        for p in &anchors {
            let a = p.to_array();
            for i in 0..3 {
                min[i] = min[i].min(a[i]);
                max[i] = max[i].max(a[i]);
            }
        }
        min[1] -= 0.05;
        max[1] += depth + 0.05;
        return Some((min, max));
    }
    let width = params.number("width").unwrap_or(0.9) as f32;
    let height = params.number("height").unwrap_or(2.1) as f32;
    let sill = params.number("sill").unwrap_or(0.0) as f32;
    // Generous depth so the punch clears typical wall thickness.
    let depth = 1.2_f32;
    let min = [
        origin.x - width * 0.5,
        origin.y + sill - 0.02,
        origin.z - depth * 0.5,
    ];
    let max = [
        origin.x + width * 0.5,
        origin.y + sill + height + 0.02,
        origin.z + depth * 0.5,
    ];
    Some((min, max))
}

/// Closest point on a line / polyline host curve in plan.
fn project_onto_curve_xz(curve: &apex_geometry::Curve, p: Vec3) -> Option<Vec3> {
    let pts: Vec<Vec3> = match curve {
        apex_geometry::Curve::Line { a, b } => vec![*a, *b],
        apex_geometry::Curve::Polyline { points } => points.clone(),
        _ => return None,
    };
    let mut best: Option<(Vec3, f32)> = None;
    for w in pts.windows(2) {
        let (a, b) = (w[0], w[1]);
        let ab = Vec3::new(b.x - a.x, 0.0, b.z - a.z);
        let len2 = ab.length_squared();
        if len2 < 1e-12 {
            continue;
        }
        let t = (((p.x - a.x) * ab.x + (p.z - a.z) * ab.z) / len2).clamp(0.0, 1.0);
        let q = Vec3::new(a.x + ab.x * t, p.y, a.z + ab.z * t);
        let d = (q - p).length_squared();
        if best.map(|(_, bd)| d < bd).unwrap_or(true) {
            best = Some((q, d));
        }
    }
    best.map(|(q, _)| q)
}

pub struct Project {
    document: Document,
    registry: ComponentRegistry,
    /// Per-component instance counters, so names read "Wall 1", "Wall 2".
    counters: BTreeMap<String, u32>,
    /// Per-reference-kind counters, so names read "Ref point 1", "Ref plane 2".
    ref_counters: BTreeMap<String, u32>,
    grid_axis_counter: u32,
    construction_line_counter: u32,
    section_cut_counter: u32,
    space_counter: u32,
    level_counter: u32,
    pub(crate) views: crate::view::ViewLibrary,
    pub(crate) sheets: crate::sheet::SheetLibrary,
    pub(crate) view_counter: u32,
    pub(crate) sheet_counter: u32,
    pub(crate) view_annotations: crate::view_annotation::ViewAnnotationLibrary,
    pub(crate) view_annotation_counter: u32,
    history: History,
    pub(crate) kernel: kernel::KernelSlot,
    pub(crate) memo: memo::SolidMemo,
    /// When >0, placement edits skip connected-joinable stretch (batch translate
    /// plans stretch itself so multi-select movers are not double-pulled).
    suppress_join_stretch: u32,
}

impl Default for Project {
    fn default() -> Self {
        Self::new()
    }
}

impl Project {
    pub fn new() -> Self {
        let mut project = Self {
            document: Document::new(),
            registry: ComponentRegistry::with_builtins(),
            counters: Default::default(),
            ref_counters: Default::default(),
            grid_axis_counter: 0,
            construction_line_counter: 0,
            section_cut_counter: 0,
            space_counter: 0,
            level_counter: 0,
            views: Default::default(),
            sheets: Default::default(),
            view_counter: 0,
            sheet_counter: 0,
            view_annotations: Default::default(),
            view_annotation_counter: 0,
            history: History::default(),
            kernel: Default::default(),
            memo: Default::default(),
            suppress_join_stretch: 0,
        };
        project.ensure_default_views();
        project
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

    /// Discard an open undo group without recording (cancelled gesture).
    pub fn abort_undo_group(&mut self) {
        self.history.abort_transaction();
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

    /// Record a snapshot for undo after a view/sheet/annotation edit (sibling modules).
    pub(crate) fn push_undo_snapshot(&mut self, before: ProjectSnapshot) {
        self.history.record_before(before);
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
        self.create_element_with_parent(component_id, placement, params, None)
    }

    /// Place a new element, optionally parenting it (openings host-cut their parent).
    ///
    /// Joinable path components auto-join with peers of the same component id
    /// on the level (corner miters / T-junctions). Create + joins are one undo step.
    pub fn create_element_with_parent(
        &mut self,
        component_id: &str,
        placement: Placement,
        params: ParamMap,
        parent: Option<ElementId>,
    ) -> Result<ElementId, RegistryError> {
        let definition = self.registry.require(component_id)?.clone();
        let is_stair = component_id == STAIR_COMPONENT;
        let auto_join = (definition.joinable || is_stair) && !self.history.has_pending();
        if auto_join {
            self.begin_undo_group();
        }
        let before = self.export_snapshot();
        let level_id = if let Some(parent_id) = parent {
            self.document
                .effective_level_id(parent_id)
                .or_else(|| self.document.active_level_id())
                .ok_or_else(|| RegistryError::Unknown("no active level".to_string()))?
        } else {
            self.document
                .active_level_id()
                .ok_or_else(|| RegistryError::Unknown("no active level".to_string()))?
        };
        let display_name = definition.display_name.clone();
        let name = self.next_name(component_id, &display_name);

        let placement = if definition.placement_options.seat_on_level {
            let elevation = self.work_plane(level_id).origin.y;
            placement.with_elevation(elevation)
        } else {
            placement
        };

        let mut raw_params = params;
        self.registry
            .normalize_species_key(component_id, &mut raw_params);
        if let Some(type_id) = self
            .registry
            .resolve_instance_type(component_id, None, &raw_params)
        {
            self.registry.apply_type_values(&type_id, &mut raw_params);
        }
        let mut params = self
            .registry
            .persistable_params(component_id, &raw_params)?;
        self.apply_level_height_defaults(component_id, level_id, &mut params, &raw_params);

        let mut element = Element::new(name, component_id, level_id, placement, params);
        if let Some(parent_id) = parent {
            element.parent_id = Some(parent_id);
        }
        let id = element.id;
        let mesh = self.build_element_mesh_with_cuts(&element)?;
        self.document.upsert_element(element, mesh);
        if parent.is_some() {
            // Host must rebuild so the new opening punches through.
            if let Some(parent_id) = parent {
                self.rebuild_element(parent_id)?;
            }
        }
        self.history.record_before(before);

        if definition.joinable {
            let _ = self.apply_path_joins(id, false)?;
        }
        // Neighbours re-mitre / re-partition; slabs pick up a new stair well.
        if let Some(created) = self.document.get_element(id).cloned() {
            // The new element itself too: its first build ran before it
            // was in the document, so it saw no neighbours.
            let mut deps = vec![id];
            deps.extend(self.solid_dependents(&created));
            self.refresh_meshes(deps);
        }
        if auto_join {
            self.commit_undo_group();
        }
        Ok(id)
    }

    /// Recompute path joins for a joinable element against peers on its level.
    ///
    /// Plugins can call this after a manual placement edit. Returns how many
    /// elements had their placement rewritten. One undo step when `record`.
    pub fn join_paths(&mut self, id: ElementId) -> Result<usize, RegistryError> {
        self.apply_path_joins(id, true)
    }

    /// Snap targets (ends / mids / T-vertices) for joinable peers of `component_id`
    /// on the active level. Used by placement tools — no per-type branches.
    pub fn joinable_snap_targets(
        &self,
        component_id: &str,
        exclude: &[ElementId],
    ) -> Vec<PathSnapTarget> {
        let Some(level_id) = self.document.active_level_id() else {
            return Vec::new();
        };
        let elements: Vec<Element> = self
            .document
            .elements_on_level(level_id)
            .into_iter()
            .filter_map(|id| self.document.get_element(id).cloned())
            .collect();
        collect_joinable_snap_targets(
            &self.registry,
            elements.into_iter(),
            component_id,
            level_id,
            exclude,
        )
    }

    fn apply_path_joins(&mut self, id: ElementId, record: bool) -> Result<usize, RegistryError> {
        let element = self
            .document
            .get_element(id)
            .cloned()
            .ok_or_else(|| RegistryError::Unknown(id.to_string()))?;
        let Some(new_seg) = joinable_segment(&self.registry, &element) else {
            return Ok(0);
        };
        let peers: Vec<_> = peers_for(&self.registry, self.document.elements(), &element);
        let updates = plan_joins(&new_seg, &peers);
        if updates.is_empty() {
            return Ok(0);
        }

        let started = record && !self.history.has_pending();
        if started {
            self.begin_undo_group();
        }
        let mut count = 0usize;
        for update in updates {
            self.apply_join_update(update, false)?;
            count += 1;
        }
        if started {
            self.commit_undo_group();
        }
        Ok(count)
    }

    fn apply_join_update(
        &mut self,
        update: crate::path_join::JoinUpdate,
        record: bool,
    ) -> Result<(), RegistryError> {
        let before = if record && !self.history.has_pending() {
            Some(self.export_snapshot())
        } else {
            None
        };
        let mut element = self
            .document
            .get_element(update.id)
            .cloned()
            .ok_or_else(|| RegistryError::Unknown(update.id.to_string()))?;

        if let Some(placement) = update.placement {
            let seat = self
                .registry
                .get(&element.component_id)
                .map(|def| def.placement_options.seat_on_level)
                .unwrap_or(true);
            let level_id = self
                .document
                .effective_level_id(update.id)
                .unwrap_or(element.level_id);
            element.placement = if seat {
                let elevation = self.work_plane(level_id).origin.y;
                placement.with_elevation(elevation)
            } else {
                placement
            };
        }
        element.join_start = update.join_start;
        element.join_end = update.join_end;

        let mesh = self.build_element_mesh_with_cuts(&element)?;
        self.document.update_element(element, mesh);
        if let Some(snap) = before {
            self.history.record_before(snap);
        }
        Ok(())
    }

    pub fn update_element(
        &mut self,
        id: ElementId,
        params: Option<ParamMap>,
        placement: Option<Placement>,
        record: bool,
    ) -> Result<(), RegistryError> {
        self.memo.enter();
        let out = self.update_element_unscoped(id, params, placement, record);
        self.memo.leave();
        out
    }

    /// Apply a parameter patch and/or a new placement, then rebuild the mesh.
    ///
    /// When `record` is false, intermediate edits (e.g. live anchor drags) skip
    /// history. When a coalesced edit is open ([`Self::begin_undo_group`]),
    /// pass `record: true` on the final mutation to commit one undo step.
    ///
    /// Joinable path placement edits also stretch connected peers (shared
    /// endpoints / T-vertices follow) unless [`Self::suppress_join_stretch`] is set.
    fn update_element_unscoped(
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
        // Solids that depended on the old state (join neighbours, slabs
        // under a stair) must follow the edit too.
        let old_dependents = self.solid_dependents(&element);
        let old_placement = element.placement.clone();
        let placement_changed = placement.is_some();

        let mut patch = params.unwrap_or_default();
        self.registry
            .normalize_species_key(&element.component_id, &mut patch);
        let current_type = element.params.text(SPECIES_PARAM).map(str::to_string);
        element.params = element.params.merged(&patch);
        if let Some(type_id) = self.registry.resolve_instance_type(
            &element.component_id,
            current_type.as_deref(),
            &patch,
        ) {
            self.registry
                .apply_type_values(&type_id, &mut element.params);
        }
        // A child is built against its parent's level, not its own.
        let level_id = self
            .document
            .effective_level_id(id)
            .unwrap_or(element.level_id);
        if let Some(placement) = placement {
            let seat = self
                .registry
                .get(&element.component_id)
                .map(|def| def.placement_options.seat_on_level)
                .unwrap_or(true);
            element.placement = if seat {
                let elevation = self.work_plane(level_id).origin.y;
                placement.with_elevation(elevation)
            } else {
                placement
            };
        }
        element.params = self
            .registry
            .persistable_params(&element.component_id, &element.params)?;

        let is_opening = self
            .registry
            .get(&element.component_id)
            .and_then(|d| d.host_cut.as_ref())
            .is_some();
        let parent_id = element.parent_id;
        let new_placement = element.placement.clone();
        let joinable = self
            .registry
            .get(&element.component_id)
            .is_some_and(|d| d.joinable);
        let mesh = self.build_element_mesh_with_cuts(&element)?;
        let new_dependents = self.solid_dependents(&element);
        self.document.update_element(element, mesh);
        // A wall in a roof-attached join cluster renders a share of the
        // whole cluster, which only reads right once this edit is in the
        // document: rebuild the cluster (itself included) now.
        let cluster = self
            .document
            .get_element(id)
            .filter(|e| self.in_attached_cluster(e))
            .map(|e| self.join_cluster(e))
            .unwrap_or_default();
        self.refresh_meshes(
            old_dependents
                .into_iter()
                .chain(new_dependents)
                .chain(cluster),
        );
        if is_opening {
            if let Some(parent_id) = parent_id {
                let _ = self.rebuild_element(parent_id);
            }
        } else {
            // Hosted openings take their orientation from this host: refresh
            // their meshes (not via update_element, which would recurse here).
            for child_id in self.document.children_of(id) {
                let Some(child) = self.document.get_element(child_id).cloned() else {
                    continue;
                };
                if self.hosted_opening_yaw(&child).is_none() {
                    continue;
                }
                if let Ok(mesh) = self.build_element_mesh_with_cuts(&child) {
                    self.document.update_element(child, mesh);
                }
            }
        }

        if placement_changed && joinable && self.suppress_join_stretch == 0 {
            self.propagate_joinable_stretch(id, &old_placement, &new_placement)?;
        }

        if record {
            self.finish_recorded_edit(before);
        }
        Ok(())
    }

    /// Stretch joinable peers whose vertices coincided with `old` so they
    /// follow the corresponding points on `new`. Re-runs path joins.
    fn propagate_joinable_stretch(
        &mut self,
        source_id: ElementId,
        old_placement: &Placement,
        new_placement: &Placement,
    ) -> Result<(), RegistryError> {
        let (Some(old_curve), Some(new_curve)) = (old_placement.curve(), new_placement.curve())
        else {
            return Ok(());
        };
        let Some(source) = self.document.get_element(source_id).cloned() else {
            return Ok(());
        };
        let peers = peers_for(&self.registry, self.document.elements(), &source);
        let updates = plan_stretch_from_edit(source_id, old_curve, new_curve, &peers);
        if updates.is_empty() {
            let _ = self.apply_path_joins(source_id, false);
            return Ok(());
        }
        self.suppress_join_stretch += 1;
        let result: Result<(), RegistryError> = (|| {
            let mut join_ids = vec![source_id];
            for update in updates {
                join_ids.push(update.id);
                self.update_element(update.id, None, Some(update.placement), false)?;
            }
            for id in join_ids {
                let _ = self.apply_path_joins(id, false);
            }
            Ok(())
        })();
        self.suppress_join_stretch = self.suppress_join_stretch.saturating_sub(1);
        result
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
        let mut params = params;
        if params.get("label").is_none() {
            params.set(
                "label",
                ParamValue::Text(self.next_grid_axis_label(&placement)),
            );
        }
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

    /// Turn raw picks into a two-point line on the active work plane.
    pub fn placement_for_construction_line(
        &self,
        points: &[Vec3],
        rotation: f32,
    ) -> Result<Placement, crate::placement::PlacementError> {
        PlacementKind::TwoPoint.build(points, rotation, &self.active_work_plane())
    }

    pub fn create_construction_line(
        &mut self,
        placement: Placement,
        params: ParamMap,
    ) -> Result<ConstructionLineId, RegistryError> {
        let before = self.export_snapshot();
        let level_id = self
            .document
            .active_level_id()
            .ok_or_else(|| RegistryError::Unknown("no active level".to_string()))?;
        let name = self.next_construction_line_name();
        let elevation = self.work_plane(level_id).origin.y;
        let placement = placement.with_elevation(elevation);
        let params = params.resolve(&construction_line_param_specs())?;
        let line = ConstructionLine::new(name, level_id, placement, params);
        let id = line.id;
        self.document.upsert_construction_line(line);
        self.history.record_before(before);
        Ok(id)
    }

    pub fn update_construction_line(
        &mut self,
        id: ConstructionLineId,
        params: Option<ParamMap>,
        placement: Option<Placement>,
        record: bool,
    ) -> Result<(), RegistryError> {
        let before = if record && !self.history.has_pending() {
            Some(self.export_snapshot())
        } else {
            None
        };
        let mut line = self
            .document
            .get_construction_line(id)
            .cloned()
            .ok_or_else(|| RegistryError::Unknown(id.to_string()))?;
        if let Some(patch) = params {
            line.params = line.params.merged(&patch);
        }
        if let Some(placement) = placement {
            let elevation = self.work_plane(line.level_id).origin.y;
            line.placement = placement.with_elevation(elevation);
        }
        line.params = line.params.resolve(&construction_line_param_specs())?;
        self.document.upsert_construction_line(line);
        if record {
            self.finish_recorded_edit(before);
        }
        Ok(())
    }

    pub fn delete_construction_line(&mut self, id: ConstructionLineId) -> bool {
        if self.document.get_construction_line(id).is_none() {
            return false;
        }
        let before = self.export_snapshot();
        let removed = self.document.remove_construction_line(id).is_some();
        if removed {
            self.history.record_before(before);
        }
        removed
    }

    pub fn translate_construction_line(
        &mut self,
        id: ConstructionLineId,
        delta: Vec3,
        record: bool,
    ) -> Result<(), RegistryError> {
        let line = self
            .document
            .get_construction_line(id)
            .cloned()
            .ok_or_else(|| RegistryError::Unknown(id.to_string()))?;
        let placement = line.placement.translated(delta);
        self.update_construction_line(id, None, Some(placement), record)
    }

    pub fn copy_construction_line(
        &mut self,
        id: ConstructionLineId,
        delta: Vec3,
    ) -> Result<ConstructionLineId, RegistryError> {
        let before = self.export_snapshot();
        let source = self
            .document
            .get_construction_line(id)
            .cloned()
            .ok_or_else(|| RegistryError::Unknown(id.to_string()))?;
        let name = self.next_construction_line_name();
        let placement = source.placement.translated(delta);
        let params = source.params.resolve(&construction_line_param_specs())?;
        let line = ConstructionLine::new(name, source.level_id, placement, params);
        let new_id = line.id;
        self.document.upsert_construction_line(line);
        self.history.record_before(before);
        Ok(new_id)
    }

    pub fn placement_for_section_cut(
        &self,
        points: &[Vec3],
        rotation: f32,
    ) -> Result<Placement, crate::placement::PlacementError> {
        PlacementKind::TwoPoint.build(points, rotation, &self.active_work_plane())
    }

    pub fn create_section_cut(
        &mut self,
        placement: Placement,
        params: ParamMap,
    ) -> Result<SectionCutId, RegistryError> {
        let before = self.export_snapshot();
        let level_id = self
            .document
            .active_level_id()
            .ok_or_else(|| RegistryError::Unknown("no active level".to_string()))?;
        let name = self.next_section_cut_name();
        let elevation = self.work_plane(level_id).origin.y;
        let placement = placement.with_elevation(elevation);
        let params = params.resolve(&section_cut_param_specs())?;
        let cut = SectionCut::new(name, level_id, placement, params);
        let id = cut.id;
        self.document.upsert_section_cut(cut);
        self.history.record_before(before);
        Ok(id)
    }

    pub fn update_section_cut(
        &mut self,
        id: SectionCutId,
        params: Option<ParamMap>,
        placement: Option<Placement>,
        record: bool,
    ) -> Result<(), RegistryError> {
        let before = if record && !self.history.has_pending() {
            Some(self.export_snapshot())
        } else {
            None
        };
        let mut cut = self
            .document
            .get_section_cut(id)
            .cloned()
            .ok_or_else(|| RegistryError::Unknown(id.to_string()))?;
        if let Some(patch) = params {
            cut.params = cut.params.merged(&patch);
        }
        if let Some(placement) = placement {
            let elevation = self.work_plane(cut.level_id).origin.y;
            cut.placement = placement.with_elevation(elevation);
        }
        cut.params = cut.params.resolve(&section_cut_param_specs())?;
        self.document.upsert_section_cut(cut);
        if record {
            self.finish_recorded_edit(before);
        }
        Ok(())
    }

    pub fn delete_section_cut(&mut self, id: SectionCutId) -> bool {
        if self.document.get_section_cut(id).is_none() {
            return false;
        }
        let before = self.export_snapshot();
        let removed = self.document.remove_section_cut(id).is_some();
        if removed {
            self.history.record_before(before);
        }
        removed
    }

    pub fn translate_section_cut(
        &mut self,
        id: SectionCutId,
        delta: Vec3,
        record: bool,
    ) -> Result<(), RegistryError> {
        let cut = self
            .document
            .get_section_cut(id)
            .cloned()
            .ok_or_else(|| RegistryError::Unknown(id.to_string()))?;
        let placement = cut.placement.translated(delta);
        self.update_section_cut(id, None, Some(placement), record)
    }

    pub fn copy_section_cut(
        &mut self,
        id: SectionCutId,
        delta: Vec3,
    ) -> Result<SectionCutId, RegistryError> {
        let before = self.export_snapshot();
        let source = self
            .document
            .get_section_cut(id)
            .cloned()
            .ok_or_else(|| RegistryError::Unknown(id.to_string()))?;
        let name = self.next_section_cut_name();
        let placement = source.placement.translated(delta);
        let params = source.params.resolve(&section_cut_param_specs())?;
        let cut = SectionCut::new(name, source.level_id, placement, params);
        let new_id = cut.id;
        self.document.upsert_section_cut(cut);
        self.history.record_before(before);
        Ok(new_id)
    }

    /// Turn raw picks into a closed polyline space on the active work plane.
    pub fn placement_for_space(
        &self,
        points: &[Vec3],
        rotation: f32,
    ) -> Result<Placement, crate::placement::PlacementError> {
        if points.len() < 3 {
            return Err(crate::placement::PlacementError::WrongPointCount {
                kind: "polyline",
                expected: "at least 3",
                got: points.len(),
            });
        }
        PlacementKind::Polyline.build(points, rotation, &self.active_work_plane())
    }

    pub fn create_space(
        &mut self,
        placement: Placement,
        params: ParamMap,
    ) -> Result<SpaceId, RegistryError> {
        let before = self.export_snapshot();
        let level_id = self
            .document
            .active_level_id()
            .ok_or_else(|| RegistryError::Unknown("no active level".to_string()))?;
        let anchors = placement.anchors();
        if anchors.len() < 3 {
            return Err(RegistryError::Unknown(
                "space needs at least 3 boundary points".to_string(),
            ));
        }
        let name = self.next_space_name();
        let elevation = self.work_plane(level_id).origin.y;
        let placement = placement.with_elevation(elevation);
        let params = params.resolve(&space_param_specs())?;
        let space = Space::new(name, level_id, placement, params);
        let id = space.id;
        self.document.upsert_space(space);
        self.history.record_before(before);
        Ok(id)
    }

    /// Rename a space (room tag text on plans and sheets). Undoable.
    pub fn rename_space(&mut self, id: SpaceId, name: &str) -> Result<(), RegistryError> {
        let name = name.trim();
        if name.is_empty() {
            return Err(RegistryError::Unknown(
                "space name cannot be empty".to_string(),
            ));
        }
        let mut space = self
            .document
            .get_space(id)
            .cloned()
            .ok_or_else(|| RegistryError::Unknown(id.to_string()))?;
        if space.name == name {
            return Ok(());
        }
        let before = self.export_snapshot();
        space.name = name.to_string();
        self.document.upsert_space(space);
        self.history.record_before(before);
        Ok(())
    }

    pub fn update_space(
        &mut self,
        id: SpaceId,
        params: Option<ParamMap>,
        placement: Option<Placement>,
        record: bool,
    ) -> Result<(), RegistryError> {
        let before = if record && !self.history.has_pending() {
            Some(self.export_snapshot())
        } else {
            None
        };
        let mut space = self
            .document
            .get_space(id)
            .cloned()
            .ok_or_else(|| RegistryError::Unknown(id.to_string()))?;
        if let Some(patch) = params {
            space.params = space.params.merged(&patch);
        }
        if let Some(placement) = placement {
            if placement.anchors().len() < 3 {
                return Err(RegistryError::Unknown(
                    "space needs at least 3 boundary points".to_string(),
                ));
            }
            let elevation = self.work_plane(space.level_id).origin.y;
            space.placement = placement.with_elevation(elevation);
        }
        space.params = space.params.resolve(&space_param_specs())?;
        self.document.upsert_space(space);
        if record {
            self.finish_recorded_edit(before);
        }
        Ok(())
    }

    pub fn delete_space(&mut self, id: SpaceId) -> bool {
        if self.document.get_space(id).is_none() {
            return false;
        }
        let before = self.export_snapshot();
        let removed = self.document.remove_space(id).is_some();
        if removed {
            self.history.record_before(before);
        }
        removed
    }

    pub fn translate_space(
        &mut self,
        id: SpaceId,
        delta: Vec3,
        record: bool,
    ) -> Result<(), RegistryError> {
        let space = self
            .document
            .get_space(id)
            .cloned()
            .ok_or_else(|| RegistryError::Unknown(id.to_string()))?;
        let placement = space.placement.translated(delta);
        self.update_space(id, None, Some(placement), record)
    }

    pub fn copy_space(&mut self, id: SpaceId, delta: Vec3) -> Result<SpaceId, RegistryError> {
        let before = self.export_snapshot();
        let source = self
            .document
            .get_space(id)
            .cloned()
            .ok_or_else(|| RegistryError::Unknown(id.to_string()))?;
        let name = self.next_space_name();
        let placement = source.placement.translated(delta);
        // Copied spaces are always manual, even if the source was auto-detected.
        let mut params = source.params.resolve(&space_param_specs())?;
        params = params.with("auto", ParamValue::Bool(false));
        let params = params.resolve(&space_param_specs())?;
        let space = Space::new(name, source.level_id, placement, params);
        let new_id = space.id;
        self.document.upsert_space(space);
        self.history.record_before(before);
        Ok(new_id)
    }

    /// Detect closed wall loops on the active level and refresh auto spaces.
    ///
    /// Manual (non-auto) spaces are left alone. Existing auto spaces on the
    /// active level are removed and replaced. One undo group for the whole pass.
    /// Returns how many auto spaces were created.
    pub fn detect_rooms_from_walls(&mut self) -> Result<usize, RegistryError> {
        let level_id = self
            .document
            .active_level_id()
            .ok_or_else(|| RegistryError::Unknown("no active level".to_string()))?;

        let mut segments = Vec::new();
        for id in self.document.elements_on_level(level_id) {
            let Some(element) = self.document.get_element(id) else {
                continue;
            };
            if element.component_id != "apex.wall" {
                continue;
            }
            segments.extend(wall_centerline_segments(element));
        }

        let polygons = detect_room_polygons(&segments, ENDPOINT_SNAP);

        self.begin_undo_group();

        let stale: Vec<SpaceId> = self
            .document
            .spaces()
            .filter(|space| space.level_id == level_id && space_is_auto(space))
            .map(|space| space.id)
            .collect();
        let stale_count = stale.len();
        for id in stale {
            self.document.remove_space(id);
        }

        let elevation = self.work_plane(level_id).origin.y;
        let mut created = 0usize;
        for ring in &polygons {
            let placement =
                match PlacementKind::Polyline.build(ring, 0.0, &self.work_plane(level_id)) {
                    Ok(p) => p.with_elevation(elevation),
                    Err(_) => continue,
                };
            let name = self.next_space_name();
            let params = ParamMap::new()
                .with("auto", ParamValue::Bool(true))
                .resolve(&space_param_specs())?;
            let space = Space::new(name, level_id, placement, params);
            self.document.upsert_space(space);
            created += 1;
        }

        if created > 0 || stale_count > 0 {
            self.commit_undo_group();
        } else {
            self.abort_undo_group();
        }
        Ok(created)
    }

    pub fn delete_element(&mut self, id: ElementId) -> bool {
        if self.document.get_element(id).is_none() {
            return false;
        }
        let before = self.export_snapshot();
        let (dependents, parent) = match self.document.get_element(id) {
            Some(e) => (self.solid_dependents(e), e.parent_id),
            None => (Vec::new(), None),
        };
        let removed = self
            .document
            .remove_element_detaching_children(id)
            .is_some();
        if removed {
            // Neighbours lose the join; a host loses the hole.
            self.refresh_meshes(dependents.into_iter().chain(parent));
            self.history.record_before(before);
        }
        removed
    }

    /// Attach `id` to `parent`, or detach it with `None`.
    ///
    /// Children follow the parent's level, so anything whose effective level
    /// changed is rebuilt. One undo step.
    pub fn set_element_parent(
        &mut self,
        id: ElementId,
        parent: Option<ElementId>,
    ) -> Result<Vec<ElementId>, RegistryError> {
        let before = self.export_snapshot();
        let previous_parent = self.document.get_element(id).and_then(|e| e.parent_id);
        let changed = self
            .document
            .set_parent(id, parent)
            .map_err(RegistryError::Document)?;
        for element_id in &changed {
            self.rebuild_element(*element_id)?;
        }
        // Opening host-cuts depend on parentage — rebuild both old and new hosts.
        if let Some(old) = previous_parent {
            let _ = self.rebuild_element(old);
        }
        if let Some(new_parent) = parent {
            let _ = self.rebuild_element(new_parent);
        }
        self.history.record_before(before);
        Ok(changed)
    }

    /// Direct children of `id`.
    pub fn children_of(&self, id: ElementId) -> Vec<ElementId> {
        self.document.children_of(id)
    }

    /// Every descendant of `id`, breadth first.
    pub fn descendants_of(&self, id: ElementId) -> Vec<ElementId> {
        self.document.descendants_of(id)
    }

    /// The level an element actually sits on, following parent inheritance.
    pub fn effective_level_id(&self, id: ElementId) -> Option<LevelId> {
        self.document.effective_level_id(id)
    }

    pub fn translate_elements(
        &mut self,
        ids: &[ElementId],
        delta: Vec3,
        record: bool,
    ) -> Result<(), RegistryError> {
        self.memo.enter();
        let out = self.translate_elements_unscoped(ids, delta, record);
        self.memo.leave();
        out
    }

    /// Move one or more elements by a plan-space offset.
    ///
    /// Descendants travel with their parent. A child named in `ids` alongside
    /// its ancestor is moved once, not twice, because the set is deduplicated.
    ///
    /// Joinable path peers that share endpoints (or T-junction vertices) with
    /// the movers stretch: shared verts follow, far ends stay. Miters are
    /// recomputed for the affected cluster.
    fn translate_elements_unscoped(
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
        // Expand to the full set first, so each element moves exactly once.
        let mut moving: std::collections::BTreeSet<ElementId> = std::collections::BTreeSet::new();
        for id in ids {
            if self.document.get_element(*id).is_none() {
                return Err(RegistryError::Unknown(id.to_string()));
            }
            moving.insert(*id);
            moving.extend(self.document.descendants_of(*id));
        }

        let stretch = self.plan_connected_stretch_translate(&moving, delta);
        let mut join_ids: std::collections::BTreeSet<ElementId> = moving.clone();

        self.suppress_join_stretch += 1;
        let translate_result: Result<(), RegistryError> = (|| {
            for id in &moving {
                let element = self
                    .document
                    .get_element(*id)
                    .cloned()
                    .ok_or_else(|| RegistryError::Unknown(id.to_string()))?;
                let placement = element.placement.translated(delta);
                self.update_element(*id, None, Some(placement), false)?;
            }
            for update in &stretch {
                join_ids.insert(update.id);
                self.update_element(update.id, None, Some(update.placement.clone()), false)?;
            }
            Ok(())
        })();
        self.suppress_join_stretch = self.suppress_join_stretch.saturating_sub(1);
        translate_result?;

        for id in join_ids {
            let _ = self.apply_path_joins(id, false);
        }
        if record {
            self.finish_recorded_edit(before);
        }
        Ok(())
    }

    /// Plan stretch updates for joinable peers of `moving` under a translate.
    fn plan_connected_stretch_translate(
        &self,
        moving: &std::collections::BTreeSet<ElementId>,
        delta: Vec3,
    ) -> Vec<crate::path_stretch::StretchUpdate> {
        // Group by (component_id, level) so walls don't stretch beams.
        let mut groups: BTreeMap<(String, String), Vec<ElementId>> = BTreeMap::new();
        for id in moving {
            let Some(el) = self.document.get_element(*id) else {
                continue;
            };
            if !self
                .registry
                .get(&el.component_id)
                .is_some_and(|d| d.joinable)
            {
                continue;
            }
            groups
                .entry((el.component_id.clone(), el.level_id.to_string()))
                .or_default()
                .push(*id);
        }
        let mut updates = Vec::new();
        for ((component_id, level_key), mover_ids) in groups {
            let mut movers = Vec::new();
            for id in &mover_ids {
                let Some(el) = self.document.get_element(*id) else {
                    continue;
                };
                if let Some(seg) = joinable_segment(&self.registry, el) {
                    movers.push(seg);
                }
            }
            if movers.is_empty() {
                continue;
            }
            let mut peer_pool = Vec::new();
            for other in self.document.elements() {
                if other.component_id != component_id || other.level_id.to_string() != level_key {
                    continue;
                }
                if moving.contains(&other.id) {
                    continue;
                }
                if let Some(seg) = joinable_segment(&self.registry, other) {
                    peer_pool.push(seg);
                }
            }
            updates.extend(plan_stretch_translate(&movers, &peer_pool, delta));
        }
        updates
    }

    /// Ghost mesh of **connected-stretch peers only** for a Move translate.
    ///
    /// Does not mutate the document. Movers themselves are rigid translates —
    /// the UI extracts those from the live scene buffers. Remeshing every
    /// selected wall (+ openings) on each pointer move was the Move stutter.
    pub fn preview_stretch_translate(
        &self,
        ids: &[ElementId],
        delta: Vec3,
    ) -> Result<TriangleMesh, RegistryError> {
        let mut moving: std::collections::BTreeSet<ElementId> = std::collections::BTreeSet::new();
        for id in ids {
            if self.document.get_element(*id).is_none() {
                return Err(RegistryError::Unknown(id.to_string()));
            }
            moving.insert(*id);
            moving.extend(self.document.descendants_of(*id));
        }
        let stretch = self.plan_connected_stretch_translate(&moving, delta);
        let mut mesh = TriangleMesh::empty();
        // Recipe mesh only (no host-cut / boolean) — preview must stay cheap.
        // Skip edges: ghost overlay does not draw them.
        for update in stretch {
            let Some(el) = self.document.get_element(update.id) else {
                continue;
            };
            let mut preview = el.clone();
            preview.placement = update.placement;
            if let Ok(mut part) = self.registry.build_element_mesh(
                &preview,
                self.work_plane(preview.level_id),
                self.document.references(),
            ) {
                part.edges.clear();
                mesh.append(&part);
            }
        }
        Ok(mesh)
    }

    /// Ghost mesh for dragging a path element's anchors (node / endpoint edit).
    ///
    /// Does not mutate the document. Remeshes the edited element plus any
    /// joinable peers that would stretch so joins stay attached. Recipe mesh
    /// only (no host-cut / boolean / edges) — full joins land on commit.
    ///
    /// Returns `(ghost, hide_ids)` where `hide_ids` are the source, stretch
    /// peers, and their descendants — the UI hides those live solids while the
    /// ghost is shown so the drag does not double-draw.
    pub fn preview_path_anchor_edit(
        &self,
        id: ElementId,
        new_placement: &Placement,
    ) -> Result<(TriangleMesh, Vec<ElementId>), RegistryError> {
        let source = self
            .document
            .get_element(id)
            .cloned()
            .ok_or_else(|| RegistryError::Unknown(id.to_string()))?;
        let level_id = self
            .document
            .effective_level_id(id)
            .unwrap_or(source.level_id);
        let seat = self
            .registry
            .get(&source.component_id)
            .map(|def| def.placement_options.seat_on_level)
            .unwrap_or(true);
        let placement = if seat {
            let elevation = self.work_plane(level_id).origin.y;
            new_placement.with_elevation(elevation)
        } else {
            new_placement.clone()
        };

        let mut updates = Vec::new();
        let joinable = self
            .registry
            .get(&source.component_id)
            .is_some_and(|d| d.joinable);
        if joinable {
            if let (Some(old_curve), Some(new_curve)) =
                (source.placement.curve(), placement.curve())
            {
                let peers = peers_for(&self.registry, self.document.elements(), &source);
                updates = plan_stretch_from_edit(id, old_curve, new_curve, &peers);
            }
        }
        updates.insert(
            0,
            crate::path_stretch::StretchUpdate {
                id,
                placement: placement.clone(),
            },
        );

        let mut hide: std::collections::BTreeSet<ElementId> = std::collections::BTreeSet::new();
        let mut mesh = TriangleMesh::empty();
        for update in &updates {
            hide.insert(update.id);
            hide.extend(self.document.descendants_of(update.id));
            let Some(el) = self.document.get_element(update.id) else {
                continue;
            };
            let mut preview = el.clone();
            // Seat every ghost on its own level plane so a mismatched active
            // level (or unflat stretch peer) cannot tilt the preview in 3D.
            let elev = self.work_plane(preview.level_id).origin.y;
            preview.placement = update.placement.with_elevation(elev);
            if let Ok(mut part) = self.registry.build_element_mesh(
                &preview,
                self.work_plane(preview.level_id),
                self.document.references(),
            ) {
                part.edges.clear();
                mesh.append(&part);
            }
        }
        Ok((mesh, hide.into_iter().collect()))
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
            self.sync_level_height_params(element_id)?;
            self.rebuild_element(element_id)?;
        }
        // Levels below this one also change their rise-to-next.
        let below: Vec<ElementId> = self
            .document
            .elements()
            .filter(|element| {
                self.document.effective_level_id(element.id) != Some(id)
                    && self
                        .registry
                        .get(&element.component_id)
                        .is_some_and(|def| !def.level_height_params.is_empty())
            })
            .map(|element| element.id)
            .collect();
        for element_id in below {
            self.sync_level_height_params(element_id)?;
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
        self.upsert_genus(definition).map(|_| ())
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

    /// Like [`Self::placement_from_gesture`], but uses an in-memory definition (editor preview).
    pub fn placement_from_definition(
        &self,
        definition: &ComponentDefinition,
        kind: Option<PlacementKind>,
        points: &[Vec3],
        rotation: f32,
    ) -> Result<Placement, RegistryError> {
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

    /// Preview mesh for a component definition that is not registered yet.
    pub fn preview_definition(
        &self,
        definition: &ComponentDefinition,
        kind: Option<PlacementKind>,
        points: &[Vec3],
        rotation: f32,
        raw_params: &ParamMap,
    ) -> Result<TriangleMesh, RegistryError> {
        let placement = self.placement_from_definition(definition, kind, points, rotation)?;
        let elevation = self.active_work_plane().origin.y;
        let placement = placement.with_elevation(elevation);
        if let Some(recipe) = &definition.opening {
            // Opening genera preview their assembly (frame, sashes, leaves)
            // in a 0.2 m wall along +X, not the wall void.
            definition.validate()?;
            let params = self
                .registry
                .eval_params_for_definition(definition, raw_params)?;
            let geo = self
                .registry
                .opening_geometry(recipe, &params, 0.2)
                .map_err(RegistryError::Unknown)?;
            let base = placement.anchors().first().copied().unwrap_or(Vec3::ZERO);
            let mut mesh = TriangleMesh::empty();
            crate::genus::emit_opening(&mut mesh, &geo, base, Vec3::X, Vec3::Z);
            return Ok(mesh);
        }
        self.registry.preview_definition_mesh(
            definition,
            &placement,
            raw_params,
            self.active_work_plane(),
            self.document.references(),
        )
    }

    /// Distance from `level_id` up to the next higher level, or a default rise.
    pub fn storey_rise(&self, level_id: LevelId) -> f32 {
        let Some(level) = self.document.get_level(level_id) else {
            return DEFAULT_STOREY_RISE;
        };
        let mut next = None;
        for other in self.document.levels() {
            if other.elevation > level.elevation + 1e-4 {
                match next {
                    None => next = Some(other.elevation),
                    Some(elev) if other.elevation < elev => next = Some(other.elevation),
                    _ => {}
                }
            }
        }
        next.map(|elev| elev - level.elevation)
            .unwrap_or(DEFAULT_STOREY_RISE)
    }

    fn apply_level_height_defaults(
        &self,
        component_id: &str,
        level_id: LevelId,
        params: &mut ParamMap,
        raw: &ParamMap,
    ) {
        let Some(definition) = self.registry.get(component_id) else {
            return;
        };
        if definition.level_height_params.is_empty() {
            return;
        }
        let rise = self.storey_rise(level_id) as f64;
        for param_id in &definition.level_height_params {
            // Honour an explicit authoring value; otherwise seed from storey rise.
            // Zero means "auto" (the stair/roof defaults), so it seeds too.
            if raw.get(param_id).is_none() || raw.number(param_id) == Some(0.0) {
                params.set(param_id.clone(), ParamValue::Length(rise));
            }
        }
    }

    fn sync_level_height_params(&mut self, id: ElementId) -> Result<(), RegistryError> {
        let Some(element) = self.document.get_element(id).cloned() else {
            return Ok(());
        };
        let Some(definition) = self.registry.get(&element.component_id) else {
            return Ok(());
        };
        if definition.level_height_params.is_empty() {
            return Ok(());
        }
        let level_id = self
            .document
            .effective_level_id(id)
            .unwrap_or(element.level_id);
        let rise = self.storey_rise(level_id) as f64;
        let mut params = element.params.clone();
        for param_id in &definition.level_height_params {
            params.set(param_id.clone(), ParamValue::Length(rise));
        }
        // Write through document without a nested undo step.
        let mut updated = element;
        updated.params = self
            .registry
            .persistable_params(&updated.component_id, &params)?;
        let mesh = self.build_element_mesh_with_cuts(&updated)?;
        self.document.update_element(updated, mesh);
        Ok(())
    }

    fn build_element_mesh_with_cuts(
        &self,
        element: &Element,
    ) -> Result<TriangleMesh, RegistryError> {
        solids::ELEMENT_BUILDS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        #[cfg(not(target_arch = "wasm32"))]
        let t0 = std::time::Instant::now();
        let r = self.build_element_mesh_with_cuts_inner(element);
        #[cfg(not(target_arch = "wasm32"))]
        solids::BUILD_NS.fetch_add(
            t0.elapsed().as_nanos() as usize,
            std::sync::atomic::Ordering::Relaxed,
        );
        r
    }

    fn build_element_mesh_with_cuts_inner(
        &self,
        element: &Element,
    ) -> Result<TriangleMesh, RegistryError> {
        if !self.exact_kernel_selected() {
            return self.build_element_mesh_routed(element);
        }
        let (mesh, pending) = crate::kroute::with_kernel(self.kernel.kernel.clone(), || {
            self.build_element_mesh_routed(element)
        });
        if pending.is_empty() {
            // Settled: a canonical triangle order keeps exact builds stable.
            return mesh.map(crate::kroute::canonical);
        }
        {
            let mut waiting = self.kernel.waiting.lock().unwrap();
            for key in pending {
                let ids = waiting.entry(key).or_default();
                if !ids.contains(&element.id) {
                    ids.push(element.id);
                }
            }
        }
        // Still waiting on an external kernel: the mesh path, untouched.
        mesh
    }

    /// [`Self::build_element_mesh_with_cuts`] with booleans routed through
    /// the active kernel (see `kroute`).
    fn build_element_mesh_routed(&self, element: &Element) -> Result<TriangleMesh, RegistryError> {
        if element.component_id == booleans::BOOLEAN {
            return Ok(self.boolean_mesh(element));
        }
        if self.boolean_hides(element.id) {
            // Consumed by a boolean: the boolean renders it.
            return Ok(TriangleMesh::default());
        }
        if !self.boolean_consumers(element.id).is_empty() {
            // Shown operand: a translucent ghost over the boolean result.
            let mut mesh = if element.component_id == booleans::BOOLEAN {
                self.boolean_mesh(element)
            } else {
                self.build_uncombined_mesh(element)?
            };
            tag_normals(&mut mesh, GHOST_NORMAL_TAG);
            return Ok(mesh);
        }
        let mesh = self.build_uncombined_mesh(element)?;
        if self.element_genus_build_kind(element) {
            // Genus bodies are unioned per solid in `GenusBuild::mesh`.
            return Ok(mesh);
        }
        Ok(crate::kroute::solidify(mesh))
    }

    fn element_genus_build_kind(&self, element: &Element) -> bool {
        self.registry
            .get(&element.component_id)
            .is_some_and(|d| d.genus.is_some())
    }

    /// Slab opening shown as a translucent, pickable ghost filling the
    /// hole through the host slab's thickness.
    fn area_opening_ghost(&self, element: &Element, level_id: LevelId) -> TriangleMesh {
        let Ok(mut mesh) = self.registry.build_element_mesh(
            element,
            self.work_plane(level_id),
            self.document.references(),
        ) else {
            return TriangleMesh::default();
        };
        let host_range = element
            .parent_id
            .and_then(|id| self.document.get_mesh(id))
            .and_then(|m| {
                let ys = m.positions.chunks(3).map(|p| p[1]);
                let (lo, hi) = ys.fold((f32::MAX, f32::MIN), |(lo, hi), y| (lo.min(y), hi.max(y)));
                (lo < hi).then_some((lo, hi))
            });
        if let Some((lo, hi)) = host_range {
            let own = mesh.positions.chunks(3).map(|p| p[1]);
            let (olo, ohi) = own.fold((f32::MAX, f32::MIN), |(lo, hi), y| (lo.min(y), hi.max(y)));
            let mid = (olo + ohi) * 0.5;
            let remap = |y: &mut f32| *y = if *y < mid { lo - 0.002 } else { hi + 0.002 };
            for p in mesh.positions.chunks_mut(3) {
                remap(&mut p[1]);
            }
            for p in mesh.edges.chunks_mut(3) {
                remap(&mut p[1]);
            }
        }
        tag_normals(&mut mesh, GHOST_NORMAL_TAG);
        mesh
    }

    /// An element's own geometry, ignoring booleans that consume it.
    pub(crate) fn build_uncombined_mesh(
        &self,
        element: &Element,
    ) -> Result<TriangleMesh, RegistryError> {
        let mesh = self.build_own_mesh(element)?;
        Ok(self.apply_neighbour_cuts(element, mesh))
    }

    /// An element's own geometry with host cuts, before neighbour cuts.
    fn build_own_mesh(&self, element: &Element) -> Result<TriangleMesh, RegistryError> {
        let level_id = self
            .document
            .effective_level_id(element.id)
            .unwrap_or(element.level_id);
        if let Some(build) = self.element_genus_build(element) {
            return Ok(build.mesh());
        }
        let oriented = self.oriented_hosted_opening(element);
        let element = oriented.as_ref().unwrap_or(element);
        if self.is_area_opening(element) {
            // A void: the host shows the hole; the opening itself is only a
            // translucent ghost so it can be seen and picked.
            return Ok(self.area_opening_ghost(element, level_id));
        }
        if let Some(mesh) = self.shaped_slab_mesh(element) {
            return Ok(mesh);
        }
        if let Some(mesh) = self.solid_mesh(element) {
            return Ok(mesh);
        }
        let mut mesh = self.registry.build_element_mesh(
            element,
            self.work_plane(level_id),
            self.document.references(),
        )?;
        let voids = self.host_cut_voids(element.id);
        let cuts = self.genus_host_cuts(element);
        if !voids.is_empty() || !cuts.is_empty() {
            let mut tools: Vec<TriangleMesh> = voids
                .iter()
                .map(|&(yaw, center, min, max)| rotated_box_mesh(yaw, center, min, max))
                .collect();
            tools.extend(cuts.iter().map(|c| c.mesh.clone()));
            if let Some(exact) = self.kernel_host_cuts(element.id, &mesh, &tools) {
                return Ok(exact);
            }
        }
        for (yaw, center, min, max) in voids {
            mesh = punch_rotated_box(&mesh, yaw, center, min, max);
        }
        Ok(genus_build::subtract_all(mesh, &cuts))
    }

    /// A hosted polyline opening (slab opening): a void, never a body.
    fn is_area_opening(&self, element: &Element) -> bool {
        element.parent_id.is_some()
            && self
                .registry
                .get(&element.component_id)
                .is_some_and(|d| d.host_cut.is_some() && d.placement == PlacementKind::Polyline)
    }

    /// Plan yaw of the host wall at a hosted opening's origin. Doors and
    /// windows carry no orientation of their own: it always follows the wall
    /// segment they sit in, so x, z, diagonal and polyline walls all agree.
    pub(crate) fn hosted_opening_yaw(&self, element: &Element) -> Option<f32> {
        let def = self.registry.get(&element.component_id)?;
        def.host_cut.as_ref()?;
        if def.placement != PlacementKind::Point {
            return None;
        }
        let host = self.document.get_element(element.parent_id?)?;
        let curve = host.placement.curve()?;
        let dir = crate::path_join::host_tangent_at(curve, element.placement.origin())?;
        let along = Vec3::new(dir.x, 0.0, dir.z).try_normalize()?;
        // Frame::horizontal has x = +X, y = -Z; rotated(θ).x = X cosθ - Z sinθ.
        Some((-along.z).atan2(along.x))
    }

    fn oriented_hosted_opening(&self, element: &Element) -> Option<Element> {
        let yaw = self.hosted_opening_yaw(element)?;
        let mut out = element.clone();
        if let Placement::Point { rotation, .. } = &mut out.placement {
            *rotation = yaw;
        }
        Some(out)
    }

    /// AABB voids from child openings that declare a matching host_cut.
    pub(crate) fn host_cut_voids(
        &self,
        host_id: ElementId,
    ) -> Vec<(f32, Vec3, [f32; 3], [f32; 3])> {
        let Some(host) = self.document.get_element(host_id) else {
            return Vec::new();
        };
        let Some(host_def) = self.registry.get(&host.component_id) else {
            return Vec::new();
        };
        let mut voids = Vec::new();
        for child_id in self.document.children_of(host_id) {
            let Some(child) = self.document.get_element(child_id) else {
                continue;
            };
            let Some(child_def) = self.registry.get(&child.component_id) else {
                continue;
            };
            let Some(cut) = &child_def.host_cut else {
                continue;
            };
            if self.is_genus_child(child) {
                // Exact cuts from the genus body instead.
                continue;
            }
            if !cut
                .host_categories
                .iter()
                .any(|category| category == &host_def.category)
            {
                continue;
            }
            if let Some((min, max)) = opening_void_aabb(child, child_def) {
                let yaw = self.hosted_opening_yaw(child).unwrap_or(0.0);
                voids.push((yaw, child.placement.origin(), min, max));
            }
        }
        voids
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

    /// Next free label in the axis' genus: axes running mostly along plan Z
    /// (vertical on screen) are numbered 1, 2, 3…; axes running along X are
    /// lettered A, B, C…
    fn next_grid_axis_label(&self, placement: &Placement) -> String {
        let numbered = match placement.curve() {
            Some(apex_geometry::Curve::Line { a, b }) => (b.z - a.z).abs() >= (b.x - a.x).abs(),
            _ => true,
        };
        let labels: Vec<String> = self
            .document
            .grid_axes()
            .filter_map(|axis| axis.params.text("label").map(str::to_string))
            .collect();
        if numbered {
            let max = labels
                .iter()
                .filter_map(|l| l.trim().parse::<u32>().ok())
                .max()
                .unwrap_or(0);
            (max + 1).to_string()
        } else {
            let max = labels
                .iter()
                .filter_map(|l| letter_index(l.trim()))
                .max()
                .map(|i| i + 1)
                .unwrap_or(0);
            letter_label(max)
        }
    }

    fn next_grid_axis_name(&mut self) -> String {
        self.grid_axis_counter += 1;
        format!("Grid {}", self.grid_axis_counter)
    }

    fn next_construction_line_name(&mut self) -> String {
        self.construction_line_counter += 1;
        format!("Construction line {}", self.construction_line_counter)
    }

    fn next_section_cut_name(&mut self) -> String {
        self.section_cut_counter += 1;
        format!("Section {}", self.section_cut_counter)
    }

    fn next_space_name(&mut self) -> String {
        // Continue from the highest existing "Room N" so numbers stay
        // sequential after deletes/undo instead of drifting with a raw counter.
        let highest = self
            .document
            .spaces()
            .filter_map(|s| s.name.strip_prefix("Room ")?.parse::<u32>().ok())
            .max()
            .unwrap_or(0);
        self.space_counter = highest + 1;
        format!("Room {}", self.space_counter)
    }

    // ---- Species ---------------------------------------------------

    /// Add a species (or replace one with the same id) and rebuild any
    /// instances already using it. One undo step.
    pub fn upsert_species(
        &mut self,
        species: crate::genus::Species,
    ) -> Result<Vec<ElementId>, RegistryError> {
        let before = (!self.history.has_pending()).then(|| self.export_snapshot());
        let id = species.id.clone();
        if let Some(existing) = self.registry.species(&id) {
            if existing.genus != species.genus {
                return Err(RegistryError::Unknown(format!(
                    "type '{id}' belongs to {}",
                    existing.genus
                )));
            }
        }
        self.registry.upsert_species(species)?;
        let touched = self.refresh_species_instances(&id)?;
        if let Some(before) = before {
            self.history.record_before(before);
        }
        Ok(touched)
    }

    /// Patch a type's values (and optionally rename it); every instance of
    /// the type updates. One undo step. Returns the touched element ids.
    pub fn update_species(
        &mut self,
        id: &str,
        name: Option<String>,
        patch: &ParamMap,
    ) -> Result<Vec<ElementId>, RegistryError> {
        let mut species = self
            .registry
            .species(id)
            .cloned()
            .ok_or_else(|| RegistryError::Unknown(format!("unknown species '{id}'")))?;
        species.values = species.values.merged(patch);
        if let Some(name) = name {
            species.name = name;
        }
        self.upsert_species(species)
    }

    /// Delete a species. Refused while instances use it or when it is its
    /// genus's default. One undo step.
    pub fn delete_species(&mut self, id: &str) -> Result<(), RegistryError> {
        let species = self
            .registry
            .species(id)
            .cloned()
            .ok_or_else(|| RegistryError::Unknown(format!("unknown species '{id}'")))?;
        let users = self.species_instances(id).len();
        if users > 0 {
            return Err(RegistryError::Unknown(format!(
                "species '{}' is used by {users} instance(s); swap them first",
                species.name
            )));
        }
        if self
            .registry
            .get(&species.genus)
            .and_then(|d| d.default_species.as_deref())
            == Some(id)
        {
            return Err(RegistryError::Unknown(format!(
                "species '{}' is the default of {}",
                species.name, species.genus
            )));
        }
        let before = (!self.history.has_pending()).then(|| self.export_snapshot());
        self.registry.remove_species(id);
        if let Some(before) = before {
            self.history.record_before(before);
        }
        Ok(())
    }

    /// Rebuild every element whose genus uses opening generator `id`
    /// (after a plugin registers or replaces it).
    pub fn rebuild_opening_generator_dependents(&mut self, id: &str) -> Result<(), RegistryError> {
        let ids: Vec<ElementId> = self
            .document
            .elements()
            .filter(|e| {
                self.registry
                    .get(&e.component_id)
                    .and_then(|d| d.opening.as_ref())
                    .and_then(|o| o.generator.as_deref())
                    == Some(id)
            })
            .map(|e| e.id)
            .collect();
        for eid in ids {
            self.update_element(eid, None, None, false)?;
        }
        Ok(())
    }

    /// Elements whose `type` param is `type_id`.
    pub fn species_instances(&self, type_id: &str) -> Vec<ElementId> {
        let Some(t) = self.registry.species(type_id) else {
            return Vec::new();
        };
        self.document
            .elements()
            .filter(|e| e.component_id == t.genus && e.params.text(SPECIES_PARAM) == Some(type_id))
            .map(|e| e.id)
            .collect()
    }

    fn refresh_species_instances(
        &mut self,
        type_id: &str,
    ) -> Result<Vec<ElementId>, RegistryError> {
        let ids = self.species_instances(type_id);
        for id in &ids {
            self.update_element(*id, None, None, false)?;
        }
        Ok(ids)
    }

    pub fn set_element_species(
        &mut self,
        id: ElementId,
        type_id: &str,
    ) -> Result<(), RegistryError> {
        self.memo.enter();
        let out = self.set_element_species_unscoped(id, type_id);
        self.memo.leave();
        out
    }

    /// Swap an element to another type, possibly of another genus (window
    /// → door). Placement, host and shared instance params (sill) are kept.
    /// One undo step.
    fn set_element_species_unscoped(
        &mut self,
        id: ElementId,
        type_id: &str,
    ) -> Result<(), RegistryError> {
        let species = self
            .registry
            .species(type_id)
            .cloned()
            .ok_or_else(|| RegistryError::Unknown(format!("unknown species '{type_id}'")))?;
        let element = self
            .document
            .get_element(id)
            .cloned()
            .ok_or_else(|| RegistryError::Unknown(id.to_string()))?;
        if element.component_id == species.genus {
            let patch = ParamMap::new().with(SPECIES_PARAM, ParamValue::Text(type_id.into()));
            return self.update_element(id, Some(patch), None, true);
        }
        let old_def = self.registry.require(&element.component_id)?.clone();
        let new_def = self.registry.require(&species.genus)?.clone();
        if old_def.placement != new_def.placement {
            return Err(RegistryError::Unknown(format!(
                "cannot swap {} to {}: different placement kinds",
                old_def.id, new_def.id
            )));
        }
        if let Some(parent) = element.parent_id.and_then(|p| self.document.get_element(p)) {
            let host_cat = self
                .registry
                .get(&parent.component_id)
                .map(|d| d.category.clone())
                .unwrap_or_default();
            let ok = new_def
                .host_cut
                .as_ref()
                .is_some_and(|h| h.host_categories.contains(&host_cat));
            if !ok {
                return Err(RegistryError::Unknown(format!(
                    "{} cannot be hosted by a {host_cat}",
                    new_def.id
                )));
            }
        }
        let before = (!self.history.has_pending()).then(|| self.export_snapshot());
        let mut params = ParamMap::new();
        for spec in new_def.params.iter().filter(|p| p.binding.is_instance()) {
            if spec.id == SPECIES_PARAM {
                continue;
            }
            if let Some(v) = element.params.get(&spec.id) {
                params.set(spec.id.clone(), v.clone());
            }
        }
        self.registry.apply_type_values(type_id, &mut params);
        let mut swapped = element.clone();
        swapped.component_id = new_def.id.clone();
        swapped.params = self.registry.persistable_params(&new_def.id, &params)?;
        let mesh = self.build_element_mesh_with_cuts(&swapped)?;
        self.document.update_element(swapped, mesh);
        if let Some(parent) = element.parent_id {
            self.rebuild_element(parent)?;
        }
        if let Some(before) = before {
            self.history.record_before(before);
        }
        Ok(())
    }

    /// Point a loaded element at a valid species: its own when it
    /// exists, else one matching its stored sizes (old projects), derived if
    /// needed. Type values then overwrite the stored copies.
    fn migrate_species(&mut self, element: &mut Element) {
        let component = element.component_id.clone();
        if !self.registry.is_genus(&component) {
            return;
        }
        self.registry
            .normalize_species_key(&component, &mut element.params);
        let existing = element
            .params
            .text(SPECIES_PARAM)
            .filter(|t| {
                self.registry
                    .species(t)
                    .is_some_and(|ft| ft.genus == component)
            })
            .map(str::to_string);
        let type_id = existing.or_else(|| {
            let mut raw = element.params.clone();
            raw.remove(SPECIES_PARAM);
            self.registry.resolve_instance_type(&component, None, &raw)
        });
        if let Some(type_id) = type_id {
            self.registry
                .apply_type_values(&type_id, &mut element.params);
        }
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
            .authored_components()
            .filter(|definition| !matches!(definition.source, ComponentSource::BuiltIn))
            .cloned()
            .collect();
        components.sort_by(|a, b| a.id.cmp(&b.id));

        let mut references: Vec<Reference> = self.document.references().cloned().collect();
        references.sort_by(|a, b| a.name.cmp(&b.name));

        let mut grid_axes: Vec<GridAxis> = self.document.grid_axes().cloned().collect();
        grid_axes.sort_by(|a, b| a.name.cmp(&b.name));

        let mut construction_lines: Vec<ConstructionLine> =
            self.document.construction_lines().cloned().collect();
        construction_lines.sort_by(|a, b| a.name.cmp(&b.name));

        let mut section_cuts: Vec<SectionCut> = self.document.section_cuts().cloned().collect();
        section_cuts.sort_by(|a, b| a.name.cmp(&b.name));

        let mut spaces: Vec<Space> = self.document.spaces().cloned().collect();
        spaces.sort_by(|a, b| a.name.cmp(&b.name));

        ProjectSnapshot {
            format: PROJECT_FORMAT,
            levels,
            active_level: self.document.active_level_id(),
            elements,
            references,
            grid_axes,
            construction_lines,
            section_cuts,
            spaces,
            profiles,
            components,
            counters: self.counters.clone(),
            ref_counters: self.ref_counters.clone(),
            grid_axis_counter: self.grid_axis_counter,
            construction_line_counter: self.construction_line_counter,
            section_cut_counter: self.section_cut_counter,
            space_counter: self.space_counter,
            level_counter: self.level_counter,
            views: self.views.values().cloned().collect(),
            sheets: self.sheets.values().cloned().collect(),
            view_counter: self.view_counter,
            sheet_counter: self.sheet_counter,
            view_annotations: self.view_annotations.values().cloned().collect(),
            view_annotation_counter: self.view_annotation_counter,
            species: self
                .registry
                .species_list(None)
                .into_iter()
                .cloned()
                .collect(),
        }
    }

    /// Replace this project from a snapshot. On failure, `self` is left unchanged.
    pub fn import_snapshot(&mut self, snap: ProjectSnapshot) -> Result<(), RegistryError> {
        self.history.clear();
        self.restore_snapshot(snap)
    }

    fn restore_snapshot(&mut self, snap: ProjectSnapshot) -> Result<(), RegistryError> {
        self.memo.enter();
        let out = self.restore_snapshot_unscoped(snap);
        self.memo.leave();
        out
    }

    fn restore_snapshot_unscoped(&mut self, snap: ProjectSnapshot) -> Result<(), RegistryError> {
        // Format 3 predates element parentage; `parent_id` defaults to None on
        // load, so a format 3 file imports as a flat document.
        // Format ≤4 predates construction lines / section cuts (empty via default).
        // Format ≤5 predates spaces (empty via default).
        // Format ≤6 predates saved views / sheets (empty via default + migration).
        // Format ≤7 predates view annotations (empty via default).
        // Format ≤8 predates viewport crop polygons (full-frame rect via default).
        // Format ≤9 predates species: windows/doors carry raw sizes and
        // are mapped to a matching (or derived) type below.
        let known = snap.format == PROJECT_FORMAT
            || snap.format == 1
            || snap.format == 2
            || snap.format == 3
            || snap.format == 4
            || snap.format == 5
            || snap.format == 6
            || snap.format == 7
            || snap.format == 8
            || snap.format == 9;
        if !known {
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
        next.construction_line_counter = snap.construction_line_counter;
        next.section_cut_counter = snap.section_cut_counter;
        next.space_counter = snap.space_counter;
        next.level_counter = snap.level_counter;
        next.views = snap.views.into_iter().map(|v| (v.id, v)).collect();
        let sheets: crate::sheet::SheetLibrary = snap
            .sheets
            .into_iter()
            .map(|mut s| {
                if snap.format <= 8 {
                    for vp in &mut s.viewports {
                        if vp.crop_polygon.len() < 3 {
                            vp.crop_polygon = crate::viewport_crop::default_crop_polygon_uv();
                        }
                    }
                }
                (s.id, s)
            })
            .collect();
        next.sheets = sheets;
        next.view_counter = snap.view_counter;
        next.sheet_counter = snap.sheet_counter;
        next.view_annotations = snap
            .view_annotations
            .into_iter()
            .map(|a| (a.id, a))
            .collect();
        next.view_annotation_counter = snap.view_annotation_counter;

        for profile in snap.profiles {
            next.registry.upsert_profile(profile)?;
        }
        // Genera may extend or nest each other: install in dependency order
        // by retrying until no further definition goes in.
        let mut pending = snap.components;
        while !pending.is_empty() {
            let mut failed = Vec::new();
            let mut last_err = None;
            let count = pending.len();
            for definition in pending {
                if let Err(err) = next.registry.upsert(definition.clone()) {
                    failed.push(definition);
                    last_err = Some(err);
                }
            }
            if failed.len() == count {
                return Err(last_err.expect("a failed install has an error"));
            }
            pending = failed;
        }
        for species in snap.species {
            // A species whose genus is gone (plugin not loaded) is skipped.
            let _ = next.registry.upsert_species(species);
        }
        let mut elements = snap.elements;
        for element in &mut elements {
            next.migrate_species(element);
        }

        next.document.load_contents(
            snap.levels,
            snap.active_level,
            elements,
            snap.references,
            snap.grid_axes,
            snap.construction_lines,
            snap.section_cuts,
            snap.spaces,
        );

        let ids: Vec<ElementId> = next.document.elements().map(|element| element.id).collect();
        for id in ids.iter().copied() {
            next.rebuild_element(id)?;
        }
        // Solids that read their neighbours (joins, stair wells) need the
        // whole document loaded first.
        let solids: Vec<ElementId> = next
            .document
            .elements()
            .filter(|e| e.component_id == "apex.slab" || next.joinable(e))
            .map(|e| e.id)
            .collect();
        next.refresh_meshes(solids);

        next.ensure_default_views();
        next.repair_sheet_viewport_anchors();

        *self = next;
        Ok(())
    }
}

/// On-disk / download format. Bump [`PROJECT_FORMAT`] when the shape changes.
pub const PROJECT_FORMAT: u32 = 10;

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
    #[serde(default)]
    pub construction_lines: Vec<ConstructionLine>,
    #[serde(default)]
    pub section_cuts: Vec<SectionCut>,
    #[serde(default)]
    pub spaces: Vec<Space>,
    pub profiles: Vec<ProfileType>,
    /// Files saved before descriptors existed have user components without
    /// one; they load with a placeholder purpose so old projects still open.
    #[serde(default, deserialize_with = "legacy_components")]
    pub components: Vec<ComponentDefinition>,
    #[serde(default)]
    pub counters: BTreeMap<String, u32>,
    #[serde(default)]
    pub ref_counters: BTreeMap<String, u32>,
    #[serde(default)]
    pub grid_axis_counter: u32,
    #[serde(default)]
    pub construction_line_counter: u32,
    #[serde(default)]
    pub section_cut_counter: u32,
    #[serde(default)]
    pub space_counter: u32,
    #[serde(default)]
    pub level_counter: u32,
    #[serde(default)]
    pub views: Vec<crate::view::View>,
    #[serde(default)]
    pub sheets: Vec<crate::sheet::Sheet>,
    #[serde(default)]
    pub view_counter: u32,
    #[serde(default)]
    pub sheet_counter: u32,
    #[serde(default)]
    pub view_annotations: Vec<crate::view_annotation::ViewAnnotation>,
    #[serde(default)]
    pub view_annotation_counter: u32,
    /// Species (windows, doors, …), built-in ones included so edits persist.
    #[serde(default, alias = "family_types")]
    pub species: Vec<crate::genus::Species>,
}

fn legacy_components<'de, D>(de: D) -> Result<Vec<ComponentDefinition>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let mut raw: Vec<serde_json::Value> = Deserialize::deserialize(de)?;
    for value in &mut raw {
        if let Some(map) = value.as_object_mut() {
            if !map.contains_key("descriptor") {
                let name = map
                    .get("display_name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("component")
                    .to_string();
                map.insert(
                    "descriptor".into(),
                    serde_json::json!({ "purpose": format!("{name} (saved before descriptors; edit to describe it)") }),
                );
            }
        }
    }
    raw.into_iter()
        .map(|v| serde_json::from_value(v).map_err(serde::de::Error::custom))
        .collect()
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
        assert_eq!(
            project.registry().len(),
            crate::registry::builtin_components().len()
        );
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

    /// Ghost-only Move preview must not mutate placements; commit translates once.
    #[test]
    fn move_commit_translates_once_without_preview_mutation() {
        let mut project = Project::new();
        let id = project
            .create_element("apex.column", Placement::point(Vec3::ZERO), ParamMap::new())
            .expect("create");
        project.clear_history();

        let delta = Vec3::new(2.0, 0.0, 0.0);
        // Preview is UI-only (ghost mesh); document stays at the original.
        assert!(
            project
                .document()
                .get_element(id)
                .unwrap()
                .placement
                .origin()
                .x
                .abs()
                < EPS
        );
        project
            .translate_elements(&[id], delta, true)
            .expect("commit");

        let origin = project
            .document()
            .get_element(id)
            .unwrap()
            .placement
            .origin();
        assert!(
            (origin.x - 2.0).abs() < EPS,
            "final must be original+delta (x=2), got {origin:?}"
        );
        assert!(project.can_undo(), "single move commit must be undoable");
        project.undo().expect("undo move");
        let restored = project
            .document()
            .get_element(id)
            .unwrap()
            .placement
            .origin();
        assert!(
            restored.x.abs() < EPS,
            "undo returns to origin, got {restored:?}"
        );
    }

    /// Copy must not run under an open undo group — `record_before` no-ops while
    /// pending, so the copy would not be immediately undoable.
    #[test]
    fn copy_without_open_undo_group_is_immediately_undoable() {
        let mut project = Project::new();
        let id = project
            .create_element("apex.column", Placement::point(Vec3::ZERO), ParamMap::new())
            .expect("create");
        project.clear_history();
        assert!(!project.can_undo());

        project
            .copy_elements(&[id], Vec3::new(1.0, 0.0, 0.0))
            .expect("copy");
        assert_eq!(project.document().elements().count(), 2);
        assert!(
            project.can_undo(),
            "copy must push an undo entry immediately"
        );
        project.undo().expect("undo copy");
        assert_eq!(project.document().elements().count(), 1);
    }

    #[test]
    fn abort_undo_group_allows_later_copy_to_record() {
        let mut project = Project::new();
        let id = project
            .create_element("apex.column", Placement::point(Vec3::ZERO), ParamMap::new())
            .expect("create");
        project.clear_history();
        project.begin_undo_group();
        project.abort_undo_group();
        project
            .copy_elements(&[id], Vec3::new(1.0, 0.0, 0.0))
            .expect("copy");
        assert!(project.can_undo());
        project.undo().expect("undo");
        assert_eq!(project.document().elements().count(), 1);
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
            "descriptor": {"purpose": "Test component acme.bollard."},
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
    fn preview_definition_does_not_require_registration() {
        let project = Project::new();
        let definition: ComponentDefinition = serde_json::from_str(
            r#"{
            "id": "user.preview.box",
            "descriptor": {"purpose": "Test component user.preview.box."},
            "display_name": "Preview box",
            "category": "custom",
            "source": "visual",
            "placement": "point",
            "params": [
                {"id": "width", "label": "Width", "kind": "length", "default": 0.5, "binding": "type"},
                {"id": "height", "label": "Height", "kind": "length", "default": 1.2}
            ],
            "recipe": {
                "op": "extrude",
                "profile": {
                    "shape": "rectangle",
                    "width": {"op": "param", "id": "width"},
                    "height": {"op": "param", "id": "width"}
                },
                "height": {"op": "param", "id": "height"}
            }
        }"#,
        )
        .expect("parse");
        let mesh = project
            .preview_definition(&definition, None, &[Vec3::ZERO], 0.0, &ParamMap::new())
            .expect("preview");
        let (_min, max) = mesh.aabb().unwrap();
        assert!((max[1] - 1.2).abs() < EPS);
        assert_eq!(project.registry().get("user.preview.box"), None);
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
                holes: Vec::new(),
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
    fn sheet_snapshot_round_trips_through_json() {
        use crate::sheet::{PaperOrientation, PaperSize};

        let mut project = Project::new();
        project.create_sheet_with_layout(
            "A1".into(),
            "Sheet 1".into(),
            PaperSize::A2,
            PaperOrientation::Portrait,
            None,
            None,
        );
        assert_eq!(project.sheets.len(), 1);
        let json = serde_json::to_string(&project.export_snapshot()).expect("serialize");
        let snap: ProjectSnapshot = serde_json::from_str(&json).expect("deserialize");
        let mut fresh = Project::new();
        fresh.import_snapshot(snap).expect("import");
        assert_eq!(fresh.sheets.len(), 1);
        let sheet = fresh.sheets.values().next().expect("sheet");
        assert_eq!(sheet.paper, PaperSize::A2);
        assert_eq!(sheet.orientation, PaperOrientation::Portrait);
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
    fn construction_lines_and_section_cuts_round_trip() {
        let mut project = Project::new();
        let line_id = project
            .create_construction_line(
                Placement::line(Vec3::ZERO, Vec3::new(5.0, 0.0, 0.0)),
                ParamMap::new().with("label", ParamValue::Text("CL".into())),
            )
            .expect("create line");
        let cut_id = project
            .create_section_cut(
                Placement::line(Vec3::new(0.0, 0.0, 2.0), Vec3::new(4.0, 0.0, 2.0)),
                ParamMap::new().with("label", ParamValue::Text("A".into())),
            )
            .expect("create cut");
        assert_eq!(project.document().construction_lines().count(), 1);
        assert_eq!(project.document().section_cuts().count(), 1);

        let snap = project.export_snapshot();
        assert_eq!(snap.format, PROJECT_FORMAT);
        assert_eq!(snap.construction_lines.len(), 1);
        assert_eq!(snap.section_cuts.len(), 1);

        let mut restored = Project::new();
        restored.import_snapshot(snap).expect("import");
        assert_eq!(
            restored
                .document()
                .get_construction_line(line_id)
                .unwrap()
                .params
                .text("label"),
            Some("CL")
        );
        assert_eq!(
            restored
                .document()
                .get_section_cut(cut_id)
                .unwrap()
                .params
                .text("label"),
            Some("A")
        );

        // Older formats import with empty annotation lists.
        let mut legacy = project.export_snapshot();
        legacy.format = 4;
        legacy.construction_lines.clear();
        legacy.section_cuts.clear();
        legacy.spaces.clear();
        restored.import_snapshot(legacy).expect("format 4");
        assert_eq!(restored.document().construction_lines().count(), 0);
        assert_eq!(restored.document().section_cuts().count(), 0);
        assert_eq!(restored.document().spaces().count(), 0);
    }

    #[test]
    fn joinable_walls_miter_at_corner_on_place() {
        let mut project = Project::new();
        let a = project
            .create_element(
                "apex.wall",
                Placement::line(Vec3::ZERO, Vec3::new(5.0, 0.0, 0.0)),
                ParamMap::new(),
            )
            .expect("wall a");
        let b = project
            .create_element(
                "apex.wall",
                Placement::line(Vec3::new(5.0, 0.0, 0.0), Vec3::new(5.0, 0.0, 4.0)),
                ParamMap::new(),
            )
            .expect("wall b");

        let ea = project.document().get_element(a).unwrap();
        let eb = project.document().get_element(b).unwrap();
        assert!(
            (ea.join_end - 0.1).abs() < 0.02,
            "a join_end={}",
            ea.join_end
        );
        assert!(
            (eb.join_start - 0.1).abs() < 0.02,
            "b join_start={}",
            eb.join_start
        );
        // Centerlines stay at the picked corner.
        assert!((ea.placement.curve().unwrap().end().x - 5.0).abs() < 1e-4);
        assert!((eb.placement.curve().unwrap().start().x - 5.0).abs() < 1e-4);

        // Create + join is one undo step.
        assert!(project.can_undo());
        project.undo().expect("undo b");
        assert!(project.document().get_element(b).is_none());
        let ea = project.document().get_element(a).unwrap();
        assert_eq!(ea.join_end, 0.0, "peer's join cleared with undo of b");
    }

    #[test]
    fn joinable_walls_t_junction_splits_host_and_trims_stem() {
        let mut project = Project::new();
        let host = project
            .create_element(
                "apex.wall",
                Placement::line(Vec3::ZERO, Vec3::new(10.0, 0.0, 0.0)),
                ParamMap::new(),
            )
            .expect("host");
        let stem = project
            .create_element(
                "apex.wall",
                Placement::line(Vec3::new(5.0, 0.0, 3.0), Vec3::new(5.0, 0.0, 0.0)),
                ParamMap::new(),
            )
            .expect("stem");

        let host_el = project.document().get_element(host).unwrap();
        match host_el.placement.curve().unwrap() {
            apex_geometry::Curve::Polyline { points } => {
                assert_eq!(points.len(), 3);
                assert!((points[1].x - 5.0).abs() < 0.05);
            }
            other => panic!("host should split to polyline, got {other:?}"),
        }
        let stem_el = project.document().get_element(stem).unwrap();
        assert!(
            (stem_el.join_end + 0.1).abs() < 0.03,
            "stem join_end={}",
            stem_el.join_end
        );
    }

    #[test]
    fn joinable_beams_miter_like_walls() {
        let mut project = Project::new();
        project
            .create_element(
                "apex.beam",
                Placement::line(Vec3::new(0.0, 3.0, 0.0), Vec3::new(4.0, 3.0, 0.0)),
                ParamMap::new(),
            )
            .expect("beam a");
        let b = project
            .create_element(
                "apex.beam",
                Placement::line(Vec3::new(4.0, 3.0, 0.0), Vec3::new(4.0, 3.0, 3.0)),
                ParamMap::new(),
            )
            .expect("beam b");
        let eb = project.document().get_element(b).unwrap();
        // Default beam width 0.2 → half 0.1
        assert!(
            (eb.join_start - 0.1).abs() < 0.02,
            "beam join_start={}",
            eb.join_start
        );
    }

    #[test]
    fn joinable_snap_targets_include_ends_and_mid() {
        let mut project = Project::new();
        project
            .create_element(
                "apex.wall",
                Placement::line(Vec3::ZERO, Vec3::new(4.0, 0.0, 0.0)),
                ParamMap::new(),
            )
            .expect("wall");
        let targets = project.joinable_snap_targets("apex.wall", &[]);
        assert!(
            targets.len() >= 3,
            "expected end+end+mid, got {}",
            targets.len()
        );
        assert!(targets
            .iter()
            .any(|t| t.kind == crate::PathSnapKind::End && t.point[0].abs() < 1e-4));
        assert!(targets
            .iter()
            .any(|t| t.kind == crate::PathSnapKind::Mid && (t.point[0] - 2.0).abs() < 1e-4));
    }

    #[test]
    fn translate_joinable_wall_stretches_connected_peer() {
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
                Placement::line(Vec3::new(5.0, 0.0, 0.0), Vec3::new(5.0, 0.0, 4.0)),
                ParamMap::new(),
            )
            .expect("b");

        project
            .translate_elements(&[a], Vec3::new(0.0, 0.0, 2.0), true)
            .expect("translate a");

        let ea = project.document().get_element(a).unwrap();
        let eb = project.document().get_element(b).unwrap();
        // A fully translated.
        assert!((ea.placement.curve().unwrap().start().z - 2.0).abs() < 1e-3);
        assert!((ea.placement.curve().unwrap().end().z - 2.0).abs() < 1e-3);
        // B shared corner follows; far end stays.
        assert!((eb.placement.curve().unwrap().start().z - 2.0).abs() < 1e-3);
        assert!((eb.placement.curve().unwrap().end().z - 4.0).abs() < 1e-3);
    }

    #[test]
    fn preview_path_anchor_edit_ghosts_source_and_peers() {
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
                Placement::line(Vec3::new(5.0, 0.0, 0.0), Vec3::new(5.0, 0.0, 4.0)),
                ParamMap::new(),
            )
            .expect("b");
        let (mesh, hide) = project
            .preview_path_anchor_edit(a, &Placement::line(Vec3::ZERO, Vec3::new(6.0, 0.0, 1.0)))
            .expect("preview");
        assert!(!mesh.is_empty(), "source + peer must remesh for ghost");
        assert!(mesh.edges.is_empty(), "ghost skips edge polylines");
        assert!(hide.contains(&a), "hide edited wall");
        assert!(hide.contains(&b), "hide stretched peer");
        // Document untouched — peer still at original placement.
        let eb = project.document().get_element(b).unwrap();
        assert!((eb.placement.curve().unwrap().start().x - 5.0).abs() < 1e-3);
    }

    #[test]
    fn preview_stretch_translate_remeshes_peers_only() {
        let mut project = Project::new();
        let a = project
            .create_element(
                "apex.wall",
                Placement::line(Vec3::ZERO, Vec3::new(5.0, 0.0, 0.0)),
                ParamMap::new(),
            )
            .expect("a");
        let _b = project
            .create_element(
                "apex.wall",
                Placement::line(Vec3::new(5.0, 0.0, 0.0), Vec3::new(5.0, 0.0, 4.0)),
                ParamMap::new(),
            )
            .expect("b");
        // Isolated wall: no stretch peers → empty ghost (UI translates scene mesh).
        let alone = project
            .create_element(
                "apex.wall",
                Placement::line(Vec3::new(20.0, 0.0, 0.0), Vec3::new(24.0, 0.0, 0.0)),
                ParamMap::new(),
            )
            .expect("alone");
        let empty = project
            .preview_stretch_translate(&[alone], Vec3::new(1.0, 0.0, 0.0))
            .expect("alone preview");
        assert!(empty.is_empty(), "no peers → no remesh");

        let stretched = project
            .preview_stretch_translate(&[a], Vec3::new(0.0, 0.0, 1.0))
            .expect("stretch preview");
        assert!(
            !stretched.is_empty(),
            "connected peer must remesh for ghost"
        );
        assert!(stretched.edges.is_empty(), "ghost skips edge polylines");
    }

    /// House-like 6-wall cluster: time peer-only preview vs legacy remesh-all.
    #[test]
    fn preview_stretch_translate_perf_house_cluster() {
        let mut project = Project::new();
        let walls = [
            (Vec3::ZERO, Vec3::new(10.0, 0.0, 0.0)),
            (Vec3::new(10.0, 0.0, 0.0), Vec3::new(10.0, 0.0, 8.0)),
            (Vec3::new(10.0, 0.0, 8.0), Vec3::new(0.0, 0.0, 8.0)),
            (Vec3::ZERO, Vec3::new(0.0, 0.0, 8.0)),
            (Vec3::new(5.0, 0.0, 0.0), Vec3::new(5.0, 0.0, 8.0)),
            (Vec3::new(5.0, 0.0, 4.0), Vec3::new(10.0, 0.0, 4.0)),
        ];
        let mut ids = Vec::new();
        for (a, b) in walls {
            ids.push(
                project
                    .create_element("apex.wall", Placement::line(a, b), ParamMap::new())
                    .expect("wall"),
            );
        }
        let mover = ids[4];
        let _ = project
            .preview_stretch_translate(&[mover], Vec3::new(0.3, 0.0, 0.0))
            .expect("warm");

        let n = 40usize;
        let t0 = std::time::Instant::now();
        let mut peer_tris = 0usize;
        for i in 0..n {
            let mesh = project
                .preview_stretch_translate(&[mover], Vec3::new(0.01 * i as f32, 0.0, 0.0))
                .expect("preview");
            peer_tris = mesh.triangle_count();
        }
        let peer_ms = t0.elapsed().as_secs_f64() * 1000.0 / n as f64;

        // Legacy cost: remesh mover + stretch peers each frame (no scene cache).
        let t1 = std::time::Instant::now();
        let mut legacy_tris = 0usize;
        for i in 0..n {
            let delta = Vec3::new(0.01 * i as f32, 0.0, 0.0);
            let mut moving = std::collections::BTreeSet::new();
            moving.insert(mover);
            let stretch = project.plan_connected_stretch_translate(&moving, delta);
            let mut mesh = TriangleMesh::empty();
            let el = project.document().get_element(mover).unwrap();
            let placement = el.placement.translated(delta);
            if let Ok(part) = project.registry.build_mesh(
                &el.component_id,
                &placement,
                &el.params,
                project.work_plane(el.level_id),
                project.document().references(),
            ) {
                mesh.append(&part);
            }
            for update in stretch {
                let el = project.document().get_element(update.id).unwrap();
                if let Ok(part) = project.registry.build_mesh(
                    &el.component_id,
                    &update.placement,
                    &el.params,
                    project.work_plane(el.level_id),
                    project.document().references(),
                ) {
                    mesh.append(&part);
                }
            }
            legacy_tris = mesh.triangle_count();
        }
        let legacy_ms = t1.elapsed().as_secs_f64() * 1000.0 / n as f64;
        eprintln!(
            "preview_stretch house: peer_only={peer_ms:.3}ms ({peer_tris} tris) legacy_remesh={legacy_ms:.3}ms ({legacy_tris} tris)"
        );
        // Peer-only remeshes fewer solids; allow noise on debug timings.
        assert!(peer_tris < legacy_tris);
        assert!(peer_ms < legacy_ms * 2.0 + 1.0);
    }

    #[test]
    fn anchor_drag_on_joinable_stretches_peer() {
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
                Placement::line(Vec3::new(5.0, 0.0, 0.0), Vec3::new(5.0, 0.0, 4.0)),
                ParamMap::new(),
            )
            .expect("b");

        project
            .update_element(
                a,
                None,
                Some(Placement::line(Vec3::ZERO, Vec3::new(6.0, 0.0, 1.0))),
                true,
            )
            .expect("edit a end");

        let eb = project.document().get_element(b).unwrap();
        assert!((eb.placement.curve().unwrap().start().x - 6.0).abs() < 1e-3);
        assert!((eb.placement.curve().unwrap().start().z - 1.0).abs() < 1e-3);
        assert!((eb.placement.curve().unwrap().end().z - 4.0).abs() < 1e-3);
    }

    #[test]
    fn detect_rooms_from_walls_creates_auto_space_and_undoes() {
        let mut project = Project::new();
        let corners = [
            Vec3::ZERO,
            Vec3::new(4.0, 0.0, 0.0),
            Vec3::new(4.0, 0.0, 3.0),
            Vec3::new(0.0, 0.0, 3.0),
        ];
        for i in 0..4 {
            project
                .create_element(
                    "apex.wall",
                    Placement::line(corners[i], corners[(i + 1) % 4]),
                    ParamMap::new(),
                )
                .expect("wall");
        }

        // Manual space must survive detect.
        let manual = project
            .placement_for_space(
                &[
                    Vec3::new(10.0, 0.0, 10.0),
                    Vec3::new(12.0, 0.0, 10.0),
                    Vec3::new(12.0, 0.0, 12.0),
                ],
                0.0,
            )
            .expect("manual placement");
        let manual_id = project
            .create_space(
                manual,
                ParamMap::new().with("label", ParamValue::Text("Manual".into())),
            )
            .expect("manual space");

        let created = project.detect_rooms_from_walls().expect("detect");
        assert_eq!(created, 1);
        assert_eq!(project.document().spaces().count(), 2);
        let autos: Vec<_> = project
            .document()
            .spaces()
            .filter(|s| space_is_auto(s))
            .collect();
        assert_eq!(autos.len(), 1);
        assert!(!space_is_auto(
            project.document().get_space(manual_id).unwrap()
        ));

        // Idempotent: re-detect still one auto, one manual.
        let created_again = project.detect_rooms_from_walls().expect("re-detect");
        assert_eq!(created_again, 1);
        assert_eq!(project.document().spaces().count(), 2);

        project.undo().expect("undo detect");
        // One undo reverts the last detect pass (still one auto from first detect + manual).
        assert_eq!(project.document().spaces().count(), 2);
        project.undo().expect("undo first detect");
        assert_eq!(project.document().spaces().count(), 1);
        assert!(project.document().get_space(manual_id).is_some());
    }

    #[test]
    fn format_six_import_gets_default_views() {
        let project = Project::new();
        let mut snap = project.export_snapshot();
        snap.format = 6;
        snap.views.clear();
        snap.view_counter = 0;
        let mut fresh = Project::new();
        fresh.import_snapshot(snap).expect("import");
        assert!(fresh.views().count() >= 2);
    }

    #[test]
    fn spaces_round_trip_and_legacy_empty() {
        let mut project = Project::new();
        let points = [
            Vec3::ZERO,
            Vec3::new(4.0, 0.0, 0.0),
            Vec3::new(4.0, 0.0, 3.0),
            Vec3::new(0.0, 0.0, 3.0),
        ];
        let placement = project
            .placement_for_space(&points, 0.0)
            .expect("placement");
        let id = project
            .create_space(
                placement,
                ParamMap::new().with("label", ParamValue::Text("Kitchen".into())),
            )
            .expect("create space");
        assert_eq!(project.document().spaces().count(), 1);

        let snap = project.export_snapshot();
        assert_eq!(snap.format, PROJECT_FORMAT);
        assert_eq!(snap.spaces.len(), 1);

        let mut restored = Project::new();
        restored.import_snapshot(snap).expect("import");
        assert_eq!(
            restored
                .document()
                .get_space(id)
                .unwrap()
                .params
                .text("label"),
            Some("Kitchen")
        );

        let mut legacy = project.export_snapshot();
        legacy.format = 5;
        legacy.spaces.clear();
        restored.import_snapshot(legacy).expect("format 5");
        assert_eq!(restored.document().spaces().count(), 0);
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

    // --- parentage ---------------------------------------------------------

    fn place_wall(project: &mut Project, a: Vec3, b: Vec3) -> ElementId {
        project
            .create_element("apex.wall", Placement::line(a, b), ParamMap::new())
            .expect("place wall")
    }

    fn origin_y(project: &Project, id: ElementId) -> f32 {
        project
            .document()
            .get_element(id)
            .expect("element")
            .placement
            .origin()
            .y
    }

    #[test]
    fn a_child_is_built_on_its_parents_work_plane() {
        // The mesh must come out at the parent's elevation, not the child's own
        // level: build_element_mesh gets the work plane, so a wrong level here
        // silently seats the child at the wrong height.
        let mut project = Project::new();
        let level0 = project.document().active_level_id().expect("level 0");
        let (level1, _) = project.document_mut().add_level("Level 1", 3.0);

        project.set_active_level(level1).expect("activate");
        let parent = place_wall(&mut project, Vec3::ZERO, Vec3::new(4.0, 0.0, 0.0));

        project.set_active_level(level0).expect("activate");
        let child = project
            .create_element(
                "apex.column",
                Placement::point(Vec3::new(1.0, 0.0, 0.0)),
                ParamMap::new(),
            )
            .expect("place child");
        project
            .set_element_parent(child, Some(parent))
            .expect("re-parent");

        let (min, max) = project
            .document()
            .get_mesh(child)
            .expect("child mesh")
            .aabb()
            .expect("aabb");
        assert!(
            (min[1] - 3.0).abs() < EPS,
            "child base sat at {} instead of the parent's 3.0",
            min[1]
        );
        assert!((max[1] - 6.0).abs() < EPS, "child top was {}", max[1]);
    }

    #[test]
    fn a_child_takes_its_parents_level() {
        let mut project = Project::new();
        let level0 = project.document().active_level_id().expect("level 0");
        let (level1, _) = project.document_mut().add_level("Level 1", 3.0);

        // Parent sits on level 1.
        project.set_active_level(level1).expect("activate");
        let parent = place_wall(&mut project, Vec3::ZERO, Vec3::new(4.0, 0.0, 0.0));

        // Child is placed on level 0, so the two start out on different levels.
        project.set_active_level(level0).expect("activate");
        let child = project
            .create_element(
                "apex.column",
                Placement::point(Vec3::new(1.0, 0.0, 0.0)),
                ParamMap::new(),
            )
            .expect("place child");

        assert_eq!(project.effective_level_id(parent), Some(level1));
        assert_eq!(
            project.effective_level_id(child),
            Some(level0),
            "precondition: child starts on its own level"
        );

        project
            .set_element_parent(child, Some(parent))
            .expect("re-parent");

        assert_eq!(
            project.effective_level_id(child),
            Some(level1),
            "child must read the parent's level"
        );
    }

    #[test]
    fn moving_a_level_carries_children_with_it() {
        let mut project = Project::new();
        let level1 = project.document().active_level_id().unwrap();
        let parent = place_wall(&mut project, Vec3::ZERO, Vec3::new(4.0, 0.0, 0.0));
        let child = project
            .create_element(
                "apex.column",
                Placement::point(Vec3::new(1.0, 0.0, 0.0)),
                ParamMap::new(),
            )
            .expect("place child");
        project
            .set_element_parent(child, Some(parent))
            .expect("re-parent");

        project.set_level_elevation(level1, 5.0).expect("raise");

        assert!(
            (origin_y(&project, parent) - 5.0).abs() < EPS,
            "parent rose"
        );
        assert!(
            (origin_y(&project, child) - 5.0).abs() < EPS,
            "child inherited the level, was {}",
            origin_y(&project, child)
        );
    }

    #[test]
    fn translating_a_parent_carries_its_children() {
        let mut project = Project::new();
        let parent = place_wall(&mut project, Vec3::ZERO, Vec3::new(4.0, 0.0, 0.0));
        let child = project
            .create_element(
                "apex.column",
                Placement::point(Vec3::new(1.0, 0.0, 0.0)),
                ParamMap::new(),
            )
            .expect("place child");
        project
            .set_element_parent(child, Some(parent))
            .expect("re-parent");

        let delta = Vec3::new(0.0, 0.0, 2.0);
        project
            .translate_elements(&[parent], delta, true)
            .expect("translate parent");

        let parent_pos = project
            .document()
            .get_element(parent)
            .unwrap()
            .placement
            .origin();
        let child_pos = project
            .document()
            .get_element(child)
            .unwrap()
            .placement
            .origin();
        assert!((parent_pos.z - 2.0).abs() < EPS, "parent moved");
        assert!(
            (child_pos.z - parent_pos.z).abs() < EPS,
            "child followed the parent"
        );
    }

    #[test]
    fn a_child_named_alongside_its_parent_moves_only_once() {
        let mut project = Project::new();
        let parent = place_wall(&mut project, Vec3::ZERO, Vec3::new(4.0, 0.0, 0.0));
        let child = project
            .create_element(
                "apex.column",
                Placement::point(Vec3::new(1.0, 0.0, 0.0)),
                ParamMap::new(),
            )
            .expect("place child");
        project
            .set_element_parent(child, Some(parent))
            .expect("re-parent");

        // Both selected: the child must not be translated twice.
        project
            .translate_elements(&[parent, child], Vec3::new(0.0, 0.0, 3.0), true)
            .expect("translate both");

        let child_pos = project
            .document()
            .get_element(child)
            .unwrap()
            .placement
            .origin();
        assert!(
            (child_pos.z - 3.0).abs() < EPS,
            "child moved twice to {}",
            child_pos.z
        );
    }

    #[test]
    fn descendants_of_follows_the_whole_chain() {
        let mut project = Project::new();
        let root = place_wall(&mut project, Vec3::ZERO, Vec3::new(4.0, 0.0, 0.0));
        let middle = project
            .create_element(
                "apex.column",
                Placement::point(Vec3::new(1.0, 0.0, 0.0)),
                ParamMap::new(),
            )
            .expect("middle");
        let leaf = project
            .create_element(
                "apex.column",
                Placement::point(Vec3::new(2.0, 0.0, 0.0)),
                ParamMap::new(),
            )
            .expect("leaf");

        project
            .set_element_parent(middle, Some(root))
            .expect("middle under root");
        project
            .set_element_parent(leaf, Some(middle))
            .expect("leaf under middle");

        assert_eq!(project.children_of(root), vec![middle]);
        assert_eq!(project.children_of(middle), vec![leaf]);
        let all = project.descendants_of(root);
        assert_eq!(all.len(), 2);
        assert!(all.contains(&middle) && all.contains(&leaf));
        assert_eq!(
            project.effective_level_id(leaf),
            project.effective_level_id(root),
            "level inherits down the whole chain"
        );
    }

    #[test]
    fn an_element_cannot_become_its_own_ancestor() {
        let mut project = Project::new();
        let parent = place_wall(&mut project, Vec3::ZERO, Vec3::new(4.0, 0.0, 0.0));
        let child = project
            .create_element(
                "apex.column",
                Placement::point(Vec3::new(1.0, 0.0, 0.0)),
                ParamMap::new(),
            )
            .expect("child");
        project
            .set_element_parent(child, Some(parent))
            .expect("re-parent");

        assert!(
            project.set_element_parent(parent, Some(child)).is_err(),
            "a cycle must be refused"
        );
        assert!(
            project.set_element_parent(parent, Some(parent)).is_err(),
            "self-parenting must be refused"
        );
    }

    #[test]
    fn deleting_a_parent_detaches_its_children() {
        let mut project = Project::new();
        let parent = place_wall(&mut project, Vec3::ZERO, Vec3::new(4.0, 0.0, 0.0));
        let child = project
            .create_element(
                "apex.column",
                Placement::point(Vec3::new(1.0, 0.0, 0.0)),
                ParamMap::new(),
            )
            .expect("child");
        project
            .set_element_parent(child, Some(parent))
            .expect("re-parent");

        assert!(project.delete_element(parent));
        assert!(
            project.document().get_element(child).is_some(),
            "the child must survive its parent"
        );
        assert_eq!(
            project.document().get_element(child).unwrap().parent_id,
            None,
            "and must be a root again"
        );
    }

    #[test]
    fn re_parenting_survives_a_snapshot_round_trip() {
        let mut project = Project::new();
        let parent = place_wall(&mut project, Vec3::ZERO, Vec3::new(4.0, 0.0, 0.0));
        let child = project
            .create_element(
                "apex.column",
                Placement::point(Vec3::new(1.0, 0.0, 0.0)),
                ParamMap::new(),
            )
            .expect("child");
        project
            .set_element_parent(child, Some(parent))
            .expect("re-parent");

        let snapshot = project.export_snapshot();
        let mut restored = Project::new();
        restored.import_snapshot(snapshot).expect("restore");

        assert_eq!(
            restored.document().get_element(child).unwrap().parent_id,
            Some(parent),
            "parent link must survive the file format"
        );
    }

    #[test]
    fn a_format_three_snapshot_still_imports() {
        let project = Project::new();
        let mut snapshot = project.export_snapshot();
        snapshot.format = 3;
        let mut restored = Project::new();
        restored
            .import_snapshot(snapshot)
            .expect("a pre-parentage file must load");
    }

    #[test]
    fn re_parenting_is_a_single_undo_step() {
        let mut project = Project::new();
        let parent = place_wall(&mut project, Vec3::ZERO, Vec3::new(4.0, 0.0, 0.0));
        let child = project
            .create_element(
                "apex.column",
                Placement::point(Vec3::new(1.0, 0.0, 0.0)),
                ParamMap::new(),
            )
            .expect("child");
        assert_eq!(
            project.document().get_element(child).unwrap().parent_id,
            None
        );

        project
            .set_element_parent(child, Some(parent))
            .expect("re-parent");
        assert_eq!(
            project.document().get_element(child).unwrap().parent_id,
            Some(parent)
        );

        project.undo().expect("undo");
        assert_eq!(
            project.document().get_element(child).unwrap().parent_id,
            None,
            "one undo must detach again"
        );
    }
}

#[cfg(test)]
mod plugin_first_tests {
    use super::*;
    use crate::param::ParamValue;
    use glam::Vec3;

    #[test]
    fn free_elevation_paths_keep_picked_heights() {
        let mut project = Project::new();
        let id = project
            .create_element(
                "apex.duct",
                Placement::line(Vec3::new(0.0, 1.5, 0.0), Vec3::new(3.0, 1.5, 0.0)),
                ParamMap::new(),
            )
            .expect("duct");
        let element = project.document().get_element(id).unwrap();
        let anchors = element.placement.anchors();
        assert!((anchors[0].y - 1.5).abs() < 1e-4);
        assert!((anchors[1].y - 1.5).abs() < 1e-4);
    }

    /// Every built-in type's parts are closed solids without seam edges
    /// (edges only on outlines and at sharp corners).
    #[test]
    fn opening_frames_are_one_seamless_solid() {
        let project = Project::new();
        let reg = project.registry();
        for t in reg.species_list(None) {
            let def = reg.get(&t.genus).unwrap();
            let recipe = def.opening.as_ref().unwrap();
            let mut params = t.values.clone();
            reg.apply_type_values(&t.id, &mut params);
            let params = reg.eval_params(&t.genus, &params).unwrap();
            let geo = reg.opening_geometry(recipe, &params, 0.3).unwrap();
            for part in &geo.parts {
                let one = crate::genus::OpeningGeometry {
                    parts: vec![part.clone()],
                    lines: vec![],
                };
                let mut mesh = TriangleMesh::empty();
                crate::genus::emit_opening(&mut mesh, &one, Vec3::ZERO, Vec3::X, Vec3::Z);
                assert!(
                    apex_geometry::is_watertight(&mesh),
                    "{} part watertight",
                    t.id
                );
            }
        }
    }

    #[test]
    fn door_frame_does_not_double_wall_face_jamb_edges() {
        // Frame outer caps used to sit on the host wall faces at the same
        // place as the wall's opening creases → thick black stripe on the wall.
        let mut project = Project::new();
        let wall = project
            .create_element(
                "apex.wall",
                Placement::line(Vec3::ZERO, Vec3::new(6.0, 0.0, 0.0)),
                ParamMap::new(),
            )
            .expect("wall");
        let _door = project
            .create_element_with_parent(
                "apex.door",
                Placement::point(Vec3::new(3.0, 0.0, 0.0)),
                ParamMap::new(),
                Some(wall),
            )
            .expect("door");
        let wall_mesh = project.document().get_mesh(wall).expect("wall mesh");
        let half = wall_mesh
            .positions
            .chunks(3)
            .map(|p| p[2])
            .fold(f32::MIN, f32::max);
        let buffers = project.document().build_scene_buffers();
        let edges = project.hide_buried_edges(&buffers.edge_positions);
        // Jamb x of a 0.9 m door centred at 3.0.
        let jambs = [2.55_f32, 3.45_f32];
        for &jx in &jambs {
            let mut n = 0;
            for seg in edges.chunks(6) {
                let (a, b) = ([seg[0], seg[1], seg[2]], [seg[3], seg[4], seg[5]]);
                let on_front = (a[2] - half).abs() < 0.02 && (b[2] - half).abs() < 0.02;
                let vertical = (a[0] - b[0]).abs() < 0.02 && (a[2] - b[2]).abs() < 0.02;
                let at_jamb = (a[0] - jx).abs() < 0.01 && (b[0] - jx).abs() < 0.01;
                let tall = (a[1] - b[1]).abs() > 1.5;
                if on_front && vertical && at_jamb && tall {
                    n += 1;
                }
            }
            assert_eq!(
                n, 1,
                "jamb x={jx}: expected one wall-face crease, got {n} (doubled = black stripe)"
            );
        }
    }

    #[test]
    fn hosted_window_and_door_frames_have_no_member_seams() {
        for component in ["apex.window", "apex.door"] {
            let mut project = Project::new();
            let wall = project
                .create_element(
                    "apex.wall",
                    Placement::line(Vec3::ZERO, Vec3::new(6.0, 0.0, 0.0)),
                    ParamMap::new(),
                )
                .expect("wall");
            let opening = project
                .create_element_with_parent(
                    component,
                    Placement::point(Vec3::new(3.0, 0.0, 0.0)),
                    ParamMap::new().with("width", ParamValue::Length(1.0)),
                    Some(wall),
                )
                .expect("opening");
            let mesh = project.document().get_mesh(opening).expect("mesh");
            // Frame perimeter caps omitted (host wall draws those creases).
            // Window: 52; door U-frame + leaf + swing arc: 42.
            let expected = if component == "apex.window" { 52 } else { 42 };
            assert_eq!(mesh.edges.len() / 6, expected, "{component}");
            // Deterministic.
            let again = project
                .build_uncombined_mesh(project.document().get_element(opening).unwrap())
                .unwrap();
            assert_eq!(again.positions, mesh.positions);
        }
    }

    fn wall_with(project: &mut Project, component: &str, type_id: &str) -> (ElementId, ElementId) {
        let wall = project
            .create_element(
                "apex.wall",
                Placement::line(Vec3::ZERO, Vec3::new(8.0, 0.0, 0.0)),
                ParamMap::new(),
            )
            .expect("wall");
        let opening = project
            .create_element_with_parent(
                component,
                Placement::point(Vec3::new(3.0, 0.0, 0.0)),
                ParamMap::new()
                    .with(SPECIES_PARAM, ParamValue::Text(type_id.into()))
                    .with("sill", ParamValue::Length(0.7)),
                Some(wall),
            )
            .expect("opening");
        (wall, opening)
    }

    fn mesh_x_extent(project: &Project, id: ElementId) -> f32 {
        let m = project.document().get_mesh(id).unwrap();
        let xs = m.positions.chunks(3).map(|p| p[0]);
        let (lo, hi) = xs.fold((f32::MAX, f32::MIN), |(a, b), x| (a.min(x), b.max(x)));
        hi - lo
    }

    #[test]
    fn editing_a_species_updates_every_instance_in_one_undo_step() {
        let mut project = Project::new();
        let t = "apex.window.double-1500x1400";
        let (wall, a) = wall_with(&mut project, "apex.window", t);
        let b = project
            .create_element_with_parent(
                "apex.window",
                Placement::point(Vec3::new(6.0, 0.0, 0.0)),
                ParamMap::new().with(SPECIES_PARAM, ParamValue::Text(t.into())),
                Some(wall),
            )
            .unwrap();
        assert!((mesh_x_extent(&project, a) - 1.5).abs() < 1e-3);
        let touched = project
            .update_species(
                t,
                None,
                &ParamMap::new().with("width", ParamValue::Length(1.8)),
            )
            .unwrap();
        assert_eq!(touched.len(), 2);
        for id in [a, b] {
            assert!((mesh_x_extent(&project, id) - 1.8).abs() < 1e-3);
            let el = project.document().get_element(id).unwrap();
            assert_eq!(el.params.text(SPECIES_PARAM), Some(t));
        }
        // Instance param survives.
        let el = project.document().get_element(a).unwrap();
        assert!(
            matches!(el.params.get("sill"), Some(ParamValue::Length(v)) if (*v - 0.7).abs() < 1e-9)
        );
        assert!(project.undo().unwrap());
        assert!((mesh_x_extent(&project, a) - 1.5).abs() < 1e-3);
        assert!((mesh_x_extent(&project, b) - 1.5).abs() < 1e-3);
        let width = project
            .registry()
            .species(t)
            .unwrap()
            .values
            .get("width")
            .cloned();
        assert!(matches!(width, Some(ParamValue::Length(v)) if (v - 1.5).abs() < 1e-9));
    }

    #[test]
    fn swapping_type_or_genus_keeps_host_and_position_and_undoes() {
        let mut project = Project::new();
        let (wall, w) = wall_with(&mut project, "apex.window", "apex.window.single-1200x1400");
        let before = project.document().get_element(w).unwrap().placement.clone();
        project
            .set_element_species(w, "apex.window.double-1500x1400")
            .unwrap();
        assert!((mesh_x_extent(&project, w) - 1.5).abs() < 1e-3);
        project
            .set_element_species(w, "apex.door.double-1400x2100")
            .unwrap();
        let el = project.document().get_element(w).unwrap().clone();
        assert_eq!(el.component_id, "apex.door");
        assert_eq!(el.parent_id, Some(wall));
        assert_eq!(el.placement, before);
        assert_eq!(
            el.params.text(SPECIES_PARAM),
            Some("apex.door.double-1400x2100")
        );
        assert!((mesh_x_extent(&project, w) - 1.4).abs() < 1e-3);
        // Not hostable on a wall-less genus / bad type.
        assert!(project.set_element_species(w, "nope").is_err());
        assert!(project.undo().unwrap());
        let el = project.document().get_element(w).unwrap();
        assert_eq!(el.component_id, "apex.window");
        assert_eq!(
            el.params.text(SPECIES_PARAM),
            Some("apex.window.double-1500x1400")
        );
        assert!(project.undo().unwrap());
        assert!((mesh_x_extent(&project, w) - 1.2).abs() < 1e-3);
    }

    #[test]
    fn species_commands_and_query_round_trip() {
        let mut project = Project::new();
        let (_, w) = wall_with(&mut project, "apex.window", "apex.window.single-1200x1400");
        let out = project
            .execute_json(r#"{"op":"create_species","genus":"apex.window","name":"Triple 2100","params":{"width":2.1,"columns":3}}"#)
            .unwrap();
        let tid = out["species"].as_str().unwrap().to_string();
        assert_eq!(tid, "user.apex.window.triple-2100");
        project
            .execute_json(&format!(
                r#"{{"op":"set_element_species","id":"{w}","type":"{tid}"}}"#
            ))
            .unwrap();
        assert!((mesh_x_extent(&project, w) - 2.1).abs() < 1e-3);
        let list = project
            .query_json(r#"{"op":"list_genus_species","genus":"apex.window"}"#)
            .unwrap();
        let row = list
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["id"] == tid.as_str())
            .unwrap();
        assert_eq!(row["instances"], 1);
        // Saved with the project and restored.
        let snap = project.export_snapshot();
        let json = serde_json::to_string(&snap).unwrap();
        let mut fresh = Project::new();
        fresh
            .import_snapshot(serde_json::from_str(&json).unwrap())
            .unwrap();
        assert!(fresh.registry().species(&tid).is_some());
        assert!((mesh_x_extent(&fresh, w) - 2.1).abs() < 1e-3);
    }

    #[test]
    fn format_9_projects_without_species_load_and_get_one() {
        let mut project = Project::new();
        let (_, w) = wall_with(&mut project, "apex.window", "apex.window.single-1200x1400");
        let mut snap = serde_json::to_value(project.export_snapshot()).unwrap();
        snap["format"] = serde_json::json!(9);
        snap.as_object_mut().unwrap().remove("species");
        // Strip type info from elements, keep a custom width.
        let text = serde_json::to_string(&snap)
            .unwrap()
            .replace("\"apex.window.single-1200x1400\"", "null");
        let mut old: serde_json::Value = serde_json::from_str(&text).unwrap();
        for el in old["elements"].as_array_mut().unwrap() {
            if let Some(p) = el["params"].as_object_mut() {
                p.remove("species");
            }
        }
        let mut fresh = Project::new();
        fresh
            .import_snapshot(serde_json::from_value(old).unwrap())
            .unwrap();
        let el = fresh.document().get_element(w).unwrap();
        let t = el
            .params
            .text(SPECIES_PARAM)
            .expect("migrated type")
            .to_string();
        assert_eq!(fresh.registry().species(&t).unwrap().genus, "apex.window");
        assert!((mesh_x_extent(&fresh, w) - 1.2).abs() < 1e-3);
    }

    #[test]
    fn pr114_family_type_keys_still_load_and_old_ops_still_work() {
        let mut project = Project::new();
        let (_, w) = wall_with(&mut project, "apex.window", "apex.window.single-1200x1400");
        project
            .execute_json(r#"{"op":"create_family_type","family":"apex.window","name":"Wide","params":{"width":2.4}}"#)
            .unwrap();
        project
            .execute_json(&format!(
                r#"{{"op":"set_element_type","id":"{w}","type":"user.apex.window.wide"}}"#
            ))
            .unwrap();
        // Rewrite the save the way PR #114 wrote it: family_types / family / type.
        let mut snap = serde_json::to_value(project.export_snapshot()).unwrap();
        let obj = snap.as_object_mut().unwrap();
        let mut species = obj.remove("species").unwrap();
        for t in species.as_array_mut().unwrap() {
            let t = t.as_object_mut().unwrap();
            let g = t.remove("genus").unwrap();
            t.insert("family".into(), g);
        }
        obj.insert("family_types".into(), species);
        for el in obj["elements"].as_array_mut().unwrap() {
            if let Some(p) = el["params"].as_object_mut() {
                if let Some(v) = p.remove("species") {
                    p.insert("type".into(), v);
                }
            }
        }
        let mut fresh = Project::new();
        fresh
            .import_snapshot(serde_json::from_value(snap).unwrap())
            .unwrap();
        let el = fresh.document().get_element(w).unwrap();
        assert_eq!(el.params.text(SPECIES_PARAM), Some("user.apex.window.wide"));
        assert!(el.params.get("type").is_none());
        assert!((mesh_x_extent(&fresh, w) - 2.4).abs() < 1e-3);
        let rows = fresh
            .query_json(r#"{"op":"list_family_types","family":"apex.window"}"#)
            .unwrap();
        assert!(rows
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["id"] == "user.apex.window.wide"));
    }

    #[test]
    fn delete_species_refuses_used_and_default_and_undoes() {
        let mut project = Project::new();
        let (_, w) = wall_with(&mut project, "apex.window", "apex.window.single-1200x1400");
        project
            .execute_json(r#"{"op":"create_species","genus":"apex.window","name":"Spare"}"#)
            .unwrap();
        assert!(project
            .delete_species("apex.window.single-1200x1400")
            .is_err());
        project
            .execute_json(&format!(
                r#"{{"op":"set_element_species","id":"{w}","species":"user.apex.window.spare"}}"#
            ))
            .unwrap();
        assert!(project.delete_species("user.apex.window.spare").is_err());
        project
            .set_element_species(w, "apex.window.double-1500x1400")
            .unwrap();
        project
            .execute_json(r#"{"op":"delete_species","id":"user.apex.window.spare"}"#)
            .unwrap();
        assert!(project
            .registry()
            .species("user.apex.window.spare")
            .is_none());
        assert!(project.undo().unwrap());
        assert!(project
            .registry()
            .species("user.apex.window.spare")
            .is_some());
    }

    struct SlabDoor;
    impl crate::genus::OpeningGenerator for SlabDoor {
        fn generate(
            &self,
            params: &ParamMap,
            _wall_depth: f64,
        ) -> Result<crate::genus::OpeningGeometry, String> {
            let w = params.number("width").unwrap_or(1.0);
            let h = params.number("height").unwrap_or(2.0);
            Ok(crate::genus::OpeningGeometry {
                parts: vec![crate::genus::OpeningPart {
                    loops: vec![vec![
                        [-w / 2.0, 0.0],
                        [w / 2.0, 0.0],
                        [w / 2.0, h],
                        [-w / 2.0, h],
                    ]],
                    origin: [0.0, 0.0],
                    angle: 0.0,
                    frame: false,
                    d0: -0.02,
                    d1: 0.02,
                    glass: false,
                }],
                lines: vec![],
            })
        }
    }

    #[test]
    fn user_opening_genus_with_plugin_generator_gets_a_type_and_builds() {
        let mut project = Project::new();
        // Missing descriptor is rejected.
        assert!(project
            .registry_mut()
            .register_opening_generator(
                "test.slab",
                crate::Descriptor::default(),
                Box::new(SlabDoor)
            )
            .is_err());
        project
            .registry_mut()
            .register_opening_generator(
                "test.slab",
                crate::Descriptor::new("A flat slab door leaf."),
                Box::new(SlabDoor),
            )
            .unwrap();
        let mut def = project.registry().get("apex.door").unwrap().clone();
        def.id = "user.slab_door".into();
        def.default_species = None;
        def.opening.as_mut().unwrap().generator = Some("test.slab".into());
        project.register_component(def).unwrap();
        assert!(project.registry().is_genus("user.slab_door"));
        let wall = project
            .create_element(
                "apex.wall",
                Placement::line(Vec3::ZERO, Vec3::new(6.0, 0.0, 0.0)),
                ParamMap::new(),
            )
            .unwrap();
        let door = project
            .create_element_with_parent(
                "user.slab_door",
                Placement::point(Vec3::new(3.0, 0.0, 0.0)),
                ParamMap::new(),
                Some(wall),
            )
            .unwrap();
        assert!((mesh_x_extent(&project, door) - 0.9).abs() < 1e-3);
        // Swap between the user genus and the built-in door.
        project
            .set_element_species(door, "apex.door.double-1400x2100")
            .unwrap();
        assert_eq!(
            project.document().get_element(door).unwrap().component_id,
            "apex.door"
        );
    }

    #[test]
    fn hosted_openings_align_with_the_wall_axis() {
        let s = std::f32::consts::FRAC_1_SQRT_2 * 6.0;
        let cases: Vec<(Placement, Vec3, Vec3)> = vec![
            (
                Placement::line(Vec3::ZERO, Vec3::new(6.0, 0.0, 0.0)),
                Vec3::new(3.0, 0.0, 0.0),
                Vec3::X,
            ),
            (
                Placement::line(Vec3::ZERO, Vec3::new(0.0, 0.0, 6.0)),
                Vec3::new(0.0, 0.0, 3.0),
                Vec3::Z,
            ),
            (
                Placement::line(Vec3::new(6.0, 0.0, 0.0), Vec3::ZERO),
                Vec3::new(3.0, 0.0, 0.0),
                -Vec3::X,
            ),
            (
                Placement::line(Vec3::ZERO, Vec3::new(s, 0.0, s)),
                Vec3::new(s / 2.0, 0.0, s / 2.0),
                Vec3::new(1.0, 0.0, 1.0).normalize(),
            ),
            (
                Placement::Curve {
                    curve: apex_geometry::Curve::Polyline {
                        points: vec![
                            Vec3::ZERO,
                            Vec3::new(6.0, 0.0, 0.0),
                            Vec3::new(6.0, 0.0, 6.0),
                        ],
                    },
                },
                Vec3::new(6.0, 0.0, 3.0),
                Vec3::Z,
            ),
        ];
        for component in ["apex.door", "apex.window"] {
            for (wall_placement, at, along) in &cases {
                let mut project = Project::new();
                let wall = project
                    .create_element("apex.wall", wall_placement.clone(), ParamMap::new())
                    .expect("wall");
                let opening = project
                    .create_element_with_parent(
                        component,
                        Placement::point(*at),
                        ParamMap::new().with("width", ParamValue::Length(1.0)),
                        Some(wall),
                    )
                    .expect("opening");
                let across = Vec3::new(-along.z, 0.0, along.x);
                let mesh = project.document().get_mesh(opening).expect("opening mesh");
                // A door's open leaf is rotated about its hinge out of the
                // wall; the frame (everything within the wall depth) must
                // still align with the wall axis.
                let in_wall: Vec<Vec3> = mesh
                    .positions
                    .chunks(3)
                    .map(|p| Vec3::new(p[0], p[1], p[2]))
                    .filter(|p| (*p - *at).dot(across).abs() <= 0.11)
                    .collect();
                if component == "apex.door" {
                    let reach = mesh
                        .positions
                        .chunks(3)
                        .map(|p| (Vec3::new(p[0], p[1], p[2]) - *at).dot(across))
                        .fold(f32::MIN, f32::max);
                    assert!(reach > 0.75, "door leaf open across the wall: {reach}");
                    // Leaf hinged at the -along jamb.
                    let leaf_along: Vec<f32> = mesh
                        .positions
                        .chunks(3)
                        .map(|p| Vec3::new(p[0], p[1], p[2]) - *at)
                        .filter(|d| d.dot(across) > 0.2)
                        .map(|d| d.dot(*along))
                        .collect();
                    assert!(leaf_along.iter().all(|a| *a < -0.3), "{leaf_along:?}");
                }
                let span = |dir: Vec3| {
                    let (mut lo, mut hi) = (f32::MAX, f32::MIN);
                    for p in &in_wall {
                        let d = (*p - *at).dot(dir);
                        lo = lo.min(d);
                        hi = hi.max(d);
                    }
                    hi - lo
                };
                assert!(
                    (span(*along) - 1.0).abs() < 1e-3,
                    "{component} leaf along {along:?} spans {}",
                    span(*along)
                );
                // Frame fills the wall depth, centred on the wall axis.
                let (mut lo, mut hi) = (f32::MAX, f32::MIN);
                for p in &in_wall {
                    let d = (*p - *at).dot(across);
                    lo = lo.min(d);
                    hi = hi.max(d);
                }
                assert!(
                    (lo + hi).abs() < 1e-3,
                    "{component} not centred: {lo}..{hi}"
                );
                assert!(
                    span(across) < 0.4 && span(across) < span(*along) * 0.5,
                    "{component} leaf across {along:?} spans {}",
                    span(across)
                );
                // The wall is open on the axis at the opening centre and
                // just inside both jambs, and closed just beyond them.
                let wall_mesh = project.document().get_mesh(wall).expect("wall mesh");
                let y = if component == "apex.door" { 1.0 } else { 1.5 };
                let solid_at = |p: Vec3| {
                    wall_mesh.indices.chunks(3).any(|tri| {
                        let v = |i: u32| {
                            let q = &wall_mesh.positions[i as usize * 3..i as usize * 3 + 3];
                            Vec3::new(q[0], q[1], q[2])
                        };
                        // Vertical faces parallel to the wall containing p in projection.
                        let (a, b, c) = (v(tri[0]), v(tri[1]), v(tri[2]));
                        let n = (b - a).cross(c - a);
                        if n.length() < 1e-9 || n.normalize().dot(across).abs() < 0.99 {
                            return false;
                        }
                        let to2 = |w: Vec3| ((w - *at).dot(*along), w.y);
                        let (p0, p1, p2, q) = (to2(a), to2(b), to2(c), to2(p));
                        let sign = |a: (f32, f32), b: (f32, f32), c: (f32, f32)| {
                            (a.0 - c.0) * (b.1 - c.1) - (b.0 - c.0) * (a.1 - c.1)
                        };
                        let (d1, d2, d3) = (sign(q, p0, p1), sign(q, p1, p2), sign(q, p2, p0));
                        let neg = d1 < 0.0 || d2 < 0.0 || d3 < 0.0;
                        let pos = d1 > 0.0 || d2 > 0.0 || d3 > 0.0;
                        !(neg && pos)
                    })
                };
                for k in [0.0, 0.4, -0.4] {
                    let p = *at + *along * k + Vec3::Y * y;
                    assert!(
                        !solid_at(p),
                        "{component} on {along:?}: wall not open at {k}"
                    );
                }
                for k in [0.7, -0.7] {
                    let p = *at + *along * k + Vec3::Y * y;
                    assert!(
                        solid_at(p),
                        "{component} on {along:?}: wall open beyond jamb at {k}"
                    );
                }
            }
        }
    }

    #[test]
    fn door_on_wall_punches_a_host_void() {
        let mut project = Project::new();
        let wall = project
            .create_element(
                "apex.wall",
                Placement::line(Vec3::ZERO, Vec3::new(5.0, 0.0, 0.0)),
                ParamMap::new(),
            )
            .expect("wall");
        let before = project
            .document()
            .get_mesh(wall)
            .map(|m| m.triangle_count())
            .unwrap_or(0);
        let _door = project
            .create_element_with_parent(
                "apex.door",
                Placement::point(Vec3::new(2.5, 0.0, 0.0)),
                ParamMap::new()
                    .with("width", ParamValue::Length(1.0))
                    .with("height", ParamValue::Length(2.0)),
                Some(wall),
            )
            .expect("door");
        let wall_el = project.document().get_element(wall).unwrap().clone();
        let cuts = project.genus_host_cuts(&wall_el);
        assert_eq!(cuts.len(), 1, "the door genus cuts its host once");
        assert!(
            project.host_cut_voids(wall).is_empty(),
            "no AABB void for genus children"
        );
        let mesh = project.document().get_mesh(wall).expect("wall mesh");
        let (min, max) = cuts[0].mesh.aabb().expect("cut box");
        let inside = mesh.indices.chunks(3).any(|tri| {
            let c = tri.iter().fold([0.0f32; 3], |acc, &i| {
                let p = &mesh.positions[i as usize * 3..i as usize * 3 + 3];
                [
                    acc[0] + p[0] / 3.0,
                    acc[1] + p[1] / 3.0,
                    acc[2] + p[2] / 3.0,
                ]
            });
            (0..3).all(|k| c[k] > min[k] + 1e-4 && c[k] < max[k] - 1e-4)
        });
        assert!(
            !inside && mesh.triangle_count() >= before,
            "wall keeps its surround but nothing inside the opening void ({min:?}..{max:?})"
        );
        assert_eq!(
            project.document().get_element(_door).unwrap().parent_id,
            Some(wall)
        );
    }

    #[test]
    fn storey_rise_seeds_wall_height_when_unspecified() {
        let mut project = Project::new();
        let ground = project.document().active_level_id().unwrap();
        project.add_level("Level 1", 3.5);
        let wall = project
            .create_element(
                "apex.wall",
                Placement::line(Vec3::ZERO, Vec3::new(2.0, 0.0, 0.0)),
                ParamMap::new(),
            )
            .expect("wall");
        let height = project
            .document()
            .get_element(wall)
            .unwrap()
            .params
            .number("height");
        assert_eq!(height, Some(3.5));
        assert!((project.storey_rise(ground) - 3.5).abs() < 1e-4);
    }

    #[test]
    fn pitched_roof_and_stair_reach_the_next_level() {
        let mut project = Project::new();
        project.add_level("Level 1", 3.2);
        let line = Placement::line(Vec3::ZERO, Vec3::new(4.0, 0.0, 0.0));
        let roof = project
            .create_element("apex.roof.pitched", line.clone(), ParamMap::new())
            .expect("roof");
        let stair = project
            .create_element("apex.stair", line, ParamMap::new())
            .expect("stair");
        let param = |id, key| {
            project
                .document()
                .get_element(id)
                .unwrap()
                .params
                .number(key)
        };
        assert_eq!(param(roof, "base_offset"), Some(3.2_f32 as f64));
        assert_eq!(param(stair, "height"), Some(3.2_f32 as f64));
        // Roof eaves sit at the next level; stair top lands on it.
        let y_range = |id| {
            let ys: Vec<f32> = project
                .document()
                .get_mesh(id)
                .expect("mesh")
                .positions
                .chunks(3)
                .map(|p| p[1])
                .collect();
            (
                ys.iter().cloned().fold(f32::MAX, f32::min),
                ys.iter().cloned().fold(f32::MIN, f32::max),
            )
        };
        let (roof_min, _) = y_range(roof);
        assert!(roof_min > 3.0, "roof min y {roof_min}");
        let (_, stair_max) = y_range(stair);
        assert!((stair_max - 3.2).abs() < 1e-3, "stair top {stair_max}");
    }

    #[test]
    fn stair_cuts_the_slab_on_its_top_level() {
        let mut project = Project::new();
        let upper = project.add_level("Level 1", 3.0);
        project.set_active_level(upper).unwrap();
        let slab_pts = [
            Vec3::new(-5.0, 0.0, -5.0),
            Vec3::new(5.0, 0.0, -5.0),
            Vec3::new(5.0, 0.0, 5.0),
            Vec3::new(-5.0, 0.0, 5.0),
        ];
        let placement = project
            .placement_from_points("apex.slab", &slab_pts, 0.0)
            .unwrap();
        let slab = project
            .create_element("apex.slab", placement, ParamMap::new())
            .unwrap();
        let ground = project
            .document()
            .levels()
            .find(|l| l.id != upper)
            .unwrap()
            .id;
        project.set_active_level(ground).unwrap();
        let stair = project
            .create_element(
                "apex.stair",
                Placement::line(Vec3::ZERO, Vec3::new(4.0, 0.0, 0.0)),
                ParamMap::new(),
            )
            .unwrap();
        // The well is a live boolean, not a child element.
        assert!(project.document().children_of(slab).is_empty());
        let slab_mesh = project.document().get_mesh(slab).unwrap();
        assert!(apex_geometry::is_watertight(slab_mesh), "slab stays closed");
        let covers = |mesh: &TriangleMesh, x: f32, z: f32| {
            mesh.indices.chunks(3).any(|t| {
                let p: Vec<[f32; 3]> = t
                    .iter()
                    .map(|&i| {
                        let i = i as usize * 3;
                        [
                            mesh.positions[i],
                            mesh.positions[i + 1],
                            mesh.positions[i + 2],
                        ]
                    })
                    .collect();
                let up = (p[1][0] - p[0][0]) * (p[2][2] - p[0][2])
                    - (p[1][2] - p[0][2]) * (p[2][0] - p[0][0]);
                if up.abs() < 1e-9 {
                    return false;
                }
                let s = |a: [f32; 3], b: [f32; 3]| {
                    (b[0] - a[0]) * (z - a[2]) - (b[2] - a[2]) * (x - a[0])
                };
                let (d0, d1, d2) = (s(p[0], p[1]), s(p[1], p[2]), s(p[2], p[0]));
                (d0 >= 0.0 && d1 >= 0.0 && d2 >= 0.0) || (d0 <= 0.0 && d1 <= 0.0 && d2 <= 0.0)
            })
        };
        assert!(!covers(slab_mesh, 2.0, 0.0), "hole over the stair");
        assert!(covers(slab_mesh, -3.0, 0.0), "slab elsewhere");
        // Moving the stair moves the hole.
        project
            .update_element(
                stair,
                None,
                Some(Placement::line(
                    Vec3::new(0.0, 0.0, 3.0),
                    Vec3::new(4.0, 0.0, 3.0),
                )),
                true,
            )
            .unwrap();
        let slab_mesh = project.document().get_mesh(slab).unwrap();
        assert!(covers(slab_mesh, 2.0, 0.0), "old hole closed");
        assert!(!covers(slab_mesh, 2.0, 3.0), "new hole");
        // A slab drawn after the stair is cut too.
        project.set_active_level(upper).unwrap();
        let placement = project
            .placement_from_points("apex.slab", &slab_pts, 0.0)
            .unwrap();
        let late = project
            .create_element("apex.slab", placement, ParamMap::new())
            .unwrap();
        assert!(!covers(
            project.document().get_mesh(late).unwrap(),
            2.0,
            3.0
        ));
        // Undo: late slab, active level, stair move.
        for _ in 0..3 {
            project.undo().unwrap();
        }
        let slab_mesh = project.document().get_mesh(slab).unwrap();
        assert!(!covers(slab_mesh, 2.0, 0.0), "undo restores the hole");
        // Undo removes the stair; the slab closes.
        project.undo().unwrap();
        assert!(project.document().get_element(stair).is_none());
        assert!(covers(project.document().get_mesh(slab).unwrap(), 2.0, 0.0));
    }
}

/// `A`→0 … `Z`→25, `AA`→26 … ; `None` for anything that is not all letters.
fn letter_index(label: &str) -> Option<u32> {
    if label.is_empty() || !label.chars().all(|c| c.is_ascii_alphabetic()) {
        return None;
    }
    let mut n: u32 = 0;
    for c in label.chars() {
        n = n
            .checked_mul(26)?
            .checked_add(c.to_ascii_uppercase() as u32 - 'A' as u32 + 1)?;
    }
    Some(n - 1)
}

fn letter_label(index: u32) -> String {
    let mut n = index + 1;
    let mut out = Vec::new();
    while n > 0 {
        let r = (n - 1) % 26;
        out.push((b'A' + r as u8) as char);
        n = (n - 1) / 26;
    }
    out.iter().rev().collect()
}

#[cfg(test)]
mod grid_label_tests {
    use super::{letter_index, letter_label};

    #[test]
    fn letter_labels_round_trip() {
        assert_eq!(letter_label(0), "A");
        assert_eq!(letter_label(25), "Z");
        assert_eq!(letter_label(26), "AA");
        for i in 0..100 {
            assert_eq!(letter_index(&letter_label(i)), Some(i));
        }
        assert_eq!(letter_index("1"), None);
    }
}

/// Normal length tagging translucent ghosts (shown boolean operands, slab
/// openings): drawn see-through in the glass pass, but pickable.
pub const GHOST_NORMAL_TAG: f32 = 3.0;

fn tag_normals(mesh: &mut TriangleMesh, tag: f32) {
    for n in mesh.normals.chunks_mut(3) {
        let v = Vec3::new(n[0], n[1], n[2]).normalize_or_zero() * tag;
        n.copy_from_slice(&v.to_array());
    }
}
