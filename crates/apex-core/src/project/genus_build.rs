//! Universal genus geometry in a project: hosted (frame from the host
//! curve) and free (point / line) placements, host cuts and neighbour cuts.

use apex_geometry::{BooleanOp, TriangleMesh};
use glam::Vec3;

use super::{project_onto_curve_xz, Project};
use crate::element::{Element, ElementId};
use crate::genus_body::{GenusBuild, GenusCut, GenusFrame};
use crate::placement::{Placement, PlacementKind};

/// Fallback host depth when it cannot be measured.
const DEFAULT_HOST_DEPTH: f64 = 0.2;

impl Project {
    /// The genus build of `element`, when its genus has a body. Hosted
    /// point elements build in the host curve's frame with the measured
    /// host depth; free ones in their own point / line frame.
    pub(crate) fn element_genus_build(&self, element: &Element) -> Option<GenusBuild> {
        let def = self.registry.get(&element.component_id)?;
        def.genus.as_ref()?;
        let (frame, host_depth, length) = match self.hosted_genus_frame(element) {
            Some((frame, depth)) => (frame, depth, 0.0),
            None => {
                if def.host_cut.is_some() && element.parent_id.is_some() {
                    // Hosted but not on a curve host: legacy path.
                    return None;
                }
                match &element.placement {
                    Placement::Point { origin, rotation } => (
                        GenusFrame::from_yaw(*origin, *rotation),
                        DEFAULT_HOST_DEPTH,
                        0.0,
                    ),
                    Placement::Curve { curve } => {
                        let (a, b) = (curve.start(), curve.end());
                        let u = Vec3::new(b.x - a.x, 0.0, b.z - a.z).try_normalize()?;
                        (
                            GenusFrame::along(a, u),
                            DEFAULT_HOST_DEPTH,
                            curve.length() as f64,
                        )
                    }
                    Placement::Free { .. } => return None,
                }
            }
        };
        self.registry
            .build_genus(
                &element.component_id,
                &element.params,
                frame,
                host_depth,
                length,
            )
            .ok()
    }

    /// Frame and host depth of a point genus hosted by a curve element.
    fn hosted_genus_frame(&self, element: &Element) -> Option<(GenusFrame, f64)> {
        let def = self.registry.get(&element.component_id)?;
        def.host_cut.as_ref()?;
        if def.placement != PlacementKind::Point {
            return None;
        }
        let host = self.document.get_element(element.parent_id?)?;
        let curve = host.placement.curve()?;
        let origin = element.placement.origin();
        let dir = crate::path_join::host_tangent_at(curve, origin)?;
        let u = Vec3::new(dir.x, 0.0, dir.z).try_normalize()?;
        let n = Vec3::new(-u.z, 0.0, u.x);
        let center = project_onto_curve_xz(curve, origin).unwrap_or(origin);
        let center = Vec3::new(center.x, origin.y, center.z);
        let params = self
            .registry
            .eval_params(&element.component_id, &element.params)
            .ok()?;
        let width = match &def.opening {
            Some(recipe) => recipe.extents(&params).0,
            None => params.number("width").unwrap_or(1.0),
        } as f32;
        // Host half thickness from the host mesh around the element.
        let mut half_t = 0.0_f32;
        if let Some(hm) = self.document.get_mesh(host.id) {
            for p in hm.positions.chunks(3) {
                let d = Vec3::new(p[0], p[1], p[2]) - center;
                if d.dot(u).abs() <= width.max(0.1) {
                    half_t = half_t.max(d.dot(n).abs());
                }
            }
        }
        if !(0.02..=1.0).contains(&half_t) {
            half_t = 0.1;
        }
        Some((GenusFrame::along(center, u), 2.0 * half_t as f64))
    }

    /// Host-targeted cuts of the genus children of `host` that accept the
    /// host's category, in stable child order.
    pub(crate) fn genus_host_cuts(&self, host: &Element) -> Vec<GenusCut> {
        let Some(host_def) = self.registry.get(&host.component_id) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for child_id in self.document.children_of(host.id) {
            let Some(child) = self.document.get_element(child_id) else {
                continue;
            };
            let Some(def) = self.registry.get(&child.component_id) else {
                continue;
            };
            if def.genus.is_none() {
                continue;
            }
            if let Some(cut) = &def.host_cut {
                if !cut.host_categories.iter().any(|c| c == &host_def.category) {
                    continue;
                }
            }
            if let Some(build) = self.element_genus_build(child) {
                out.extend(build.cuts.into_iter().filter(|c| c.targets.host));
            }
        }
        out
    }

    /// Whether `child` is a genus element whose host cuts come from its body.
    pub(crate) fn is_genus_child(&self, child: &Element) -> bool {
        self.registry
            .get(&child.component_id)
            .is_some_and(|d| d.genus.is_some() && d.placement != PlacementKind::Polyline)
    }

    /// Elements whose genus can cut neighbours, in stable order.
    fn neighbour_cutters(&self) -> Vec<&Element> {
        let mut out: Vec<&Element> = self
            .document
            .elements()
            .filter(|e| self.registry.cuts_neighbours(&e.component_id))
            .collect();
        out.sort_by_cached_key(|e| e.order_key());
        out
    }

    /// Neighbour cuts (from other elements' genera) that may hit `target`.
    fn neighbour_cuts_for(&self, target: &Element, aabb: ([f32; 3], [f32; 3])) -> Vec<GenusCut> {
        let Some(def) = self.registry.get(&target.component_id) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for cutter in self.neighbour_cutters() {
            if cutter.id == target.id || target.parent_id == Some(cutter.id) {
                continue;
            }
            let Some(build) = self.element_genus_build(cutter) else {
                continue;
            };
            for cut in build.cuts {
                if !cut.targets.neighbour_matches(&def.category) {
                    continue;
                }
                // The host of a hosted cutter gets its host cuts instead.
                if cutter.parent_id == Some(target.id) && cut.targets.host {
                    continue;
                }
                if cut.mesh.aabb().is_some_and(|b| overlaps(b, aabb)) {
                    out.push(cut);
                }
            }
        }
        out
    }

    /// Apply neighbour cuts to an element's finished mesh (exact booleans;
    /// a failed boolean leaves the mesh as it was).
    pub(crate) fn apply_neighbour_cuts(
        &self,
        target: &Element,
        mesh: TriangleMesh,
    ) -> TriangleMesh {
        let Some(aabb) = mesh.aabb() else {
            return mesh;
        };
        let cuts = self.neighbour_cuts_for(target, aabb);
        subtract_all(mesh, &cuts)
    }

    /// Elements a neighbour-cutting element may affect (overlapping AABB).
    pub(crate) fn neighbour_cut_dependents(&self, element: &Element) -> Vec<ElementId> {
        if !self.registry.cuts_neighbours(&element.component_id) {
            return Vec::new();
        }
        let Some(build) = self.element_genus_build(element) else {
            return Vec::new();
        };
        let boxes: Vec<_> = build
            .cuts
            .iter()
            .filter(|c| c.targets.neighbours.is_some())
            .filter_map(|c| c.mesh.aabb())
            .collect();
        self.document
            .elements()
            .filter(|e| e.id != element.id)
            .filter(|e| {
                self.document
                    .get_mesh(e.id)
                    .and_then(|m| m.aabb())
                    .is_some_and(|a| boxes.iter().any(|b| overlaps(*b, a)))
            })
            .map(|e| e.id)
            .collect()
    }
}

/// Subtract every cut mesh, keeping the mesh when a boolean fails.
pub(crate) fn subtract_all(mut mesh: TriangleMesh, cuts: &[GenusCut]) -> TriangleMesh {
    for cut in cuts {
        if let Ok(r) = crate::kroute::kbool(&mesh, &cut.mesh, BooleanOp::Subtract) {
            mesh = r;
        }
    }
    mesh
}

fn overlaps(a: ([f32; 3], [f32; 3]), b: ([f32; 3], [f32; 3])) -> bool {
    (0..3).all(|i| a.0[i] <= b.1[i] + 1e-4 && b.0[i] <= a.1[i] + 1e-4)
}

impl Project {
    /// Genera whose geometry depends on `id`: itself, genera extending it
    /// and genera nesting any of those (transitively).
    pub(crate) fn genera_depending_on(&self, id: &str) -> std::collections::BTreeSet<String> {
        let mut set = std::collections::BTreeSet::from([id.to_string()]);
        loop {
            let before = set.len();
            for def in self.registry.components() {
                let Some(g) = &self
                    .registry
                    .authored(&def.id)
                    .and_then(|d| d.genus.clone())
                else {
                    continue;
                };
                let hit = g.extends.as_deref().is_some_and(|p| set.contains(p))
                    || def
                        .genus
                        .as_ref()
                        .is_some_and(|f| f.nested_ids().iter().any(|n| set.contains(*n)));
                if hit {
                    set.insert(def.id.clone());
                }
            }
            if set.len() == before {
                return set;
            }
        }
    }

    /// Install or replace a genus and rebuild every element it affects
    /// (instances, instances of genera extending / nesting it, their hosts
    /// and cut neighbours). One undo step.
    pub fn upsert_genus(
        &mut self,
        definition: crate::component::ComponentDefinition,
    ) -> Result<Vec<ElementId>, crate::registry::RegistryError> {
        let before = self.export_snapshot();
        let id = definition.id.clone();
        self.registry.upsert(definition)?;
        let genera = self.genera_depending_on(&id);
        let ids: Vec<ElementId> = self
            .document
            .elements()
            .filter(|e| genera.contains(&e.component_id))
            .map(|e| e.id)
            .collect();
        for eid in &ids {
            if let Err(err) = self.update_element(*eid, None, None, false) {
                let history = std::mem::take(&mut self.history);
                let _ = self.restore_snapshot(before);
                self.history = history;
                return Err(err);
            }
        }
        self.history.record_before(before);
        Ok(ids)
    }

    /// Where each param of an element comes from: `instance`, `species`,
    /// `genus` (declared by the element's genus) or `inherited` (from an
    /// ancestor genus, named in `from`).
    pub fn param_provenance(
        &self,
        id: ElementId,
    ) -> Result<Vec<crate::registry::ParamProvenance>, crate::registry::RegistryError> {
        let e = self.document.get_element(id).ok_or_else(|| {
            crate::registry::RegistryError::Unknown(format!("unknown element {id}"))
        })?;
        self.registry.param_provenance(&e.component_id, &e.params)
    }
}

/// One param of a genus authored through the command API.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GenusParamInput {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// `length` (m, default), `number` or `text`.
    #[serde(default = "default_param_kind")]
    pub kind: String,
    pub default: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Option<f64>,
    /// Bound on the species (type) rather than per instance.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub species: bool,
}

fn default_param_kind() -> String {
    "length".into()
}

impl GenusParamInput {
    pub fn to_spec(&self) -> Result<crate::param::ParamSpec, String> {
        use crate::param::{ParamBinding, ParamSpec};
        let label = self.label.clone().unwrap_or_else(|| self.id.clone());
        let num = || {
            self.default
                .as_f64()
                .ok_or_else(|| format!("param '{}': default must be a number", self.id))
        };
        let mut spec = match self.kind.as_str() {
            "length" => ParamSpec::length(&self.id, &label, num()?),
            "number" => ParamSpec::number(&self.id, &label, num()?),
            "text" => ParamSpec::text(
                &self.id,
                &label,
                self.default
                    .as_str()
                    .ok_or_else(|| format!("param '{}': default must be a string", self.id))?,
            ),
            other => {
                return Err(format!(
                    "param '{}': unknown kind '{other}' (length, number, text)",
                    self.id
                ))
            }
        };
        if self.min.is_some() || self.max.is_some() || self.kind == "length" {
            // Lengths may be zero when a min is not given (offsets, sills).
            spec = spec.with_range(self.min.or(Some(0.0)), self.max);
        }
        if self.species {
            spec.binding = ParamBinding::Type;
        }
        Ok(spec)
    }
}

/// Build a user genus definition from command input. `placement` falls back
/// to the parent's when the genus `extends` one.
#[allow(clippy::too_many_arguments)]
pub(crate) fn genus_definition(
    registry: &crate::registry::ComponentRegistry,
    id: String,
    name: String,
    category: Option<String>,
    purpose: Option<String>,
    params: &[GenusParamInput],
    genus: crate::genus_body::GenusDef,
) -> Result<crate::component::ComponentDefinition, String> {
    use crate::component::{
        ComponentDefinition, ComponentSource, GeometryRecipe, PlacementOptions,
    };
    use crate::genus_body::GenusPlacement;
    use crate::placement::PlacementKind;
    if let Some(existing) = registry.get(&id) {
        if matches!(existing.source, ComponentSource::BuiltIn) {
            return Err(format!(
                "'{id}' is built in; create a new genus that extends it instead"
            ));
        }
    }
    let parent = match genus.extends.as_deref() {
        Some(p) => Some(
            registry
                .get(p)
                .ok_or_else(|| format!("extends unknown genus '{p}'"))?,
        ),
        None => None,
    };
    let placement = match genus.placement.as_ref() {
        Some(GenusPlacement::Point) => PlacementKind::Point,
        Some(GenusPlacement::Line) => PlacementKind::TwoPoint,
        Some(GenusPlacement::Host { .. }) => PlacementKind::Point,
        None => parent.map(|p| p.placement).unwrap_or(PlacementKind::Point),
    };
    let specs = params
        .iter()
        .map(GenusParamInput::to_spec)
        .collect::<Result<Vec<_>, _>>()?;
    let category = category
        .or_else(|| parent.map(|p| p.category.clone()))
        .unwrap_or_else(|| "generic".into());
    Ok(ComponentDefinition {
        id,
        display_name: name.clone(),
        category,
        source: ComponentSource::Visual,
        placement,
        placement_options: PlacementOptions::default(),
        params: specs,
        recipe: GeometryRecipe::Group { steps: vec![] },
        descriptor: crate::descriptor::Descriptor::new(
            purpose.unwrap_or_else(|| format!("User genus '{name}'.")),
        ),
        host_cut: None,
        level_height_params: vec![],
        ifc_entity: None,
        joinable: false,
        opening: None,
        default_species: None,
        genus: Some(genus),
    })
}

impl Project {
    /// The authored definition of a user (non built-in) genus, for editing.
    pub(crate) fn user_genus(
        &self,
        id: &str,
    ) -> Result<crate::component::ComponentDefinition, super::commands::CommandError> {
        let def = self
            .registry
            .authored(id)
            .ok_or_else(|| super::commands::CommandError(format!("unknown genus '{id}'")))?;
        if matches!(def.source, crate::component::ComponentSource::BuiltIn) {
            return Err(super::commands::CommandError(format!(
                "'{id}' is built in; define a genus that extends it and edit that"
            )));
        }
        Ok(def.clone())
    }
}
