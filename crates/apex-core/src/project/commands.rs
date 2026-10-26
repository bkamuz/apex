//! Headless, serializable command and query layer over [`Project`].
//!
//! This is the one API that agents (the MCP server), scripts and tests drive.
//! Every [`Command`] is applied as exactly one undo step; a [`Command::Batch`]
//! is one step for the whole list and is rolled back if any sub-command fails.
//! [`Query`] never mutates. Both are plain JSON (`{"op": "...", ...}`) and are
//! described for agents by [`api_catalog`].

use std::str::FromStr;

use apex_geometry::{is_closed, is_watertight, mesh_volume};
use glam::Vec3;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::{Project, SlabShape};
use crate::descriptor::{params_json_schema, Descriptor, PublishedDescriptor};
use crate::element::ElementId;
use crate::grid_axis::{grid_axis_param_specs, GridAxisId};
use crate::level::LevelId;
use crate::param::ParamMap;
use crate::placement::PlacementKind;
use crate::reference::{RefId, ReferenceKind};
use crate::sheet::SheetId;
use crate::space::{space_param_specs, SpaceId};
use crate::view::ViewId;
use crate::view_annotation::{AnnotationAnchor, ViewAnnotationId, ViewAnnotationKind};

/// Error from a command or query. Always a readable sentence.
#[derive(Debug, Clone, PartialEq)]
pub struct CommandError(pub String);

impl std::fmt::Display for CommandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for CommandError {}

type CmdResult = Result<Value, CommandError>;

fn e<E: std::fmt::Display>(err: E) -> CommandError {
    CommandError(err.to_string())
}

fn msg(text: impl Into<String>) -> CommandError {
    CommandError(text.into())
}

fn parse_id<T: FromStr>(what: &str, raw: &str) -> Result<T, CommandError>
where
    T::Err: std::fmt::Display,
{
    T::from_str(raw.trim()).map_err(|err| msg(format!("bad {what} id '{raw}': {err}")))
}

fn pts(points: &[[f32; 3]]) -> Vec<Vec3> {
    points.iter().copied().map(Vec3::from_array).collect()
}

fn ids_json(ids: &[ElementId]) -> Value {
    Value::Array(ids.iter().map(|i| json!(i.to_string())).collect())
}

/// A mutation. Wire form: `{"op": "create_element", ...}`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum Command {
    CreateElement {
        component: String,
        points: Vec<[f32; 3]>,
        #[serde(default)]
        rotation: f32,
        #[serde(default)]
        params: ParamMap,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        placement_kind: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        parent: Option<String>,
        /// Level (id or name) to place on; defaults to the active level.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        level: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
    },
    UpdateElement {
        id: String,
        #[serde(default)]
        params: ParamMap,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        points: Option<Vec<[f32; 3]>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        placement_kind: Option<String>,
    },
    DeleteElement {
        id: String,
    },
    SetParent {
        id: String,
        parent: Option<String>,
    },
    MoveElements {
        ids: Vec<String>,
        delta: [f32; 3],
    },
    CopyElements {
        ids: Vec<String>,
        delta: [f32; 3],
    },
    Boolean {
        a: String,
        b: String,
        #[serde(default = "default_boolean_op")]
        operation: String,
    },
    SetSlabShape {
        id: String,
        shape: SlabShape,
    },
    JoinPaths {
        id: String,
    },
    CreateLevel {
        name: String,
        elevation: f32,
    },
    SetActiveLevel {
        id: String,
    },
    SetLevelElevation {
        id: String,
        elevation: f32,
    },
    CreateGridAxis {
        points: Vec<[f32; 3]>,
        #[serde(default)]
        params: ParamMap,
    },
    DeleteGridAxis {
        id: String,
    },
    CreateReference {
        kind: String,
        points: Vec<[f32; 3]>,
        #[serde(default)]
        rotation: f32,
    },
    DeleteReference {
        id: String,
    },
    CreateSpace {
        points: Vec<[f32; 3]>,
        #[serde(default)]
        params: ParamMap,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
    },
    UpdateSpace {
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        params: Option<ParamMap>,
    },
    DeleteSpace {
        id: String,
    },
    DetectRooms,
    CreatePlanView {
        level: String,
    },
    #[serde(rename = "create_3d_view")]
    Create3dView,
    RenameView {
        id: String,
        name: String,
    },
    DeleteView {
        id: String,
    },
    CreateViewAnnotation {
        view: String,
        annotation: ViewAnnotationKind,
    },
    DeleteViewAnnotation {
        id: String,
    },
    CreateSheet {
        number: String,
        name: String,
    },
    DeleteSheet {
        id: String,
    },
    PlaceViewOnSheet {
        sheet: String,
        view: String,
        #[serde(default = "default_center_x")]
        center_x_mm: f32,
        #[serde(default = "default_center_y")]
        center_y_mm: f32,
    },
    Undo,
    Redo,
    Batch {
        /// Raw command objects. A string `"$N.field"` anywhere in a step is
        /// replaced by `field` of step N's result (e.g. `"$0.id"`).
        commands: Vec<Value>,
    },
}

fn default_boolean_op() -> String {
    "subtract".into()
}
fn default_center_x() -> f32 {
    210.0
}
fn default_center_y() -> f32 {
    148.5
}

/// A read. Wire form: `{"op": "list_elements", ...}`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum Query {
    Summary,
    ListLevels,
    ListElements {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        level: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        component: Option<String>,
    },
    GetElement {
        id: String,
    },
    ElementGeometry {
        id: String,
    },
    Validate,
    ListComponents,
    ListGridAxes,
    ListSpaces,
    ListViews,
    ListSheets,
    ExportView {
        id: String,
        format: String,
    },
    ExportSheet {
        id: String,
        format: String,
    },
    ExportProject,
}

impl Command {
    /// Wire name. Exhaustive, so a new variant must be named here; the
    /// catalog test then fails until it is also described.
    pub fn op(&self) -> &'static str {
        match self {
            Self::CreateElement { .. } => "create_element",
            Self::UpdateElement { .. } => "update_element",
            Self::DeleteElement { .. } => "delete_element",
            Self::SetParent { .. } => "set_parent",
            Self::MoveElements { .. } => "move_elements",
            Self::CopyElements { .. } => "copy_elements",
            Self::Boolean { .. } => "boolean",
            Self::SetSlabShape { .. } => "set_slab_shape",
            Self::JoinPaths { .. } => "join_paths",
            Self::CreateLevel { .. } => "create_level",
            Self::SetActiveLevel { .. } => "set_active_level",
            Self::SetLevelElevation { .. } => "set_level_elevation",
            Self::CreateGridAxis { .. } => "create_grid_axis",
            Self::DeleteGridAxis { .. } => "delete_grid_axis",
            Self::CreateReference { .. } => "create_reference",
            Self::DeleteReference { .. } => "delete_reference",
            Self::CreateSpace { .. } => "create_space",
            Self::UpdateSpace { .. } => "update_space",
            Self::DeleteSpace { .. } => "delete_space",
            Self::DetectRooms => "detect_rooms",
            Self::CreatePlanView { .. } => "create_plan_view",
            Self::Create3dView => "create_3d_view",
            Self::RenameView { .. } => "rename_view",
            Self::DeleteView { .. } => "delete_view",
            Self::CreateViewAnnotation { .. } => "create_view_annotation",
            Self::DeleteViewAnnotation { .. } => "delete_view_annotation",
            Self::CreateSheet { .. } => "create_sheet",
            Self::DeleteSheet { .. } => "delete_sheet",
            Self::PlaceViewOnSheet { .. } => "place_view_on_sheet",
            Self::Undo => "undo",
            Self::Redo => "redo",
            Self::Batch { .. } => "batch",
        }
    }
}

impl Query {
    pub fn op(&self) -> &'static str {
        match self {
            Self::Summary => "summary",
            Self::ListLevels => "list_levels",
            Self::ListElements { .. } => "list_elements",
            Self::GetElement { .. } => "get_element",
            Self::ElementGeometry { .. } => "element_geometry",
            Self::Validate => "validate",
            Self::ListComponents => "list_components",
            Self::ListGridAxes => "list_grid_axes",
            Self::ListSpaces => "list_spaces",
            Self::ListViews => "list_views",
            Self::ListSheets => "list_sheets",
            Self::ExportView { .. } => "export_view",
            Self::ExportSheet { .. } => "export_sheet",
            Self::ExportProject => "export_project",
        }
    }
}

impl Project {
    /// Apply a command as one undo step. On failure the project is left
    /// exactly as it was and nothing is recorded.
    pub fn execute(&mut self, command: Command) -> CmdResult {
        match command {
            Command::Undo => return Ok(json!({ "undone": self.undo().map_err(e)? })),
            Command::Redo => return Ok(json!({ "redone": self.redo().map_err(e)? })),
            _ => {}
        }
        let before = self.export_snapshot();
        let nested = self.history.has_pending();
        if !nested {
            self.history.begin_transaction(before.clone());
        }
        match self.apply(command) {
            Ok(value) => {
                if !nested {
                    self.history.commit_transaction();
                }
                Ok(value)
            }
            Err(err) => {
                if !nested {
                    self.history.abort_transaction();
                }
                let _ = self.restore_snapshot(before);
                Err(err)
            }
        }
    }

    /// Parse and execute a JSON command.
    pub fn execute_json(&mut self, text: &str) -> CmdResult {
        let command: Command =
            serde_json::from_str(text).map_err(|err| msg(format!("invalid command: {err}")))?;
        self.execute(command)
    }

    /// Parse and run a JSON query.
    pub fn query_json(&self, text: &str) -> CmdResult {
        let query: Query =
            serde_json::from_str(text).map_err(|err| msg(format!("invalid query: {err}")))?;
        self.query(&query)
    }

    fn resolve_level(&self, raw: &str) -> Result<LevelId, CommandError> {
        if let Ok(id) = LevelId::from_str(raw.trim()) {
            if self.document().get_level(id).is_some() {
                return Ok(id);
            }
        }
        self.document()
            .levels()
            .find(|l| l.name == raw)
            .map(|l| l.id)
            .ok_or_else(|| {
                msg(format!(
                    "unknown level '{raw}' (pass a level id or exact name)"
                ))
            })
    }

    fn resolve_element(&self, raw: &str) -> Result<ElementId, CommandError> {
        let id: ElementId = parse_id("element", raw)?;
        if self.document().get_element(id).is_none() {
            return Err(msg(format!("no element with id '{raw}'")));
        }
        Ok(id)
    }

    fn rename_element(&mut self, id: ElementId, name: &str) -> Result<(), CommandError> {
        let mut el = self
            .document
            .get_element(id)
            .cloned()
            .ok_or_else(|| msg("element vanished"))?;
        let mesh = self.document.get_mesh(id).cloned().unwrap_or_default();
        el.name = name.to_string();
        self.document.update_element(el, mesh);
        Ok(())
    }

    /// Refuse param ids the element type does not declare, so a typo is an
    /// error instead of a silent no-op.
    fn check_params(&self, component: &str, params: &ParamMap) -> Result<(), CommandError> {
        let Some(def) = self.registry().get(component) else {
            return Err(msg(format!(
                "unknown element type '{component}' (see list_components)"
            )));
        };
        // A profile-driven type (walls) also takes the profile's instance
        // params (e.g. wall `height`); its type params are fixed per profile.
        let profile = def.profile_param_id().and_then(|pid| {
            let chosen = params.text(pid).map(str::to_string).or_else(|| {
                def.resolve_params(&ParamMap::new())
                    .ok()?
                    .text(pid)
                    .map(str::to_string)
            })?;
            self.registry().profile(&chosen).cloned()
        });
        for (key, _) in params.iter() {
            if def
                .params
                .iter()
                .any(|spec| spec.id.as_str() == key.as_str())
            {
                continue;
            }
            if let Some(profile) = &profile {
                if profile
                    .instance_params()
                    .any(|p| p.id.as_str() == key.as_str())
                {
                    continue;
                }
                if profile.params.iter().any(|p| p.id.as_str() == key.as_str()) {
                    return Err(msg(format!(
                        "'{key}' is a type value of profile '{}' and cannot be set per element; \
                         choose another profile via the `profile` param (describe_api `profiles` lists them)",
                        profile.id
                    )));
                }
            }
            let mut known: Vec<String> = def.params.iter().map(|s| s.id.to_string()).collect();
            if let Some(profile) = &profile {
                known.extend(profile.instance_params().map(|p| p.id.to_string()));
            }
            return Err(msg(format!(
                "unknown param '{key}' for {component} (known: {})",
                known.join(", ")
            )));
        }
        Ok(())
    }

    /// Openings (doors, windows, slab openings) must be created in a host,
    /// otherwise they float without cutting anything.
    fn check_host(&self, component: &str, parent: Option<ElementId>) -> Result<(), CommandError> {
        let Some(def) = self.registry().get(component) else {
            return Ok(());
        };
        if def.category != "opening" {
            return Ok(());
        }
        let want = if component == "apex.slab_opening" {
            "slab"
        } else {
            "wall"
        };
        let Some(parent) = parent else {
            return Err(msg(format!(
                "{component} must be hosted: pass `parent` = the {want} id (in a batch, \"$N.id\" of the step that created it)"
            )));
        };
        let host = self
            .document()
            .get_element(parent)
            .map(|h| h.component_id.clone())
            .unwrap_or_default();
        let host_cat = self
            .registry()
            .get(&host)
            .map(|d| d.category.clone())
            .unwrap_or_default();
        let ok = host_cat == want || (want == "slab" && host_cat == "roof");
        if !host_cat.is_empty() && !ok {
            return Err(msg(format!(
                "{component} needs a {want} as parent, but {parent} is a {host}"
            )));
        }
        Ok(())
    }

    fn resolve_elements(&self, raw: &[String]) -> Result<Vec<ElementId>, CommandError> {
        raw.iter().map(|i| self.resolve_element(i)).collect()
    }

    /// Run `f` with `level` active, restoring the previous active level after.
    fn on_level<T>(
        &mut self,
        level: Option<LevelId>,
        f: impl FnOnce(&mut Self) -> Result<T, CommandError>,
    ) -> Result<T, CommandError> {
        let previous = self.document().active_level_id();
        if let Some(level) = level {
            self.set_active_level(level).map_err(e)?;
        }
        let out = f(self);
        if let (Some(_), Some(prev)) = (level, previous) {
            let _ = self.set_active_level(prev);
        }
        out
    }

    /// Let batch steps use the MCP shortcut names: `{"op": "place_wall", ...}`
    /// becomes `{"op": "create_element", "component": "apex.wall", ...}`.
    fn expand_place_alias(&self, raw: &mut Value) {
        let Some(op) = raw.get("op").and_then(Value::as_str) else {
            return;
        };
        let Some(short) = op.strip_prefix("place_") else {
            return;
        };
        let short = short.to_string();
        let found = self
            .registry()
            .components()
            .map(|d| d.id.clone())
            .find(|id| {
                let s = id.strip_prefix("apex.").unwrap_or(id);
                let name: String = s
                    .chars()
                    .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
                    .collect();
                name == short
            });
        if let (Some(component), Some(obj)) = (found, raw.as_object_mut()) {
            obj.insert("op".into(), json!("create_element"));
            obj.entry("component").or_insert(json!(component));
        }
    }

    fn apply(&mut self, command: Command) -> CmdResult {
        match command {
            Command::CreateElement {
                component,
                points,
                rotation,
                params,
                placement_kind,
                parent,
                level,
                name,
            } => {
                let level = level.map(|l| self.resolve_level(&l)).transpose()?;
                self.check_params(&component, &params)?;
                let kind = match placement_kind.as_deref().map(str::trim) {
                    None | Some("") => None,
                    Some(k) => Some(
                        PlacementKind::from_name(k)
                            .ok_or_else(|| msg(format!("unknown placement_kind '{k}'")))?,
                    ),
                };
                let parent = match parent {
                    Some(p) if !p.trim().is_empty() => Some(self.resolve_element(&p)?),
                    _ => None,
                };
                self.check_host(&component, parent)?;
                let id = self.on_level(level, |p| {
                    let placement = p
                        .placement_from_gesture(&component, kind, &pts(&points), rotation)
                        .map_err(e)?;
                    p.create_element_with_parent(&component, placement, params, parent)
                        .map_err(e)
                })?;
                if let Some(name) = name {
                    self.rename_element(id, &name).map_err(e)?;
                }
                Ok(json!({ "id": id.to_string() }))
            }
            Command::UpdateElement {
                id,
                params,
                points,
                placement_kind,
            } => {
                let id = self.resolve_element(&id)?;
                let placement = match points {
                    Some(points) => {
                        let component = self
                            .document()
                            .get_element(id)
                            .map(|el| el.component_id.clone())
                            .unwrap_or_default();
                        let kind = placement_kind.as_deref().and_then(PlacementKind::from_name);
                        Some(
                            self.placement_from_gesture(&component, kind, &pts(&points), 0.0)
                                .map_err(e)?,
                        )
                    }
                    None => None,
                };
                let component = self
                    .document()
                    .get_element(id)
                    .map(|el| el.component_id.clone())
                    .unwrap_or_default();
                self.check_params(&component, &params)?;
                self.update_element(id, Some(params), placement, true)
                    .map_err(e)?;
                Ok(json!({ "id": id.to_string() }))
            }
            Command::DeleteElement { id } => {
                let id = self.resolve_element(&id)?;
                Ok(json!({ "deleted": self.delete_element(id) }))
            }
            Command::SetParent { id, parent } => {
                let id = self.resolve_element(&id)?;
                let parent = parent.map(|p| self.resolve_element(&p)).transpose()?;
                let changed = self.set_element_parent(id, parent).map_err(e)?;
                Ok(json!({ "changed": ids_json(&changed) }))
            }
            Command::MoveElements { ids, delta } => {
                let ids = self.resolve_elements(&ids)?;
                self.translate_elements(&ids, Vec3::from_array(delta), true)
                    .map_err(e)?;
                Ok(json!({ "moved": ids.len() }))
            }
            Command::CopyElements { ids, delta } => {
                let ids = self.resolve_elements(&ids)?;
                let new = self
                    .copy_elements(&ids, Vec3::from_array(delta))
                    .map_err(e)?;
                Ok(json!({ "ids": ids_json(&new) }))
            }
            Command::Boolean { a, b, operation } => {
                let a = self.resolve_element(&a)?;
                let b = self.resolve_element(&b)?;
                if a == b {
                    return Err(msg("boolean operands must be different elements"));
                }
                if !["subtract", "union", "intersect"].contains(&operation.as_str()) {
                    return Err(msg(format!(
                        "operation must be subtract, union or intersect, got '{operation}'"
                    )));
                }
                let level = self.document().get_element(a).map(|el| el.level_id);
                let id = self.on_level(level, |p| {
                    let placement = p
                        .placement_from_gesture("apex.boolean", None, &[Vec3::ZERO], 0.0)
                        .map_err(e)?;
                    p.create_element(
                        "apex.boolean",
                        placement,
                        super::boolean_params(a, b, &operation),
                    )
                    .map_err(e)
                })?;
                Ok(json!({ "id": id.to_string() }))
            }
            Command::SetSlabShape { id, shape } => {
                let id = self.resolve_element(&id)?;
                self.set_slab_shape(id, &shape).map_err(e)?;
                Ok(json!({ "id": id.to_string() }))
            }
            Command::JoinPaths { id } => {
                let id = self.resolve_element(&id)?;
                self.join_paths(id).map_err(e)?;
                Ok(json!({ "id": id.to_string() }))
            }
            Command::CreateLevel { name, elevation } => {
                Ok(json!({ "id": self.add_level(&name, elevation).to_string() }))
            }
            Command::SetActiveLevel { id } => {
                let id = self.resolve_level(&id)?;
                self.set_active_level(id).map_err(e)?;
                Ok(json!({ "id": id.to_string() }))
            }
            Command::SetLevelElevation { id, elevation } => {
                let id = self.resolve_level(&id)?;
                self.set_level_elevation(id, elevation).map_err(e)?;
                Ok(json!({ "id": id.to_string() }))
            }
            Command::CreateGridAxis { points, params } => {
                let placement = self
                    .placement_for_grid_axis(&pts(&points), 0.0)
                    .map_err(e)?;
                Ok(
                    json!({ "id": self.create_grid_axis(placement, params).map_err(e)?.to_string() }),
                )
            }
            Command::DeleteGridAxis { id } => {
                let id: GridAxisId = parse_id("grid axis", &id)?;
                Ok(json!({ "deleted": self.delete_grid_axis(id) }))
            }
            Command::CreateReference {
                kind,
                points,
                rotation,
            } => {
                let kind = match kind.as_str() {
                    "point" => ReferenceKind::Point,
                    "plane" => ReferenceKind::Plane,
                    other => {
                        return Err(msg(format!(
                            "reference kind must be 'point' or 'plane', got '{other}'"
                        )))
                    }
                };
                let placement = self
                    .placement_for_reference(kind, &pts(&points), rotation)
                    .map_err(e)?;
                Ok(json!({ "id": self.create_reference(kind, placement).map_err(e)?.to_string() }))
            }
            Command::DeleteReference { id } => {
                let id: RefId = parse_id("reference", &id)?;
                Ok(json!({ "deleted": self.delete_reference(id) }))
            }
            Command::CreateSpace {
                points,
                params,
                name,
            } => {
                let placement = self.placement_for_space(&pts(&points), 0.0).map_err(e)?;
                let id = self.create_space(placement, params).map_err(e)?;
                if let Some(name) = name {
                    self.rename_space(id, &name).map_err(e)?;
                }
                Ok(json!({ "id": id.to_string() }))
            }
            Command::UpdateSpace { id, name, params } => {
                let id: SpaceId = parse_id("space", &id)?;
                if let Some(params) = params {
                    self.update_space(id, Some(params), None, true).map_err(e)?;
                }
                if let Some(name) = name {
                    self.rename_space(id, &name).map_err(e)?;
                }
                Ok(json!({ "id": id.to_string() }))
            }
            Command::DeleteSpace { id } => {
                let id: SpaceId = parse_id("space", &id)?;
                Ok(json!({ "deleted": self.delete_space(id) }))
            }
            Command::DetectRooms => {
                Ok(json!({ "rooms": self.detect_rooms_from_walls().map_err(e)? }))
            }
            Command::CreatePlanView { level } => {
                let level = self.resolve_level(&level)?;
                Ok(json!({ "id": self.create_plan_view(level).map_err(e)?.to_string() }))
            }
            Command::Create3dView => Ok(json!({ "id": self.create_three_d_view().to_string() })),
            Command::RenameView { id, name } => {
                let id: ViewId = parse_id("view", &id)?;
                self.rename_view(id, name).map_err(e)?;
                Ok(json!({ "id": id.to_string() }))
            }
            Command::DeleteView { id } => {
                let id: ViewId = parse_id("view", &id)?;
                self.delete_view(id).map_err(e)?;
                Ok(json!({ "deleted": true }))
            }
            Command::CreateViewAnnotation { view, annotation } => {
                let view: ViewId = parse_id("view", &view)?;
                Ok(
                    json!({ "id": self.create_view_annotation(view, annotation).map_err(e)?.to_string() }),
                )
            }
            Command::DeleteViewAnnotation { id } => {
                let id: ViewAnnotationId = parse_id("annotation", &id)?;
                self.delete_view_annotation(id).map_err(e)?;
                Ok(json!({ "deleted": true }))
            }
            Command::CreateSheet { number, name } => {
                Ok(json!({ "id": self.create_sheet(number, name).to_string() }))
            }
            Command::DeleteSheet { id } => {
                let id: SheetId = parse_id("sheet", &id)?;
                self.delete_sheet(id).map_err(e)?;
                Ok(json!({ "deleted": true }))
            }
            Command::PlaceViewOnSheet {
                sheet,
                view,
                center_x_mm,
                center_y_mm,
            } => {
                let sheet: SheetId = parse_id("sheet", &sheet)?;
                let view: ViewId = parse_id("view", &view)?;
                let id = self
                    .place_view_on_sheet(sheet, view, center_x_mm, center_y_mm, 0.0, 0.0)
                    .map_err(e)?;
                Ok(json!({ "id": id.to_string() }))
            }
            Command::Batch { commands } => {
                let mut results: Vec<Value> = Vec::with_capacity(commands.len());
                for (i, mut raw) in commands.into_iter().enumerate() {
                    resolve_batch_refs(&mut raw, &results)
                        .map_err(|err| msg(format!("batch step {i}: {err}")))?;
                    self.expand_place_alias(&mut raw);
                    let command: Command = serde_json::from_value(raw)
                        .map_err(|err| msg(format!("batch step {i}: invalid command: {err}")))?;
                    if matches!(command, Command::Undo | Command::Redo) {
                        return Err(msg(format!(
                            "batch step {i}: undo/redo are not allowed inside a batch"
                        )));
                    }
                    let op = command.op();
                    let out = self
                        .apply(command)
                        .map_err(|err| msg(format!("batch step {i} ({op}): {err}")))?;
                    results.push(out);
                }
                Ok(json!({ "results": results }))
            }
            Command::Undo | Command::Redo => Err(msg("undo/redo must be executed on their own")),
        }
    }
}

/// Replace `"$N"` / `"$N.field"` strings in a batch step with values from
/// earlier step results.
fn resolve_batch_refs(v: &mut Value, results: &[Value]) -> Result<(), String> {
    match v {
        Value::String(s) if s.starts_with('$') => {
            let body = &s[1..];
            let (idx, field) = match body.split_once('.') {
                Some((i, f)) => (i, Some(f)),
                None => (body, None),
            };
            let Ok(n) = idx.parse::<usize>() else {
                return Ok(());
            };
            let Some(res) = results.get(n) else {
                return Err(format!(
                    "'{s}' refers to step {n}, but only steps 0..{} ran before this one",
                    results.len()
                ));
            };
            let mut out = res;
            if let Some(f) = field {
                for part in f.split('.') {
                    out = out.get(part).ok_or_else(|| {
                        format!("'{s}': step {n} result has no '{part}' (result: {res})")
                    })?;
                }
            }
            *v = out.clone();
            Ok(())
        }
        Value::Array(a) => a
            .iter_mut()
            .try_for_each(|x| resolve_batch_refs(x, results)),
        Value::Object(o) => o
            .values_mut()
            .try_for_each(|x| resolve_batch_refs(x, results)),
        _ => Ok(()),
    }
}

impl Project {
    /// Run a read-only query.
    pub fn query(&self, query: &Query) -> CmdResult {
        let doc = self.document();
        match query {
            Query::Summary => {
                let mut by_component = std::collections::BTreeMap::<String, usize>::new();
                for el in doc.elements() {
                    *by_component.entry(el.component_id.clone()).or_default() += 1;
                }
                Ok(json!({
                    "levels": self.levels_json(),
                    "element_count": doc.elements().count(),
                    "elements_by_component": by_component,
                    "grid_axes": doc.grid_axes().count(),
                    "spaces": doc.spaces().count(),
                    "views": self.views().count(),
                    "sheets": self.sheets().count(),
                    "can_undo": self.can_undo(),
                    "can_redo": self.can_redo(),
                }))
            }
            Query::ListLevels => Ok(self.levels_json()),
            Query::ListElements { level, component } => {
                let level = level.as_deref().map(|l| self.resolve_level(l)).transpose()?;
                let mut out: Vec<Value> = doc
                    .elements()
                    .filter(|el| level.is_none() || doc.effective_level_id(el.id) == level)
                    .filter(|el| component.as_ref().is_none_or(|c| &el.component_id == c))
                    .map(|el| {
                        json!({
                            "id": el.id.to_string(),
                            "name": el.name,
                            "component": el.component_id,
                            "level": doc.effective_level_id(el.id).map(|i| i.to_string()),
                            "parent": el.parent_id.map(|i| i.to_string()),
                        })
                    })
                    .collect();
                out.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
                Ok(Value::Array(out))
            }
            Query::GetElement { id } => {
                let id = self.resolve_element(id)?;
                let el = doc.get_element(id).ok_or_else(|| msg("element vanished"))?;
                Ok(json!({
                    "id": el.id.to_string(),
                    "name": el.name,
                    "component": el.component_id,
                    "level": doc.effective_level_id(el.id).map(|i| i.to_string()),
                    "parent": el.parent_id.map(|i| i.to_string()),
                    "children": ids_json(&doc.children_of(id)),
                    "params": el.params,
                    "placement": el.placement,
                    "anchors": el.placement.anchors().iter().map(|v| v.to_array()).collect::<Vec<_>>(),
                }))
            }
            Query::ElementGeometry { id } => {
                let id = self.resolve_element(id)?;
                Ok(self.geometry_json(id))
            }
            Query::Validate => Ok(self.validate_json()),
            Query::ListComponents => serde_json::to_value(component_catalog(self)).map_err(e),
            Query::ListGridAxes => Ok(Value::Array(
                doc.grid_axes()
                    .map(|a| {
                        json!({
                            "id": a.id.to_string(),
                            "name": a.name,
                            "level": a.level_id.to_string(),
                            "params": a.params,
                            "anchors": a.placement.anchors().iter().map(|v| v.to_array()).collect::<Vec<_>>(),
                        })
                    })
                    .collect(),
            )),
            Query::ListSpaces => Ok(Value::Array(
                doc.spaces()
                    .map(|s| {
                        json!({
                            "id": s.id.to_string(),
                            "name": s.name,
                            "level": s.level_id.to_string(),
                            "outline": s.placement.anchors().iter().map(|v| v.to_array()).collect::<Vec<_>>(),
                            "params": s.params,
                        })
                    })
                    .collect(),
            )),
            Query::ListViews => Ok(Value::Array(
                self.views()
                    .map(|v| json!({"id": v.id.to_string(), "name": v.name, "kind": v.kind}))
                    .collect(),
            )),
            Query::ListSheets => Ok(Value::Array(
                self.sheets()
                    .map(|s| {
                        json!({
                            "id": s.id.to_string(),
                            "number": s.number,
                            "name": s.name,
                            "viewports": s.viewports.len(),
                        })
                    })
                    .collect(),
            )),
            Query::ExportView { id, format } => {
                let id: ViewId = parse_id("view", id)?;
                let drawing = self
                    .vector_export_view(id)
                    .ok_or_else(|| msg("vector export supports existing plan views only"))?;
                export_drawing(&drawing, format)
            }
            Query::ExportSheet { id, format } => {
                let id: SheetId = parse_id("sheet", id)?;
                let drawing = self
                    .vector_export_sheet(id)
                    .ok_or_else(|| msg("sheet not found"))?;
                export_drawing(&drawing, format)
            }
            Query::ExportProject => serde_json::to_value(self.export_snapshot()).map_err(e),
        }
    }

    fn levels_json(&self) -> Value {
        let mut levels: Vec<_> = self.document().levels().collect();
        levels.sort_by(|a, b| a.elevation.total_cmp(&b.elevation));
        let active = self.document().active_level_id();
        Value::Array(
            levels
                .iter()
                .map(|l| {
                    json!({
                        "id": l.id.to_string(),
                        "name": l.name,
                        "elevation": l.elevation,
                        "active": Some(l.id) == active,
                    })
                })
                .collect(),
        )
    }

    fn geometry_json(&self, id: ElementId) -> Value {
        let doc = self.document();
        let Some(el) = doc.get_element(id) else {
            return json!({ "id": id.to_string(), "has_mesh": false });
        };
        let Some(mesh) = doc.get_mesh(id).filter(|m| !m.indices.is_empty()) else {
            let key = id.to_string();
            let consumer = doc.elements().find(|b| {
                b.component_id == "apex.boolean"
                    && ["operand_a", "operand_b"]
                        .iter()
                        .any(|k| b.params.text(k) == Some(key.as_str()))
            });
            if let Some(b) = consumer {
                return json!({
                    "id": key,
                    "has_mesh": false,
                    "consumed_by_boolean": b.id.to_string(),
                    "note": "this element is an operand of a boolean; its solid is shown as part of that boolean (query the boolean id, or set show_operands)",
                });
            }
            return json!({ "id": key, "has_mesh": false });
        };
        let mut min = [f32::MAX; 3];
        let mut max = [f32::MIN; 3];
        for p in mesh.positions.chunks(3) {
            for k in 0..3 {
                min[k] = min[k].min(p[k]);
                max[k] = max[k].max(p[k]);
            }
        }
        let size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
        json!({
            "id": id.to_string(),
            "has_mesh": true,
            "bbox": { "min": min, "max": max, "size": size },
            "volume": mesh_volume(mesh),
            "triangles": mesh.indices.len() / 3,
            "watertight": self.closed_solid_ids().contains(&id),
            "piece_closed": is_closed(mesh),
            "manifold": is_watertight(mesh),
            "joins": { "start": el.join_start, "end": el.join_end },
            "children": ids_json(&doc.children_of(id)),
        })
    }

    /// Elements whose solid is closed. Joined walls render without the faces
    /// they share (each render piece is open there), so the check uses the
    /// element's own closed share of its join cluster, the same solid booleans
    /// consume.
    fn closed_solid_ids(&self) -> std::collections::HashSet<ElementId> {
        let doc = self.document();
        doc.elements()
            .filter(|el| {
                let own = self.closed_solid_mesh(el);
                match own.as_ref().or_else(|| doc.get_mesh(el.id)) {
                    Some(mesh) => !mesh.indices.is_empty() && is_closed(mesh),
                    None => false,
                }
            })
            .map(|el| el.id)
            .collect()
    }

    fn validate_json(&self) -> Value {
        let closed = self.closed_solid_ids();
        let doc = self.document();
        let mut issues = Vec::new();
        let issue = |sev: &str, el: &crate::element::Element, text: &str| json!({"severity": sev, "element": el.id.to_string(), "name": el.name, "component": el.component_id, "message": text});
        for el in doc.elements() {
            let Some(def) = self.registry().get(&el.component_id) else {
                issues.push(issue("error", el, "unknown component"));
                continue;
            };
            if let Some(parent) = el.parent_id {
                if doc.get_element(parent).is_none() {
                    issues.push(issue("error", el, "parent element is missing"));
                }
            }
            // Openings are voids that cut their host; they have no own solid.
            if def.category == "opening" || self.boolean_hides(el.id) {
                continue;
            }
            match doc.get_mesh(el.id) {
                Some(mesh) if !mesh.indices.is_empty() => {
                    if !closed.contains(&el.id) {
                        issues.push(issue("error", el, "mesh is not watertight"));
                    }
                }
                _ => issues.push(issue("error", el, "element has no geometry")),
            }
        }
        let errors = issues.iter().filter(|i| i["severity"] == "error").count();
        json!({
            "ok": errors == 0,
            "checked": doc.elements().count(),
            "errors": errors,
            "warnings": issues.len() - errors,
            "issues": issues,
        })
    }
}

fn export_drawing(drawing: &crate::vector_export::VectorDrawing2d, format: &str) -> CmdResult {
    match format {
        "dxf" => Ok(json!({ "format": "dxf", "content": crate::dxf_export::drawing_to_dxf(drawing) })),
        "svg" => Ok(json!({ "format": "svg", "content": crate::svg_export::drawing_to_svg(drawing) })),
        "json" => Ok(json!({ "format": "json", "content": drawing })),
        other => Err(msg(format!(
            "unsupported export format '{other}' (svg, dxf or json here; IFC via export_ifc, PDF from the web app)"
        ))),
    }
}

// ---------------------------------------------------------------------------
// Catalog: machine-readable descriptors for everything an agent can call.
// ---------------------------------------------------------------------------

/// Every installed element type (builtins and plugins) with its params schema.
pub fn component_catalog(project: &Project) -> Vec<PublishedDescriptor> {
    project
        .registry()
        .components()
        .map(|def| {
            // Profile-driven types also accept the default profile's
            // instance params (e.g. wall `height`).
            let mut specs = def.params.clone();
            let default_profile = def.profile_param_id().and_then(|pid| {
                def.resolve_params(&ParamMap::new())
                    .ok()?
                    .text(pid)
                    .map(str::to_string)
            });
            if let Some(profile) = default_profile.and_then(|id| project.registry().profile(&id)) {
                for spec in profile.instance_params() {
                    if !specs.iter().any(|s| s.id == spec.id) {
                        specs.push(spec.clone());
                    }
                }
            }
            let mut d = PublishedDescriptor::new(
                "element_type",
                def.id.clone(),
                def.display_name.clone(),
                &def.descriptor,
                params_json_schema(&specs),
            );
            if d.descriptor.points.is_none() {
                d.descriptor.points = Some(format!("placement kind: {}", def.placement.as_str()));
            }
            d
        })
        .collect()
}

fn point_schema() -> Value {
    json!({"type": "array", "items": {"type": "number"}, "minItems": 3, "maxItems": 3,
           "description": "[x, y, z] in metres; plan is the XZ plane, +Y is up"})
}

fn points_schema() -> Value {
    json!({"type": "array", "items": point_schema(), "description": "placement picks in world metres"})
}

fn id_schema() -> Value {
    json!({"type": "string"})
}

fn obj(op: &str, props: Value, required: &[&str]) -> Value {
    let mut props = props;
    if let Value::Object(map) = &mut props {
        map.insert("op".into(), json!({"const": op}));
    }
    let mut req: Vec<&str> = vec!["op"];
    req.extend_from_slice(required);
    json!({"type": "object", "properties": props, "required": req, "additionalProperties": false})
}

fn simple(op: &str, props: Value, required: &[&str]) -> Value {
    obj(op, props, required)
}

/// Descriptor and input schema for every command.
pub fn command_descriptors() -> Vec<PublishedDescriptor> {
    let params = || json!({"type": "object", "description": "param values by id; see the element type's params_schema (list_components)"});
    let grid_props = params_json_schema(&grid_axis_param_specs())["properties"].clone();
    let space_props = params_json_schema(&space_param_specs())["properties"].clone();
    let one = |op: &str| obj(op, json!({"id": id_schema()}), &["id"]);
    let none = |op: &str| obj(op, json!({}), &[]);
    let rows: Vec<(&str, &str, Descriptor, Value)> = vec![
        ("create_element", "Create element",
         Descriptor::new("Place a new element of any installed type (wall, slab, door, plugin types...) from placement points. Returns its id.")
            .points("as many picks as the type's placement kind: point = 1, two_point = 2, polyline/path = 2+ (slab/roof: closed outline, do not repeat the first point)")
            .constraint("hosted types (door, window, slab_opening) need `parent` = host id and one point on the host")
            .constraint("`level` (id or name) defaults to the active level")
            .example("Wall along x", json!({"op": "create_element", "component": "apex.wall", "points": [[0,0,0],[5,0,0]]}))
            .example("Door in a wall", json!({"op": "create_element", "component": "apex.door", "points": [[2,0,0]], "parent": "<wall id>"})),
         obj("create_element", json!({"component": {"type": "string"}, "points": points_schema(), "rotation": {"type": "number", "description": "radians about +Y"}, "params": params(), "placement_kind": {"type": "string", "enum": ["point","two_point","three_point_arc","polyline","path","free"]}, "parent": id_schema(), "level": {"type": "string"}, "name": {"type": "string"}}), &["component", "points"])),
        ("update_element", "Update element",
         Descriptor::new("Change params and/or replace placement points of an element. Params not listed keep their value.")
            .example("Taller wall", json!({"op": "update_element", "id": "<id>", "params": {"height": 3.5}})),
         obj("update_element", json!({"id": id_schema(), "params": params(), "points": points_schema(), "placement_kind": {"type": "string"}}), &["id"])),
        ("delete_element", "Delete element", Descriptor::new("Delete an element and its hosted children."), one("delete_element")),
        ("set_parent", "Set parent", Descriptor::new("Attach an element to a parent (it then follows the parent's level) or detach with null."),
         obj("set_parent", json!({"id": id_schema(), "parent": {"type": ["string", "null"]}}), &["id", "parent"])),
        ("move_elements", "Move", Descriptor::new("Translate elements by a world delta (the Move tool)."),
         obj("move_elements", json!({"ids": {"type": "array", "items": id_schema()}, "delta": point_schema()}), &["ids", "delta"])),
        ("copy_elements", "Copy", Descriptor::new("Copy elements by a world delta (the Copy tool). Returns the new ids."),
         obj("copy_elements", json!({"ids": {"type": "array", "items": id_schema()}, "delta": point_schema()}), &["ids", "delta"])),
        ("boolean", "Boolean",
         Descriptor::new("Create a parametric boolean of two solids: subtract (A minus B), union or intersect. Operands are hidden but stay editable.")
            .example("A minus B", json!({"op": "boolean", "a": "<id>", "b": "<id>", "operation": "subtract"})),
         obj("boolean", json!({"a": id_schema(), "b": id_schema(), "operation": {"type": "string", "enum": ["subtract", "union", "intersect"], "default": "subtract"}}), &["a", "b"])),
        ("set_slab_shape", "Set slab shape",
         Descriptor::new("Shape a slab or flat roof (sub-element edit): `z` = height offset per outline vertex, `points` = extra interior [x, dy, z] points, `creases` = vertex index pairs. An empty shape is flat.")
            .units("metres, offsets relative to the flat top")
            .example("Lift vertices 1 and 2", json!({"op": "set_slab_shape", "id": "<slab id>", "shape": {"z": [0, 0.6, 0.6, 0]}})),
         obj("set_slab_shape", json!({"id": id_schema(), "shape": {"type": "object", "properties": {"z": {"type": "array", "items": {"type": "number"}}, "points": {"type": "array", "items": point_schema()}, "creases": {"type": "array", "items": {"type": "array", "items": {"type": "integer"}}}}}}), &["id", "shape"])),
        ("join_paths", "Join paths", Descriptor::new("Recompute corner/T joins for a joinable path element (walls join automatically on create)."), one("join_paths")),
        ("create_level", "Create level", Descriptor::new("Add a storey at an elevation.").example("First floor", json!({"op": "create_level", "name": "Level 2", "elevation": 3.0})),
         obj("create_level", json!({"name": {"type": "string"}, "elevation": {"type": "number"}}), &["name", "elevation"])),
        ("set_active_level", "Set active level", Descriptor::new("Make a level (id or name) the default for new placements."), one("set_active_level")),
        ("set_level_elevation", "Set level elevation", Descriptor::new("Move a level; elements on it follow."),
         obj("set_level_elevation", json!({"id": id_schema(), "elevation": {"type": "number"}}), &["id", "elevation"])),
        ("create_grid_axis", "Create grid axis", Descriptor::new("Add a structural grid axis (datum line) between two plan points. Labels auto-increment.").points("two plan points"),
         obj("create_grid_axis", json!({"points": points_schema(), "params": {"type": "object", "properties": grid_props}}), &["points"])),
        ("delete_grid_axis", "Delete grid axis", Descriptor::new("Remove a grid axis."), one("delete_grid_axis")),
        ("create_reference", "Create reference", Descriptor::new("Add a reference point (1 pick) or vertical reference plane (2 picks). Params of kind reference can bind to it."),
         obj("create_reference", json!({"kind": {"type": "string", "enum": ["point", "plane"]}, "points": points_schema(), "rotation": {"type": "number"}}), &["kind", "points"])),
        ("delete_reference", "Delete reference", Descriptor::new("Remove a reference point or plane."), one("delete_reference")),
        ("create_space", "Create space", Descriptor::new("Add a room/space from a closed plan polygon (3+ points) on the active level.").points("closed outline, first point not repeated"),
         obj("create_space", json!({"points": points_schema(), "params": {"type": "object", "properties": space_props}, "name": {"type": "string"}}), &["points"])),
        ("update_space", "Update space", Descriptor::new("Rename a room/space (its plan tag follows) and/or change its params.").example("Name a room", json!({"op": "update_space", "id": "<space id>", "name": "KITCHEN"})),
         obj("update_space", json!({"id": {"type": "string"}, "name": {"type": "string"}, "params": {"type": "object", "properties": space_props}}), &["id"])),
        ("delete_space", "Delete space", Descriptor::new("Remove a space."), one("delete_space")),
        ("detect_rooms", "Detect rooms", Descriptor::new("Find closed wall loops on the active level and create or refresh automatic spaces."), none("detect_rooms")),
        ("create_plan_view", "Create plan view", Descriptor::new("Add a plan view for a level (id or name)."),
         obj("create_plan_view", json!({"level": {"type": "string"}}), &["level"])),
        ("create_3d_view", "Create 3D view", Descriptor::new("Add a saved 3D view."), none("create_3d_view")),
        ("rename_view", "Rename view", Descriptor::new("Rename a view."), obj("rename_view", json!({"id": id_schema(), "name": {"type": "string"}}), &["id", "name"])),
        ("delete_view", "Delete view", Descriptor::new("Delete a view."), one("delete_view")),
        ("create_view_annotation", "Create annotation",
         Descriptor::new("Add a view-owned annotation to a plan view. `annotation` is one of the annotation types in the catalog, tagged by `kind`.")
            .example("Text note", json!({"op": "create_view_annotation", "view": "<view id>", "annotation": {"kind": "text_note", "position": {"kind": "world", "point": [1.0, 0.0, 1.0]}, "text": "Hall"}})),
         obj("create_view_annotation", json!({"view": id_schema(), "annotation": {"type": "object", "description": "{\"kind\": \"linear_dimension\"|\"text_note\"|\"leader_tag\", ...}; see annotation_types"}}), &["view", "annotation"])),
        ("delete_view_annotation", "Delete annotation", Descriptor::new("Delete a view annotation."), one("delete_view_annotation")),
        ("create_sheet", "Create sheet", Descriptor::new("Add a drawing sheet."), obj("create_sheet", json!({"number": {"type": "string"}, "name": {"type": "string"}}), &["number", "name"])),
        ("delete_sheet", "Delete sheet", Descriptor::new("Delete a sheet."), one("delete_sheet")),
        ("place_view_on_sheet", "Place view on sheet", Descriptor::new("Place a view on a sheet as a viewport.").units("sheet millimetres"),
         obj("place_view_on_sheet", json!({"sheet": id_schema(), "view": id_schema(), "center_x_mm": {"type": "number"}, "center_y_mm": {"type": "number"}}), &["sheet", "view"])),
        ("undo", "Undo", Descriptor::new("Undo the last command; a batch counts as one."), none("undo")),
        ("redo", "Redo", Descriptor::new("Redo the last undone command."), none("redo")),
        ("batch", "Batch",
         Descriptor::new("Run several commands as one undo step, all-or-nothing: if any step fails nothing is applied. Results come back in order. A later step can use an earlier result: the string \"$N.id\" (or \"$N.<field>\") anywhere in a step is replaced by that field of step N's result (0-based). Steps may also use the place_<type> shortcut names as `op`.")
            .example("Wall with a door", json!({"op": "batch", "commands": [{"op": "create_element", "component": "apex.wall", "points": [[0.0, 0.0, 0.0], [5.0, 0.0, 0.0]]}, {"op": "create_element", "component": "apex.door", "parent": "$0.id", "points": [[2.0, 0.0, 0.0]]}]}))
            .example("Two levels", json!({"op": "batch", "commands": [{"op": "create_level", "name": "L1", "elevation": 3.0}, {"op": "create_level", "name": "L2", "elevation": 6.0}]})),
         obj("batch", json!({"commands": {"type": "array", "items": {"type": "object", "description": "a command object with its own `op`"}}}), &["commands"])),
    ];
    rows.into_iter()
        .map(|(op, name, d, schema)| PublishedDescriptor::new("command", op, name, &d, schema))
        .collect()
}

/// Descriptor and input schema for every query.
pub fn query_descriptors() -> Vec<PublishedDescriptor> {
    let fmt = json!({"type": "string", "enum": ["svg", "dxf", "json"]});
    let rows: Vec<(&str, &str, &str, Value)> = vec![
        ("summary", "Model summary", "Levels, element counts by type, views, sheets and undo state.", simple("summary", json!({}), &[])),
        ("list_levels", "List levels", "Levels sorted by elevation, with the active one marked.", simple("list_levels", json!({}), &[])),
        ("list_elements", "List elements", "Elements, optionally filtered by level (id or name) and element type id.", simple("list_elements", json!({"level": {"type": "string"}, "component": {"type": "string"}}), &[])),
        ("get_element", "Get element", "One element: params, placement, anchors, parent and children.", simple("get_element", json!({"id": id_schema()}), &["id"])),
        ("element_geometry", "Element geometry", "Geometry summary: bbox (m), volume (m3), triangle count, watertight flag (closed surface, T-junctions allowed), strict manifold flag and path join extensions.", simple("element_geometry", json!({"id": id_schema()}), &["id"])),
        ("validate", "Validate model", "Check every element: known type, geometry present, watertight, parent exists. `ok` is false on any error.", simple("validate", json!({}), &[])),
        ("list_components", "List element types", "Every installed element type (plugins included) with descriptor and params JSON Schema.", simple("list_components", json!({}), &[])),
        ("list_grid_axes", "List grid axes", "Grid axes with labels and end points.", simple("list_grid_axes", json!({}), &[])),
        ("list_spaces", "List spaces", "Rooms/spaces with names, levels and outline (world points, m).", simple("list_spaces", json!({}), &[])),
        ("list_views", "List views", "Saved views (plans and 3D).", simple("list_views", json!({}), &[])),
        ("list_sheets", "List sheets", "Sheets with viewport counts.", simple("list_sheets", json!({}), &[])),
        ("export_view", "Export view", "Export a plan view drawing as svg, dxf or json.", simple("export_view", json!({"id": id_schema(), "format": fmt.clone()}), &["id", "format"])),
        ("export_sheet", "Export sheet", "Export a sheet as svg, dxf or json.", simple("export_sheet", json!({"id": id_schema(), "format": fmt}), &["id", "format"])),
        ("export_project", "Export project", "The full project JSON (what Save writes).", simple("export_project", json!({}), &[])),
    ];
    rows.into_iter()
        .map(|(op, name, purpose, schema)| {
            PublishedDescriptor::new("query", op, name, &Descriptor::new(purpose), schema)
        })
        .collect()
}

/// Descriptors for view annotation types. The match is exhaustive over
/// [`ViewAnnotationKind`], so a new kind cannot ship undescribed.
pub fn annotation_descriptors() -> Vec<PublishedDescriptor> {
    let anchor = json!({"type": "object", "description": "{\"kind\": \"world\", \"point\": [x,y,z]} | {\"kind\": \"element_anchor\", \"element_id\": id, \"anchor_index\": n} | {\"kind\": \"grid_axis_end\", \"grid_axis_id\": id, \"end\": \"start\"|\"end\"}"});
    let at = |x: f32, z: f32| AnnotationAnchor::World { point: [x, 0.0, z] };
    let samples = [
        ViewAnnotationKind::LinearDimension {
            a: at(0.0, 0.0),
            b: at(5.0, 0.0),
            offset: -0.8,
        },
        ViewAnnotationKind::TextNote {
            position: at(1.0, 1.0),
            text: "Hall".into(),
        },
        ViewAnnotationKind::LeaderTag {
            head: at(0.0, 0.0),
            tail: at(1.0, 1.0),
            text: "W1".into(),
        },
    ];
    samples
        .iter()
        .map(|kind| {
            let (id, name, purpose, props, req): (&str, &str, &str, Value, &[&str]) = match kind {
                ViewAnnotationKind::LinearDimension { .. } => ("linear_dimension", "Linear dimension", "Associative distance between two anchors, drawn offset (metres) from the measured line.", json!({"kind": {"const": "linear_dimension"}, "a": anchor, "b": anchor, "offset": {"type": "number"}}), &["a", "b", "offset"]),
                ViewAnnotationKind::TextNote { .. } => ("text_note", "Text note", "Free text at an anchor.", json!({"kind": {"const": "text_note"}, "position": anchor, "text": {"type": "string"}}), &["position", "text"]),
                ViewAnnotationKind::LeaderTag { .. } => ("leader_tag", "Leader tag", "Text with a leader line from head (the tagged object) to tail (the text).", json!({"kind": {"const": "leader_tag"}, "head": anchor, "tail": anchor, "text": {"type": "string"}}), &["head", "tail", "text"]),
            };
            let d = Descriptor::new(purpose).example(
                "use as the `annotation` of create_view_annotation",
                serde_json::to_value(kind).unwrap_or_default(),
            );
            let schema = json!({"type": "object", "properties": props, "required": req, "additionalProperties": false});
            PublishedDescriptor::new("annotation_type", id, name, &d, schema)
        })
        .collect()
}

/// Modelling conventions, published to agents.
pub fn conventions() -> Value {
    json!({
        "units": crate::descriptor::DEFAULT_UNITS,
        "axes": "Right-handed world with +Y up. Plans lie in the XZ plane: +X to the right, +Z down the screen in plan. A point is [x, y, z]; for plan placement pass y = 0 and the element sits on its level.",
        "levels": "Every element belongs to a level (storey). New elements go on the active level unless `level` is given. Walls, columns and stairs default their height to the rise to the next level; the top level uses 3 m.",
        "hosting": "Doors and windows are children of a wall (`parent`), slab openings of a slab. A child cuts its host and moves with it.",
        "joins": "Walls on one level join automatically where centreline end points meet (corners, T-junctions). Make wall end points coincide exactly.",
        "undo": "Each command is one undo step; `batch` is one step and all-or-nothing.",
        "ids": "Ids are UUID strings returned by create commands. Levels also accept their exact name.",
    })
}

/// Everything an agent can call or place, in one document.
pub fn api_catalog(project: &Project) -> Value {
    json!({
        "conventions": conventions(),
        "element_types": component_catalog(project),
        "commands": command_descriptors(),
        "queries": query_descriptors(),
        "annotation_types": annotation_descriptors(),
        "profiles": profile_catalog(project),
    })
}

/// Installed profiles (wall, column, beam sections) an element's `profile`
/// param can name. `instance_params` can be set per element; `type_values`
/// are shared by every element using the profile.
fn profile_catalog(project: &Project) -> Value {
    Value::Array(
        project
            .registry()
            .profiles()
            .values()
            .map(|p| {
                json!({
                    "id": p.id.to_string(),
                    "name": p.display_name,
                    "category": p.category,
                    "instance_params": p.instance_params().map(|s| s.id.to_string()).collect::<Vec<_>>(),
                    "type_params": p.params.iter().filter(|s| !s.binding.is_instance()).map(|s| s.id.to_string()).collect::<Vec<_>>(),
                    "type_values": p.type_values,
                })
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exec(p: &mut Project, v: Value) -> Value {
        let cmd: Command =
            serde_json::from_value(v.clone()).unwrap_or_else(|err| panic!("{v}: {err}"));
        p.execute(cmd).unwrap_or_else(|err| panic!("{v}: {err}"))
    }

    fn new_id(p: &mut Project, v: Value) -> String {
        exec(p, v)["id"].as_str().expect("id").to_string()
    }

    fn q(p: &Project, v: Value) -> Value {
        p.query(&serde_json::from_value(v).unwrap()).unwrap()
    }

    #[test]
    fn every_command_variant_is_described_and_examples_parse() {
        let described: std::collections::BTreeSet<String> =
            command_descriptors().into_iter().map(|d| d.id).collect();
        // One minimal instance per variant. `Command::op` is an exhaustive
        // match, so a new variant must be named there and added here.
        let samples = [
            json!({"op": "create_element", "component": "x", "points": []}),
            json!({"op": "update_element", "id": "x"}),
            json!({"op": "delete_element", "id": "x"}),
            json!({"op": "set_parent", "id": "x", "parent": null}),
            json!({"op": "move_elements", "ids": [], "delta": [0, 0, 0]}),
            json!({"op": "copy_elements", "ids": [], "delta": [0, 0, 0]}),
            json!({"op": "boolean", "a": "x", "b": "y"}),
            json!({"op": "set_slab_shape", "id": "x", "shape": {}}),
            json!({"op": "join_paths", "id": "x"}),
            json!({"op": "create_level", "name": "x", "elevation": 0}),
            json!({"op": "set_active_level", "id": "x"}),
            json!({"op": "set_level_elevation", "id": "x", "elevation": 0}),
            json!({"op": "create_grid_axis", "points": []}),
            json!({"op": "delete_grid_axis", "id": "x"}),
            json!({"op": "create_reference", "kind": "point", "points": []}),
            json!({"op": "delete_reference", "id": "x"}),
            json!({"op": "create_space", "points": []}),
            json!({"op": "update_space", "id": "x", "name": "y"}),
            json!({"op": "delete_space", "id": "x"}),
            json!({"op": "detect_rooms"}),
            json!({"op": "create_plan_view", "level": "x"}),
            json!({"op": "create_3d_view"}),
            json!({"op": "rename_view", "id": "x", "name": "y"}),
            json!({"op": "delete_view", "id": "x"}),
            json!({"op": "create_view_annotation", "view": "x", "annotation": {"kind": "text_note", "position": {"kind": "world", "point": [0, 0, 0]}, "text": "t"}}),
            json!({"op": "delete_view_annotation", "id": "x"}),
            json!({"op": "create_sheet", "number": "A1", "name": "x"}),
            json!({"op": "delete_sheet", "id": "x"}),
            json!({"op": "place_view_on_sheet", "sheet": "x", "view": "y"}),
            json!({"op": "undo"}),
            json!({"op": "redo"}),
            json!({"op": "batch", "commands": []}),
        ];
        assert_eq!(samples.len(), described.len());
        for s in samples {
            let cmd: Command =
                serde_json::from_value(s.clone()).unwrap_or_else(|e| panic!("{s}: {e}"));
            assert!(
                described.contains(cmd.op()),
                "{} has no descriptor",
                cmd.op()
            );
        }
        for d in command_descriptors() {
            assert!(!d.descriptor.purpose.is_empty());
            assert_eq!(d.params_schema["properties"]["op"]["const"], d.id.as_str());
            for ex in &d.descriptor.examples {
                let cmd: Command = serde_json::from_value(ex.input.clone())
                    .unwrap_or_else(|err| panic!("{} example: {err}", d.id));
                assert_eq!(cmd.op(), d.id);
            }
        }
        for d in query_descriptors() {
            let mut v = json!({"op": d.id});
            for key in d.params_schema["required"].as_array().unwrap() {
                let key = key.as_str().unwrap();
                if key != "op" {
                    v[key] = json!("svg");
                }
            }
            let parsed: Query = serde_json::from_value(v).unwrap();
            assert_eq!(parsed.op(), d.id);
        }
        for d in annotation_descriptors() {
            let kind: ViewAnnotationKind =
                serde_json::from_value(d.descriptor.examples[0].input.clone()).unwrap();
            assert!(!kind.category().is_empty());
        }
    }

    #[test]
    fn every_installed_element_type_publishes_descriptor_and_schema() {
        let p = Project::new();
        let cat = component_catalog(&p);
        assert!(cat.len() >= 14);
        for d in &cat {
            assert!(!d.descriptor.purpose.trim().is_empty(), "{}", d.id);
            assert_eq!(d.params_schema["type"], "object", "{}", d.id);
            assert!(d.descriptor.points.is_some(), "{}", d.id);
        }
        let all = api_catalog(&p);
        assert!(all["conventions"]["units"].is_string());
    }

    #[test]
    fn create_update_delete_each_one_undo_step() {
        let mut p = Project::new();
        let id = new_id(
            &mut p,
            json!({"op": "create_element", "component": "apex.wall", "points": [[0, 0, 0], [4, 0, 0]]}),
        );
        let g = q(&p, json!({"op": "element_geometry", "id": id}));
        assert_eq!(g["watertight"], true, "{g}");
        assert!(g["volume"].as_f64().unwrap() > 0.1);
        let t0 = g["bbox"]["size"][0].as_f64().unwrap();
        exec(
            &mut p,
            json!({"op": "update_element", "id": id, "points": [[0, 0, 0], [7, 0, 0]], "params": {"attach_top": true}}),
        );
        let t1 = q(&p, json!({"op": "element_geometry", "id": id}))["bbox"]["size"][0]
            .as_f64()
            .unwrap();
        assert!(t1 > t0 + 2.9, "{t0} -> {t1}");
        let err = p
            .execute_json(
                &json!({"op": "update_element", "id": id, "params": {"thickness": 0.4}})
                    .to_string(),
            )
            .unwrap_err();
        assert!(err.0.contains("type value of profile"), "{err}");
        exec(&mut p, json!({"op": "delete_element", "id": id}));
        assert_eq!(p.document().elements().count(), 0);
        exec(&mut p, json!({"op": "undo"}));
        assert_eq!(p.document().elements().count(), 1);
        exec(&mut p, json!({"op": "undo"}));
        let t = q(&p, json!({"op": "element_geometry", "id": id}))["bbox"]["size"][0]
            .as_f64()
            .unwrap();
        assert!((t - t0).abs() < 1e-4, "one undo reverts exactly one update");
        exec(&mut p, json!({"op": "undo"}));
        assert_eq!(p.document().elements().count(), 0);
        assert!(!p.can_undo());
        exec(&mut p, json!({"op": "redo"}));
        assert_eq!(p.document().elements().count(), 1);
    }

    #[test]
    fn batch_is_one_undo_step_and_all_or_nothing() {
        let mut p = Project::new();
        let levels = p.document().levels().count();
        exec(
            &mut p,
            json!({"op": "batch", "commands": [
                {"op": "create_level", "name": "L1", "elevation": 3.0},
                {"op": "create_element", "component": "apex.wall", "points": [[0, 0, 0], [4, 0, 0]], "level": "L1"},
                {"op": "create_element", "component": "apex.column", "points": [[1, 0, 1]]}
            ]}),
        );
        assert_eq!(p.document().elements().count(), 2);
        assert_eq!(p.document().levels().count(), levels + 1);
        exec(&mut p, json!({"op": "undo"}));
        assert_eq!(p.document().elements().count(), 0);
        assert_eq!(p.document().levels().count(), levels);
        assert!(!p.can_undo());

        let err = p
            .execute_json(
                r#"{"op": "batch", "commands": [
                {"op": "create_element", "component": "apex.column", "points": [[1, 0, 1]]},
                {"op": "create_element", "component": "nope", "points": [[0, 0, 0]]}
            ]}"#,
            )
            .unwrap_err();
        assert!(err.0.contains("batch step 1"), "{err}");
        assert_eq!(p.document().elements().count(), 0, "rolled back");
        assert!(!p.can_undo(), "failed batch records nothing");
    }

    #[test]
    fn batch_steps_reference_earlier_results() {
        let mut p = Project::new();
        let out = exec(
            &mut p,
            json!({"op": "batch", "commands": [
                {"op": "place_wall", "points": [[0, 0, 0], [6, 0, 0]], "params": {"height": 2.7}},
                {"op": "create_element", "component": "apex.door", "parent": "$0.id", "points": [[2, 0, 0]]},
                {"op": "place_window", "parent": "$0.id", "points": [[4.5, 0, 0]]},
                {"op": "place_column", "points": [[3, 0, 3]]},
                {"op": "boolean", "a": "$0.id", "b": "$3.id"}
            ]}),
        );
        let wall = out["results"][0]["id"].as_str().unwrap().to_string();
        let door = out["results"][1]["id"].as_str().unwrap();
        let el = q(&p, json!({"op": "get_element", "id": door}));
        assert_eq!(el["parent"], wall.as_str(), "{el}");
        let g = q(&p, json!({"op": "element_geometry", "id": wall}));
        assert_eq!(g["consumed_by_boolean"], out["results"][4]["id"], "{g}");
        exec(&mut p, json!({"op": "undo"}));
        assert_eq!(p.document().elements().count(), 0, "one undo step");

        let err = p
            .execute_json(
                &json!({"op": "batch", "commands": [
                    {"op": "create_element", "component": "apex.door", "parent": "$3.id", "points": [[0, 0, 0]]}
                ]})
                .to_string(),
            )
            .unwrap_err();
        assert!(err.0.contains("refers to step 3"), "{err}");
    }

    #[test]
    fn openings_need_a_host_and_walls_take_height() {
        let mut p = Project::new();
        let err = p
            .execute_json(
                r#"{"op": "create_element", "component": "apex.door", "points": [[1, 0, 0]]}"#,
            )
            .unwrap_err();
        assert!(err.0.contains("must be hosted"), "{err}");
        let col = new_id(
            &mut p,
            json!({"op": "create_element", "component": "apex.column", "points": [[1, 0, 1]]}),
        );
        let err = p
            .execute_json(&json!({"op": "create_element", "component": "apex.window", "parent": col, "points": [[1, 0, 1]]}).to_string())
            .unwrap_err();
        assert!(err.0.contains("needs a wall"), "{err}");
        let wall = new_id(
            &mut p,
            json!({"op": "create_element", "component": "apex.wall", "points": [[0, 0, 0], [4, 0, 0]], "params": {"height": 2.4}}),
        );
        let h = q(&p, json!({"op": "element_geometry", "id": wall}))["bbox"]["size"][1]
            .as_f64()
            .unwrap();
        assert!((h - 2.4).abs() < 1e-3, "height {h}");
        assert!(api_catalog(&p)["profiles"]
            .as_array()
            .unwrap()
            .iter()
            .any(|x| x["id"] == "apex.wall.rect"));
    }

    #[test]
    fn hosted_door_cuts_wall_and_boolean_validates() {
        let mut p = Project::new();
        let wall = new_id(
            &mut p,
            json!({"op": "create_element", "component": "apex.wall", "points": [[0, 0, 0], [6, 0, 0]]}),
        );
        let v0 = q(&p, json!({"op": "element_geometry", "id": wall}))["volume"]
            .as_f64()
            .unwrap();
        new_id(
            &mut p,
            json!({"op": "create_element", "component": "apex.door", "points": [[2, 0, 0]], "parent": wall}),
        );
        let g = q(&p, json!({"op": "element_geometry", "id": wall}));
        assert!(
            g["volume"].as_f64().unwrap() < v0 - 0.1,
            "door cuts the wall: {g}"
        );
        assert_eq!(g["watertight"], true);
        let a = new_id(
            &mut p,
            json!({"op": "create_element", "component": "apex.column", "points": [[10, 0, 0]]}),
        );
        let b = new_id(
            &mut p,
            json!({"op": "create_element", "component": "apex.column", "points": [[10.1, 0, 0]]}),
        );
        let bool_id = new_id(
            &mut p,
            json!({"op": "boolean", "a": a, "b": b, "operation": "union"}),
        );
        assert_eq!(
            q(&p, json!({"op": "element_geometry", "id": bool_id}))["has_mesh"],
            true
        );
        let v = q(&p, json!({"op": "validate"}));
        assert_eq!(v["ok"], true, "{v}");
    }

    #[test]
    fn levels_views_sheets_annotations_and_exports() {
        let mut p = Project::new();
        let l2 = new_id(
            &mut p,
            json!({"op": "create_level", "name": "Level 2", "elevation": 3.0}),
        );
        exec(
            &mut p,
            json!({"op": "set_level_elevation", "id": "Level 2", "elevation": 3.2}),
        );
        let levels = q(&p, json!({"op": "list_levels"}));
        assert!(levels.as_array().unwrap().iter().any(
            |l| l["id"] == l2.as_str() && (l["elevation"].as_f64().unwrap() - 3.2).abs() < 1e-5
        ));
        exec(
            &mut p,
            json!({"op": "create_element", "component": "apex.wall", "points": [[0, 0, 0], [6, 0, 0]], "level": l2}),
        );
        let on_l2 = q(&p, json!({"op": "list_elements", "level": "Level 2"}));
        assert_eq!(on_l2.as_array().unwrap().len(), 1);
        let view = new_id(
            &mut p,
            json!({"op": "create_plan_view", "level": "Level 2"}),
        );
        new_id(
            &mut p,
            json!({"op": "create_view_annotation", "view": view, "annotation": {"kind": "text_note", "position": {"kind": "world", "point": [1, 0, 1]}, "text": "Hall"}}),
        );
        let sheet = new_id(
            &mut p,
            json!({"op": "create_sheet", "number": "A-101", "name": "Plan"}),
        );
        exec(
            &mut p,
            json!({"op": "place_view_on_sheet", "sheet": sheet, "view": view}),
        );
        let svg = q(
            &p,
            json!({"op": "export_view", "id": view, "format": "svg"}),
        );
        let svg = svg["content"].as_str().unwrap();
        assert!(svg.starts_with("<svg") && svg.contains("<line"), "{svg}");
        let dxf = q(
            &p,
            json!({"op": "export_sheet", "id": sheet, "format": "dxf"}),
        );
        assert!(dxf["content"].as_str().unwrap().contains("SECTION"));
        let snap = q(&p, json!({"op": "export_project"}));
        let mut p2 = Project::new();
        p2.import_snapshot(serde_json::from_value(snap).unwrap())
            .unwrap();
        assert_eq!(p2.document().elements().count(), 1);
    }

    #[test]
    fn closed_wall_loop_repeating_first_point_is_valid() {
        let mut p = Project::new();
        let id = new_id(
            &mut p,
            json!({"op": "create_element", "component": "apex.wall", "points": [[0, 0, 0], [5, 0, 0], [5, 0, 4], [0, 0, 4], [0, 0, 0]], "placement_kind": "polyline"}),
        );
        let g = q(&p, json!({"op": "element_geometry", "id": id}));
        assert_eq!(g["watertight"], true, "{g}");
        assert_eq!(q(&p, json!({"op": "validate"}))["ok"], true);
    }

    #[test]
    fn errors_are_readable_and_leave_no_trace() {
        let mut p = Project::new();
        let err = p
            .execute_json(r#"{"op": "delete_element", "id": "zzz"}"#)
            .unwrap_err();
        assert!(err.0.contains("bad element id"), "{err}");
        let err = p.execute_json(r#"{"op": "teleport"}"#).unwrap_err();
        assert!(err.0.contains("invalid command"), "{err}");
        let err = p.execute_json(r#"{"op": "create_element", "component": "apex.wall", "points": [[0,0,0]], "bogus": 1}"#).unwrap_err();
        assert!(err.0.contains("bogus"), "{err}");
        assert!(!p.can_undo());
    }

    #[test]
    fn tee_joined_walls_validate_as_one_closed_mass() {
        let mut p = Project::new();
        let a = new_id(
            &mut p,
            json!({"op": "create_element", "component": "apex.wall", "points": [[0, 0, 0], [10, 0, 0]]}),
        );
        let b = new_id(
            &mut p,
            json!({"op": "create_element", "component": "apex.wall", "points": [[5, 0, 0], [5, 0, 8]]}),
        );
        for id in [&a, &b] {
            let g = q(&p, json!({"op": "element_geometry", "id": id}));
            assert_eq!(g["watertight"], true, "{g}");
        }
        let v = q(&p, json!({"op": "validate"}));
        assert_eq!(v["ok"], true, "{v}");
    }
}
