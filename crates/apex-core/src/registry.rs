//! The component registry, plus the built-in components.
//!
//! Every built-in is registered through [`ComponentRegistry::register`], the
//! same entry point a module or the visual editor uses. If a built-in needed a
//! private back door, the architecture would not be extensible.

use std::collections::BTreeMap;

use apex_geometry::{Frame, Justification, TriangleMesh};
use thiserror::Error;

use crate::builders::{pitched_roof, stair_run};
use crate::component::{
    evaluate_recipe, ComponentDefinition, ComponentSource, DefinitionError, FrameSource,
    GeometryRecipe, HostCutSpec, MeshBuilder, PlacementOptions, ProfileLibrary, ProfileSpec,
    ProfileType, RecipeContext, RecipeError,
};
use crate::descriptor::Descriptor;
use crate::element::{ComponentId, Element};
use crate::expr::Expr;
use serde_json::json;

/// Param holding a slab's sub-element shape.
pub(crate) const SLAB_SHAPE: &str = "shape";
use crate::genus::{
    build_opening, OpeningGenerator, OpeningGeometry, OpeningInfill, OpeningPlanSymbol,
    OpeningRecipe, Species, SPECIES_PARAM,
};
use crate::genus_body::{
    build_genus, check_nesting, BuildInput, GenusBuild, GenusDef, GenusEntry, GenusError,
    GenusFrame, GenusPlacement, GenusSource, OpeningPartKind, MAX_NESTING, OPENING_FRAME_GENUS,
    OPENING_INFILL_GENUS,
};
use crate::param::{ParamError, ParamKind, ParamMap, ParamSpec, ParamValue};
use crate::placement::{Placement, PlacementKind};
use crate::reference::{Reference, ReferenceFilter};

#[derive(Debug, Clone, PartialEq, Error)]
pub enum RegistryError {
    #[error(transparent)]
    Definition(#[from] DefinitionError),
    #[error("component '{0}' is already registered")]
    Duplicate(ComponentId),
    #[error("unknown component '{0}'")]
    Unknown(ComponentId),
    /// A document-level refusal that is not a component lookup: a missing
    /// element id, a cycle in the parent chain, and so on. Separate from
    /// `Unknown` so the message is not read as a component problem.
    #[error("{0}")]
    Document(String),
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
    #[error(transparent)]
    Genus(#[from] GenusError),
}

/// Where a param value of an element comes from (shown in the UI).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct ParamProvenance {
    pub id: String,
    pub value: ParamValue,
    /// `instance`, `species`, `genus` or `inherited`.
    pub source: &'static str,
    /// Species id, or the genus id that declared / last overrode the default.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
}

/// Everything the document needs to turn elements into geometry.
#[derive(Default)]
pub struct ComponentRegistry {
    components: BTreeMap<ComponentId, ComponentDefinition>,
    profiles: ProfileLibrary,
    builders: BTreeMap<String, Box<dyn MeshBuilder>>,
    species: BTreeMap<String, Species>,
    opening_generators: BTreeMap<String, (Descriptor, Box<dyn OpeningGenerator>)>,
    /// Genera as authored (before `extends` was flattened), by id.
    authored: BTreeMap<ComponentId, ComponentDefinition>,
    /// Genus id that declared / last overrode each param default.
    param_origin: BTreeMap<ComponentId, BTreeMap<String, String>>,
}

impl ComponentRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// A registry preloaded with the shipped components.
    pub fn with_builtins() -> Self {
        let mut registry = Self::new();
        registry.register_builder("apex.stair.run", Box::new(stair_run));
        registry.register_builder("apex.roof.pitched", Box::new(pitched_roof));
        // Booleans are meshed by the project from their operands.
        registry.register_builder("apex.boolean", Box::new(empty_builder));
        for profile in builtin_profiles() {
            registry
                .upsert_profile(profile)
                .expect("built-in profiles must be valid");
        }
        for definition in builtin_components() {
            registry
                .register(definition)
                .expect("built-in components must be valid");
        }
        for species in builtin_species() {
            registry
                .upsert_species(species)
                .expect("built-in species must be valid");
        }
        registry
    }

    // ---- Species -------------------------------------------------

    /// Type-bound param ids of a genus (what a [`Species`] holds).
    pub fn type_param_ids(&self, genus: &str) -> Vec<String> {
        self.get(genus)
            .map(|d| {
                d.params
                    .iter()
                    .filter(|p| p.binding.is_type())
                    .map(|p| p.id.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Whether the component is a typed genus (has a default type).
    pub fn is_genus(&self, component_id: &str) -> bool {
        self.get(component_id)
            .and_then(|d| d.default_species.as_deref())
            .is_some_and(|t| self.species.contains_key(t))
    }

    pub fn species(&self, id: &str) -> Option<&Species> {
        self.species.get(id)
    }

    /// All types, or only those of `genus`.
    pub fn species_list(&self, genus: Option<&str>) -> Vec<&Species> {
        self.species
            .values()
            .filter(|t| genus.is_none_or(|f| t.genus == f))
            .collect()
    }

    /// Add or replace a type. Values are resolved against the genus's
    /// type-bound specs (missing keys take spec defaults, unknown keys fail).
    pub fn upsert_species(&mut self, mut species: Species) -> Result<(), RegistryError> {
        if species.id.trim().is_empty() {
            return Err(RegistryError::Unknown("species id is empty".into()));
        }
        let def = self.require(&species.genus)?;
        let specs: Vec<ParamSpec> = def
            .params
            .iter()
            .filter(|p| p.binding.is_type())
            .cloned()
            .collect();
        if specs.is_empty() {
            return Err(RegistryError::Unknown(format!(
                "{} has no type parameters",
                species.genus
            )));
        }
        species.values = species.values.resolve(&specs)?;
        if species.name.trim().is_empty() {
            species.name = species.id.clone();
        }
        self.species.insert(species.id.clone(), species);
        Ok(())
    }

    /// Move a pre-rename `type` key (PR #114 files, old agent calls) to
    /// `species` on params of a genus instance.
    pub fn normalize_species_key(&self, component_id: &str, params: &mut ParamMap) {
        if !self.is_genus(component_id) || params.get(SPECIES_PARAM).is_some() {
            return;
        }
        if let Some(v) = params.remove(crate::genus::LEGACY_SPECIES_PARAM) {
            params.set(SPECIES_PARAM, v);
        }
    }

    pub fn remove_species(&mut self, id: &str) -> Option<Species> {
        self.species.remove(id)
    }

    /// Pick the type an instance should use given raw input `patch` and its
    /// `current` type. Type-bound keys in `patch` that differ from the
    /// chosen type select an existing type with exactly those values, or
    /// derive (and register) a new one, so `params: {width: 1.0}` keeps
    /// working for agents and old projects.
    pub fn resolve_instance_type(
        &mut self,
        component_id: &str,
        current: Option<&str>,
        patch: &ParamMap,
    ) -> Option<String> {
        if !self.is_genus(component_id) {
            return None;
        }
        let def = self.get(component_id)?;
        let fallback = def.default_species.clone()?;
        let display = def.display_name.clone();
        let belongs = |id: &str| {
            self.species
                .get(id)
                .is_some_and(|t| t.genus == component_id)
        };
        let candidate = patch
            .text(SPECIES_PARAM)
            .filter(|t| belongs(t))
            .or(current.filter(|t| belongs(t)))
            .map(str::to_string)
            .unwrap_or(fallback);
        let base = self.species.get(&candidate)?.clone();
        let type_ids = self.type_param_ids(component_id);
        let mut target = base.values.clone();
        let mut changed = false;
        for key in &type_ids {
            if let Some(v) = patch.get(key) {
                if !value_eq(base.values.get(key), Some(v)) {
                    target.set(key.clone(), v.clone());
                    changed = true;
                }
            }
        }
        if !changed {
            return Some(candidate);
        }
        let specs: Vec<ParamSpec> = self
            .get(component_id)?
            .params
            .iter()
            .filter(|p| p.binding.is_type())
            .cloned()
            .collect();
        let target = target.resolve(&specs).ok()?;
        if let Some(t) = self.species.values().find(|t| {
            t.genus == component_id
                && type_ids
                    .iter()
                    .all(|k| value_eq(t.values.get(k), target.get(k)))
        }) {
            return Some(t.id.clone());
        }
        let mm = |k: &str| (target.number(k).unwrap_or(0.0) * 1000.0).round() as i64;
        let stem = format!("{component_id}.t-{}x{}", mm("width"), mm("height"));
        let mut id = stem.clone();
        let mut i = 2;
        while self.species.contains_key(&id) {
            id = format!("{stem}-{i}");
            i += 1;
        }
        let name = format!("{display} {}×{} ({})", mm("width"), mm("height"), base.name);
        self.upsert_species(Species {
            id: id.clone(),
            genus: component_id.to_string(),
            name,
            values: target,
        })
        .ok()?;
        Some(id)
    }

    /// Raw params overlaid on their species's values (read-only; no
    /// type is derived). Non-genera return `raw` unchanged.
    pub fn typed_params(&self, component_id: &str, raw: &ParamMap) -> ParamMap {
        let Some(def) = self.get(component_id) else {
            return raw.clone();
        };
        let type_id = raw
            .text(SPECIES_PARAM)
            .map(str::to_string)
            .or_else(|| def.default_species.clone());
        match type_id
            .and_then(|t| self.species.get(&t))
            .filter(|t| t.genus == component_id)
        {
            Some(t) => t.values.merged(raw),
            None => raw.clone(),
        }
    }

    /// Write the type id and its values into instance params.
    pub fn apply_type_values(&self, type_id: &str, params: &mut ParamMap) {
        if let Some(t) = self.species.get(type_id) {
            params.set(SPECIES_PARAM, ParamValue::Text(type_id.to_string()));
            for (k, v) in t.values.iter() {
                params.set(k.clone(), v.clone());
            }
        }
    }

    // ---- Opening generators (plugin hook) -----------------------------

    /// Register a plugin opening generator; recipes select it via `generator`.
    pub fn register_opening_generator(
        &mut self,
        id: impl Into<String>,
        descriptor: Descriptor,
        generator: Box<dyn OpeningGenerator>,
    ) -> Result<(), RegistryError> {
        let id = id.into();
        if descriptor.is_missing() {
            return Err(RegistryError::Definition(
                DefinitionError::MissingDescriptor { component: id },
            ));
        }
        self.opening_generators.insert(id, (descriptor, generator));
        Ok(())
    }

    pub fn opening_generator_descriptors(&self) -> Vec<(String, Descriptor)> {
        self.opening_generators
            .iter()
            .map(|(k, (d, _))| (k.clone(), d.clone()))
            .collect()
    }

    /// Geometry for an opening recipe: the plugin generator when named (and
    /// registered), otherwise the built-in builder.
    pub fn opening_geometry(
        &self,
        recipe: &OpeningRecipe,
        params: &ParamMap,
        wall_depth: f64,
    ) -> Result<OpeningGeometry, String> {
        if let Some(id) = &recipe.generator {
            let (_, generator) = self
                .opening_generators
                .get(id)
                .ok_or_else(|| format!("unknown opening generator '{id}'"))?;
            return generator.generate(params, wall_depth);
        }
        Ok(build_opening(recipe, params, wall_depth))
    }

    /// Add a component. Validation happens here so an authoring mistake is
    /// reported when the component is installed, not when someone places it.
    pub fn register(&mut self, definition: ComponentDefinition) -> Result<(), RegistryError> {
        if self.components.contains_key(&definition.id) {
            return Err(RegistryError::Duplicate(definition.id));
        }
        self.install(definition)
    }

    /// Flatten inheritance, adapt legacy opening-only genera, validate,
    /// insert, and check nesting. Rolls back on failure.
    fn install(&mut self, authored: ComponentDefinition) -> Result<(), RegistryError> {
        let id = authored.id.clone();
        let (flat, origins) = self.flatten(&authored)?;
        flat.validate()?;
        let prev = (
            self.components.insert(id.clone(), flat),
            self.authored.insert(id.clone(), authored),
            self.param_origin.insert(id.clone(), origins),
        );
        let nesting = if self.components[&id].genus.is_some() {
            check_nesting(self, &id)
        } else {
            Ok(())
        };
        if let Err(e) = nesting {
            fn restore<V>(m: &mut BTreeMap<String, V>, id: &str, v: Option<V>) {
                match v {
                    Some(v) => {
                        m.insert(id.to_string(), v);
                    }
                    None => {
                        m.remove(id);
                    }
                }
            }
            restore(&mut self.components, &id, prev.0);
            restore(&mut self.authored, &id, prev.1);
            restore(&mut self.param_origin, &id, prev.2);
            return Err(e.into());
        }
        // Re-flatten genera that extend this one (and theirs).
        let children: Vec<ComponentDefinition> = self
            .authored
            .values()
            .filter(|d| d.genus.as_ref().and_then(|g| g.extends.as_deref()) == Some(id.as_str()))
            .cloned()
            .collect();
        for child in children {
            self.install(child)?;
        }
        Ok(())
    }

    /// Resolve `extends` (cycle-checked) into a self-contained definition
    /// plus the provenance of each param default.
    fn flatten(
        &self,
        authored: &ComponentDefinition,
    ) -> Result<(ComponentDefinition, BTreeMap<String, String>), RegistryError> {
        let mut def = authored.clone();
        // Legacy: an opening recipe without a body gets the shared opening
        // body (nested frame + infill, host cut).
        if def.opening.is_some() && def.genus.is_none() {
            let cats = def
                .host_cut
                .as_ref()
                .map(|h| h.host_categories.clone())
                .unwrap_or_else(|| vec!["wall".into()]);
            def.genus = Some(GenusDef::opening_body(cats));
        }
        let mut origins: BTreeMap<String, String> = def
            .params
            .iter()
            .map(|p| (p.id.clone(), def.id.clone()))
            .collect();
        if let Some(parent_id) = def.genus.as_ref().and_then(|g| g.extends.clone()) {
            // Cycle check along the authored chain.
            let mut chain = vec![def.id.clone()];
            let mut cur = Some(parent_id.clone());
            while let Some(c) = cur {
                if chain.contains(&c) {
                    chain.push(c);
                    return Err(GenusError::Cycle(chain.join(" → ")).into());
                }
                chain.push(c.clone());
                cur = self
                    .authored
                    .get(&c)
                    .or_else(|| self.components.get(&c))
                    .and_then(|d| d.genus.as_ref())
                    .and_then(|g| g.extends.clone());
            }
            let parent = self
                .components
                .get(&parent_id)
                .ok_or_else(|| GenusError::Unknown(parent_id.clone()))?;
            let parent_genus = parent.genus.clone().unwrap_or_default();
            let parent_origin = self.param_origin.get(&parent_id);
            let mut params = parent.params.clone();
            let mut merged_origin: BTreeMap<String, String> = params
                .iter()
                .map(|p| {
                    let from = parent_origin
                        .and_then(|o| o.get(&p.id))
                        .cloned()
                        .unwrap_or_else(|| parent_id.clone());
                    (p.id.clone(), from)
                })
                .collect();
            for spec in &def.params {
                match params.iter_mut().find(|p| p.id == spec.id) {
                    Some(slot) => *slot = spec.clone(),
                    None => params.push(spec.clone()),
                }
                merged_origin.insert(spec.id.clone(), def.id.clone());
            }
            origins = merged_origin;
            def.params = params;
            def.genus = Some(def.genus.as_ref().unwrap().merged_over(&parent_genus));
            if def.opening.is_none() {
                def.opening = parent.opening.clone();
            }
            if def.host_cut.is_none() {
                def.host_cut = parent.host_cut.clone();
            }
            if def.default_species.is_none() && def.opening.is_some() {
                def.default_species = None;
            }
        }
        // Placement kind: host placement implies a host_cut category filter.
        if let Some(g) = def.genus.as_mut() {
            match (&g.placement, &def.host_cut) {
                (Some(GenusPlacement::Host { categories }), None) => {
                    def.host_cut = Some(HostCutSpec {
                        host_categories: categories.clone(),
                    });
                }
                (None, Some(h)) => {
                    g.placement = Some(GenusPlacement::Host {
                        categories: h.host_categories.clone(),
                    });
                }
                (Some(GenusPlacement::Line), _) if def.placement == PlacementKind::Point => {
                    def.placement = PlacementKind::TwoPoint;
                }
                _ => {}
            }
        }
        Ok((def, origins))
    }

    /// Definitions as authored (inheritance not flattened), for saving.
    pub fn authored_components(&self) -> impl Iterator<Item = &ComponentDefinition> {
        self.components
            .values()
            .map(|d| self.authored.get(&d.id).unwrap_or(d))
    }

    /// The genus definition as authored (before `extends` was flattened).
    pub fn authored(&self, id: &str) -> Option<&ComponentDefinition> {
        self.authored.get(id).or_else(|| self.components.get(id))
    }

    /// Where each param value of an instance of `component_id` comes from.
    pub fn param_provenance(
        &self,
        component_id: &str,
        raw: &ParamMap,
    ) -> Result<Vec<ParamProvenance>, RegistryError> {
        let def = self.require(component_id)?;
        let resolved = def.resolve_params(raw)?;
        let species = raw
            .text(SPECIES_PARAM)
            .map(str::to_string)
            .or_else(|| def.default_species.clone())
            .and_then(|t| self.species.get(&t))
            .filter(|t| t.genus == component_id);
        let origins = self.param_origin.get(component_id);
        let mut out = Vec::new();
        for spec in &def.params {
            let Some(value) = resolved.get(&spec.id).cloned() else {
                continue;
            };
            let declared = origins
                .and_then(|o| o.get(&spec.id))
                .cloned()
                .unwrap_or_else(|| component_id.to_string());
            let from_species = species.and_then(|t| t.values.get(&spec.id));
            let (source, from) = if spec.id == SPECIES_PARAM {
                ("instance", None)
            } else if let Some(sv) = from_species.filter(|_| spec.binding.is_type()) {
                if value_eq(Some(sv), Some(&value)) {
                    ("species", species.map(|t| t.id.clone()))
                } else {
                    ("instance", None)
                }
            } else if raw.get(&spec.id).is_some() && !value_eq(Some(&spec.default), Some(&value)) {
                ("instance", None)
            } else if declared == component_id {
                ("genus", Some(declared))
            } else {
                ("inherited", Some(declared))
            };
            out.push(ParamProvenance {
                id: spec.id.clone(),
                value,
                source,
                from,
            });
        }
        Ok(out)
    }

    /// Build a genus's geometry in `frame` (no host / neighbour context).
    pub fn build_genus(
        &self,
        component_id: &str,
        raw: &ParamMap,
        frame: GenusFrame,
        host_depth: f64,
        length: f64,
    ) -> Result<GenusBuild, RegistryError> {
        let params = self.eval_params(component_id, raw)?;
        Ok(build_genus(
            self,
            &BuildInput {
                genus_id: component_id,
                params: &params,
                frame,
                host_depth,
                length,
            },
        )?)
    }

    /// Whether any element of this genus can cut neighbours.
    pub fn cuts_neighbours(&self, component_id: &str) -> bool {
        fn walk(r: &ComponentRegistry, id: &str, depth: usize) -> bool {
            let Some(g) = r.get(id).and_then(|d| d.genus.as_ref()) else {
                return false;
            };
            depth < MAX_NESTING
                && (g.has_cuts(|t| t.neighbours.is_some())
                    || g.nested_ids().iter().any(|c| walk(r, c, depth + 1)))
        }
        walk(self, component_id, 0)
    }

    /// Add or replace a component, for reloading a module during development.
    pub fn upsert(&mut self, mut definition: ComponentDefinition) -> Result<(), RegistryError> {
        let id = definition.id.clone();
        // Validate the flattened form up front (the authored one may rely
        // on inherited params).
        self.flatten(&definition)?.0.validate()?;
        // An opening genus needs at least one type: seed `<id>.default`
        // from the type-bound param defaults when none exists yet.
        let needs_type = definition.opening.is_some()
            && definition
                .default_species
                .as_deref()
                .is_none_or(|t| self.species.get(t).is_none_or(|ft| ft.genus != id));
        if needs_type {
            let existing = self.species_list(Some(&id)).first().map(|t| t.id.clone());
            definition.default_species = Some(existing.unwrap_or_else(|| format!("{id}.default")));
        }
        let seed = definition
            .default_species
            .clone()
            .filter(|t| needs_type && !self.species.contains_key(t));
        let name = definition.display_name.clone();
        self.install(definition)?;
        if let Some(type_id) = seed {
            self.upsert_species(Species {
                id: type_id,
                genus: id,
                name,
                values: ParamMap::new(),
            })?;
        }
        Ok(())
    }

    pub fn upsert_profile(&mut self, mut profile: ProfileType) -> Result<(), RegistryError> {
        profile.compile_sketch()?;
        profile.validate()?;
        self.profiles.insert(profile.id.clone(), profile);
        Ok(())
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

    pub fn profile(&self, id: &str) -> Option<&ProfileType> {
        self.profiles.get(id)
    }

    pub fn require_profile(&self, id: &str) -> Result<&ProfileType, RegistryError> {
        self.profile(id)
            .ok_or_else(|| RegistryError::Recipe(RecipeError::UnknownProfile(id.to_string())))
    }

    pub fn components(&self) -> impl Iterator<Item = &ComponentDefinition> {
        self.components.values()
    }

    pub fn profiles(&self) -> &ProfileLibrary {
        &self.profiles
    }

    pub fn profiles_in_category<'a>(
        &'a self,
        category: &'a str,
    ) -> impl Iterator<Item = &'a ProfileType> + 'a {
        self.profiles
            .values()
            .filter(move |profile| profile.category == category || profile.category.is_empty())
    }

    pub fn len(&self) -> usize {
        self.components.len()
    }

    pub fn is_empty(&self) -> bool {
        self.components.is_empty()
    }

    /// Profile id stored on this element, after applying component defaults.
    pub fn element_profile_id(&self, element: &Element) -> Option<String> {
        let definition = self.get(&element.component_id)?;
        let resolved = definition.resolve_params(&element.params).ok()?;
        definition
            .profile_param_id()
            .and_then(|id| resolved.text(id).map(|text| text.to_string()))
    }

    /// Parameters that belong on the element: component fields plus instance profile fields.
    pub fn persistable_params(
        &self,
        component_id: &str,
        raw: &ParamMap,
    ) -> Result<ParamMap, RegistryError> {
        let definition = self.require(component_id)?;
        let component_params = definition.resolve_params(raw)?;
        let mut specs = definition.params.clone();
        if let Some(profile_id) = definition
            .profile_param_id()
            .and_then(|id| component_params.text(id).map(|text| text.to_string()))
        {
            if let Some(profile) = self.profiles.get(&profile_id) {
                specs.extend(profile.instance_params().cloned());
            }
        }
        Ok(raw.resolve(&specs)?)
    }

    /// Merge component params, profile type values, and profile instance values.
    pub fn eval_params(
        &self,
        component_id: &str,
        raw: &ParamMap,
    ) -> Result<ParamMap, RegistryError> {
        let definition = self.require(component_id)?;
        let component_params = definition.resolve_params(raw)?;
        let Some(param_id) = definition.profile_param_id() else {
            return Ok(component_params);
        };
        let Some(profile_id) = component_params.text(param_id) else {
            return Ok(component_params);
        };
        let profile = self.require_profile(profile_id)?;
        let merged = profile.merge_eval_params(raw)?;
        Ok(merged.merged(&component_params))
    }

    /// Evaluate a profile spec to a 2D outline, for the profile editor preview.
    pub fn preview_profile(
        &self,
        spec: &ProfileSpec,
        params: &ParamMap,
    ) -> Result<apex_geometry::Profile, RegistryError> {
        Ok(spec.evaluate(params, &self.profiles)?)
    }

    /// Patch type-level values on a profile. Callers must rebuild dependents.
    pub fn update_profile_type_values(
        &mut self,
        id: &str,
        patch: &ParamMap,
    ) -> Result<(), RegistryError> {
        let profile = self
            .profiles
            .get_mut(id)
            .ok_or_else(|| RegistryError::Recipe(RecipeError::UnknownProfile(id.to_string())))?;
        let type_specs: Vec<_> = profile.type_params().cloned().collect();
        let merged = profile.type_values.merged(patch);
        profile.type_values = merged.resolve(&type_specs)?;
        Ok(())
    }

    /// Whether this element's resolved params name the given reference id.
    pub fn element_uses_reference(&self, element: &Element, ref_id: &str) -> bool {
        let Ok(params) = self.eval_params(&element.component_id, &element.params) else {
            return false;
        };
        let Some(definition) = self.get(&element.component_id) else {
            return false;
        };
        for spec in &definition.params {
            if matches!(spec.kind, ParamKind::Reference { .. })
                && params.text(&spec.id) == Some(ref_id)
            {
                return true;
            }
        }
        false
    }

    pub fn references_for_filter<'a>(
        references: impl Iterator<Item = &'a Reference>,
        filter: ReferenceFilter,
    ) -> Vec<String> {
        references
            .filter(|reference| reference.accepts_filter(filter))
            .map(|reference| reference.id.to_string())
            .collect()
    }

    /// Build the mesh for a placement plus a raw parameter set.
    pub fn build_mesh<'a>(
        &self,
        component_id: &str,
        placement: &Placement,
        raw_params: &ParamMap,
        work_plane: Frame,
        references: impl IntoIterator<Item = &'a Reference>,
    ) -> Result<TriangleMesh, RegistryError> {
        self.eval_mesh(
            component_id,
            placement,
            raw_params,
            work_plane,
            references,
            0.0,
            0.0,
        )
    }

    /// Build the mesh for an existing element (includes path-join extensions).
    pub fn build_element_mesh<'a>(
        &self,
        element: &Element,
        work_plane: Frame,
        references: impl IntoIterator<Item = &'a Reference>,
    ) -> Result<TriangleMesh, RegistryError> {
        self.eval_mesh(
            &element.component_id,
            &element.placement,
            &element.params,
            work_plane,
            references,
            element.join_start,
            element.join_end,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn eval_mesh<'a>(
        &self,
        component_id: &str,
        placement: &Placement,
        raw_params: &ParamMap,
        work_plane: Frame,
        references: impl IntoIterator<Item = &'a Reference>,
        path_join_start: f32,
        path_join_end: f32,
    ) -> Result<TriangleMesh, RegistryError> {
        let definition = self.require(component_id)?;
        if !definition.placement.accepts(placement) {
            return Err(RegistryError::PlacementMismatch {
                component: definition.id.clone(),
                expected: definition.placement.as_str(),
                actual: placement.family(),
            });
        }

        let params = self.eval_params(component_id, raw_params)?;
        let reference_library = references
            .into_iter()
            .map(|reference| (reference.id, reference.clone()))
            .collect();
        let ctx = RecipeContext {
            placement,
            params: &params,
            work_plane,
            profiles: &self.profiles,
            references: &reference_library,
            path_join_start,
            path_join_end,
        };
        Ok(evaluate_recipe(&definition.recipe, &ctx, &self.builders)?)
    }

    /// Merge params for a definition that may not be registered yet (editor preview).
    pub fn eval_params_for_definition(
        &self,
        definition: &ComponentDefinition,
        raw: &ParamMap,
    ) -> Result<ParamMap, RegistryError> {
        let component_params = definition.resolve_params(raw)?;
        let Some(param_id) = definition.profile_param_id() else {
            return Ok(component_params);
        };
        let Some(profile_id) = component_params.text(param_id) else {
            return Ok(component_params);
        };
        let profile = self.require_profile(profile_id)?;
        let merged = profile.merge_eval_params(raw)?;
        Ok(merged.merged(&component_params))
    }

    /// Build mesh for an arbitrary definition without registering it (visual editor preview).
    pub fn preview_definition_mesh<'a>(
        &self,
        definition: &ComponentDefinition,
        placement: &Placement,
        raw_params: &ParamMap,
        work_plane: Frame,
        references: impl IntoIterator<Item = &'a Reference>,
    ) -> Result<TriangleMesh, RegistryError> {
        definition.validate()?;
        if !definition.placement.accepts(placement) {
            return Err(RegistryError::PlacementMismatch {
                component: definition.id.clone(),
                expected: definition.placement.as_str(),
                actual: placement.family(),
            });
        }
        let params = self.eval_params_for_definition(definition, raw_params)?;
        let reference_library = references
            .into_iter()
            .map(|reference| (reference.id, reference.clone()))
            .collect();
        let ctx = RecipeContext {
            placement,
            params: &params,
            work_plane,
            profiles: &self.profiles,
            references: &reference_library,
            path_join_start: 0.0,
            path_join_end: 0.0,
        };
        Ok(evaluate_recipe(&definition.recipe, &ctx, &self.builders)?)
    }
}

/// Profiles every project starts with. Type vs instance lives here, not on the component.
fn builtin_profiles() -> Vec<ProfileType> {
    vec![
        ProfileType {
            id: "apex.rect".into(),
            display_name: "Rectangle".into(),
            category: "column".into(),
            params: vec![
                ParamSpec::length("width", "Width", 0.4).as_type(),
                ParamSpec::length("depth", "Depth", 0.4).as_type(),
            ],
            spec: ProfileSpec::Rectangle {
                width: Expr::param("width"),
                height: Expr::param("depth"),
            },
            type_values: ParamMap::new(),
            formulas: Default::default(),
            sketch: None,
        },
        ProfileType {
            id: "apex.round".into(),
            display_name: "Round".into(),
            category: "column".into(),
            params: vec![ParamSpec::length("width", "Width", 0.4).as_type()],
            spec: ProfileSpec::Circle {
                radius: Expr::param("width") / Expr::constant(2.0),
                segments: 24,
            },
            type_values: ParamMap::new(),
            formulas: Default::default(),
            sketch: None,
        },
        ProfileType {
            id: "apex.wall.rect".into(),
            display_name: "Rectangle".into(),
            category: "wall".into(),
            params: vec![
                ParamSpec::length("thickness", "Thickness", 0.2).as_type(),
                ParamSpec::length("height", "Height", 3.0),
            ],
            spec: ProfileSpec::Rectangle {
                width: Expr::param("thickness"),
                height: Expr::param("height"),
            },
            type_values: ParamMap::new(),
            formulas: Default::default(),
            sketch: None,
        },
        ProfileType {
            id: "apex.wall.round".into(),
            display_name: "Round".into(),
            category: "wall".into(),
            params: vec![ParamSpec::length("thickness", "Thickness", 0.2).as_type()],
            spec: ProfileSpec::Circle {
                radius: Expr::param("thickness") / Expr::constant(2.0),
                segments: 24,
            },
            type_values: ParamMap::new(),
            formulas: Default::default(),
            sketch: None,
        },
        ProfileType {
            id: "apex.beam.rect".into(),
            display_name: "Rectangle".into(),
            category: "beam".into(),
            params: vec![
                ParamSpec::length("width", "Width", 0.2).as_type(),
                ParamSpec::length("depth", "Depth", 0.4).as_type(),
            ],
            spec: ProfileSpec::Rectangle {
                width: Expr::param("width"),
                height: Expr::param("depth"),
            },
            type_values: ParamMap::new(),
            formulas: Default::default(),
            sketch: None,
        },
        ProfileType {
            id: "apex.pipe.round".into(),
            display_name: "Round pipe".into(),
            category: "mep.pipe".into(),
            params: vec![
                ParamSpec::length("diameter", "Diameter", 0.1).as_type(),
                ParamSpec::length("wall", "Wall", 0.003).as_type(),
            ],
            spec: ProfileSpec::HollowCircle {
                radius: Expr::param("diameter") / Expr::constant(2.0),
                wall: Expr::param("wall"),
                segments: 24,
            },
            type_values: ParamMap::new(),
            formulas: Default::default(),
            sketch: None,
        },
        ProfileType {
            id: "apex.duct.rect".into(),
            display_name: "Rectangular duct".into(),
            category: "mep.duct".into(),
            params: vec![
                ParamSpec::length("width", "Width", 0.4).as_type(),
                ParamSpec::length("height", "Height", 0.25).as_type(),
                ParamSpec::length("wall", "Wall", 0.01).as_type(),
            ],
            spec: ProfileSpec::HollowRectangle {
                width: Expr::param("width"),
                height: Expr::param("height"),
                wall: Expr::param("wall"),
            },
            type_values: ParamMap::new(),
            formulas: Default::default(),
            sketch: None,
        },
        ProfileType {
            id: "apex.tray.rect".into(),
            display_name: "Cable tray".into(),
            category: "mep.tray".into(),
            params: vec![
                ParamSpec::length("width", "Width", 0.3).as_type(),
                ParamSpec::length("height", "Height", 0.08).as_type(),
            ],
            spec: ProfileSpec::Rectangle {
                width: Expr::param("width"),
                height: Expr::param("height"),
            },
            type_values: ParamMap::new(),
            formulas: Default::default(),
            sketch: None,
        },
    ]
}

/// The shipped components, expressed purely as data.
///
/// There is no wall-specific, column-specific or beam-specific geometry code
/// anywhere: each is a profile plus a sweep or an extrude. Variants of a type
/// (rectangular vs round column, straight vs arc wall) are a parameter or a
/// draw mode, not a second type. Stairs/roof use registered Custom builders
/// the same way a module would.
impl GenusSource for ComponentRegistry {
    fn genus_entry(&self, id: &str) -> Option<GenusEntry<'_>> {
        let def = self.components.get(id)?;
        Some(GenusEntry {
            def,
            genus: def.genus.as_ref()?,
        })
    }

    fn opening_parts(
        &self,
        recipe: &OpeningRecipe,
        params: &ParamMap,
        host_depth: f64,
    ) -> Result<OpeningGeometry, String> {
        self.opening_geometry(recipe, params, host_depth)
    }

    fn species_values(&self, genus: &str, species: &str) -> Option<ParamMap> {
        self.species
            .get(species)
            .filter(|t| t.genus == genus)
            .map(|t| t.values.clone())
    }
}

pub fn builtin_components() -> Vec<ComponentDefinition> {
    vec![
        opening_part_genus(OPENING_FRAME_GENUS, "Opening frame", OpeningPartKind::Frame),
        opening_part_genus(
            OPENING_INFILL_GENUS,
            "Opening infill",
            OpeningPartKind::Infill,
        ),
        wall(),
        column(),
        beam(),
        slab(),
        door(),
        window(),
        slab_opening(),
        stair(),
        roof_flat(),
        roof_pitched(),
        pipe(),
        duct(),
        cable_tray(),
        boolean(),
    ]
}

/// A wall is a profile swept along a path, seated on the level.
///
/// Line, arc and polyline are draw modes of one tool; rectangle vs round is
/// the `profile` parameter, the same pattern as column.
fn wall() -> ComponentDefinition {
    ComponentDefinition {
        opening: None,
        default_species: None,
        genus: None,
        id: "apex.wall".to_string(),
        display_name: "Wall".to_string(),
        category: "wall".to_string(),
        source: ComponentSource::BuiltIn,
        placement: PlacementKind::Path,
        placement_options: PlacementOptions::default(),
        params: vec![
            ParamSpec::profile("profile", "Profile", "apex.wall.rect", &[]),
            ParamSpec::flag("allow_join_start", "Join at start", true),
            ParamSpec::flag("allow_join_end", "Join at end", true),
            ParamSpec::flag("attach_top", "Attach top", false),
            ParamSpec::text("attach_top_to", "Top targets", ""),
            ParamSpec::flag("attach_base", "Attach base", false),
            ParamSpec::text("attach_base_to", "Base targets", ""),
        ],
        recipe: GeometryRecipe::Sweep {
            profile: ProfileSpec::FromParam {
                param: "profile".into(),
            },
            justification: Justification::BaseCenter,
            start_offset: Expr::zero(),
            end_offset: Expr::zero(),
        },
        descriptor: Descriptor::new("Vertical wall: a profile swept along a centreline on the level. Height follows the storey rise; corners and T-junctions with other walls on the level join automatically (thicker wall wins).")
            .points("path: 2+ plan points [x, y, z] along the centreline (y = level elevation, may be 0). placement_kind 'polyline' for a chain, 'three_point_arc' for an arc (start, mid, end). Closing a loop: repeat the first point at the end.")
            .constraint("points must not repeat consecutively; segments shorter than 1 mm are refused")
            .constraint("attach_top=true clips/raises the wall top to the underside of its targets: attach_top_to = comma-separated roof/slab ids, empty = every roof above it (lowest underside wins). attach_base=true seats the base on the top of the attach_base_to slabs/roofs. Prefer the attach_top / attach_base / detach tools.")
            .example("A 10 m straight wall", json!({"component": "apex.wall", "points": [[0, 0, 0], [10, 0, 0]], "placement_kind": "polyline"})),
        host_cut: None,
        level_height_params: vec!["height".into()],
        ifc_entity: Some("IfcWall".into()),
        joinable: true,
    }
}

/// A column is one type. Rectangle vs round is the `profile` parameter, which
/// is what `ProfileSpec::FromParam` is for: one tool, swappable section.
fn column() -> ComponentDefinition {
    ComponentDefinition {
        opening: None,
        default_species: None,
        genus: None,
        id: "apex.column".to_string(),
        display_name: "Column".to_string(),
        category: "column".to_string(),
        source: ComponentSource::BuiltIn,
        placement: PlacementKind::Point,
        placement_options: PlacementOptions::default(),
        params: vec![
            ParamSpec::profile("profile", "Profile", "apex.rect", &[]),
            ParamSpec::length("height", "Height", 3.0),
            ParamSpec::reference("frame_ref", "Frame reference", ReferenceFilter::Point, &[]),
            ParamSpec::flag("attach_top", "Attach top", false),
            ParamSpec::text("attach_top_to", "Top targets", ""),
            ParamSpec::flag("attach_base", "Attach base", false),
            ParamSpec::text("attach_base_to", "Base targets", ""),
        ],
        recipe: GeometryRecipe::Extrude {
            profile: ProfileSpec::FromParam {
                param: "profile".into(),
            },
            frame: FrameSource::RefParam {
                param: "frame_ref".into(),
                t: Expr::zero(),
            },
            height: Expr::param("height"),
        },
        descriptor: Descriptor::new("Vertical column: a profile (rectangular or round, chosen by the `profile` param) extruded upward from a point on the level.")
            .points("point: one plan point [x, y, z] for the column axis")
            .constraint("attach_top / attach_base work like on walls (see apex.wall)")
            .example("Round column", json!({"component": "apex.column", "points": [[2, 0, 2]], "params": {"profile": "apex.round"}})),
        host_cut: None,
        level_height_params: vec!["height".into()],
        ifc_entity: Some("IfcColumn".into()),
        joinable: false,
    }
}

/// A beam is the same sweep as a wall, hung below its line instead of sitting on it.
fn beam() -> ComponentDefinition {
    ComponentDefinition {
        opening: None,
        default_species: None,
        genus: None,
        id: "apex.beam".to_string(),
        display_name: "Beam".to_string(),
        category: "beam".to_string(),
        source: ComponentSource::BuiltIn,
        placement: PlacementKind::TwoPoint,
        placement_options: PlacementOptions::default(),
        params: vec![ParamSpec::profile(
            "profile",
            "Profile",
            "apex.beam.rect",
            &[],
        )],
        recipe: GeometryRecipe::Sweep {
            profile: ProfileSpec::FromParam {
                param: "profile".into(),
            },
            justification: Justification::TopCenter,
            start_offset: Expr::zero(),
            end_offset: Expr::zero(),
        },
        descriptor: Descriptor::new("Horizontal beam: a profile swept between two points, hung below the line (top-centre justified).")
            .points("two_point: start and end [x, y, z]; y is the top of the beam")
            .example("Beam at 3 m", json!({"component": "apex.beam", "points": [[0, 3, 0], [5, 3, 0]]})),
        host_cut: None,
        level_height_params: vec![],
        ifc_entity: Some("IfcBeam".into()),
        joinable: true,
    }
}

/// A floor slab / перекрытие: a closed polyline on the level, extruded for thickness.
fn slab() -> ComponentDefinition {
    ComponentDefinition {
        opening: None,
        default_species: None,
        genus: None,
        id: "apex.slab".to_string(),
        display_name: "Slab".to_string(),
        category: "slab".to_string(),
        source: ComponentSource::BuiltIn,
        placement: PlacementKind::Polyline,
        placement_options: PlacementOptions::closed_boundary(),
        params: vec![
            ParamSpec::length("thickness", "Thickness", 0.2),
            // Sub-element shape (JSON, see `project::slab_shape`); empty = flat.
            ParamSpec::text(SLAB_SHAPE, "Shape", ""),
        ],
        recipe: GeometryRecipe::Extrude {
            profile: ProfileSpec::FromPlacement,
            frame: FrameSource::WorkPlane,
            height: Expr::param("thickness"),
        },
        descriptor: Descriptor::new("Floor slab: a closed plan boundary extruded downward-or-up by `thickness` on the level. Supports a sub-element shape (per-vertex heights, extra points, crease lines) for slopes and ramps via the set_slab_shape command.")
            .points("polyline: 3+ boundary points, closed automatically (do not repeat the first point)")
            .constraint("boundary must be simple (non self-intersecting)")
            .example("8 x 10 m floor", json!({"component": "apex.slab", "points": [[0, 0, 0], [10, 0, 0], [10, 0, 8], [0, 0, 8]]})),
        host_cut: None,
        level_height_params: vec![],
        ifc_entity: Some("IfcSlab".into()),
        joinable: false,
    }
}

fn empty_builder(_: &RecipeContext<'_>) -> Result<TriangleMesh, RecipeError> {
    Ok(TriangleMesh::empty())
}

fn boolean() -> ComponentDefinition {
    ComponentDefinition {
        opening: None,
        default_species: None,
        genus: None,
        id: "apex.boolean".to_string(),
        display_name: "Boolean".to_string(),
        category: "modifier".to_string(),
        source: ComponentSource::BuiltIn,
        placement: PlacementKind::Point,
        placement_options: PlacementOptions::default(),
        params: vec![
            ParamSpec::text("operand_a", "Solid A", ""),
            ParamSpec::text("operand_b", "Solid B", ""),
            ParamSpec::choice(
                "operation",
                "Operation",
                &["subtract", "union", "intersect"],
                "subtract",
            ),
            ParamSpec::flag("show_operands", "Show operands", false),
        ],
        recipe: GeometryRecipe::Custom {
            builder_id: "apex.boolean".into(),
        },
        descriptor: Descriptor::new("Parametric boolean solid: combines two existing solid elements (operand_a, operand_b are element ids) with subtract (A - B), union or intersect. Operands are hidden unless show_operands is true; editing an operand updates the result.")
            .points("point: one dummy point, e.g. [0, 0, 0]")
            .constraint("operand_a and operand_b must be different, existing, watertight solid elements")
            .example("Subtract a column from a wall", json!({"component": "apex.boolean", "points": [[0, 0, 0]], "params": {"operand_a": "<wall-id>", "operand_b": "<column-id>", "operation": "subtract"}})),
        host_cut: None,
        level_height_params: vec![],
        ifc_entity: Some("IfcBooleanResult".into()),
        joinable: false,
    }
}

fn value_eq(a: Option<&ParamValue>, b: Option<&ParamValue>) -> bool {
    match (a, b) {
        (Some(a), Some(b)) => match (a.as_number(), b.as_number()) {
            (Some(x), Some(y)) => (x - y).abs() < 1e-6,
            _ => a == b,
        },
        (None, None) => true,
        _ => false,
    }
}

/// Shared type params of the built-in opening genera.
fn opening_type_specs(width: f64, height: f64, sash: f64) -> Vec<ParamSpec> {
    vec![
        ParamSpec::length("width", "Width", width).as_type(),
        ParamSpec::length("height", "Height", height).as_type(),
        ParamSpec::length("thickness", "Leaf thickness", 0.05).as_type(),
        ParamSpec::length("frame_width", "Frame width", 0.06).as_type(),
        ParamSpec::number("columns", "Columns (sashes / leaves)", 1.0)
            .with_range(Some(1.0), Some(12.0))
            .as_type(),
        ParamSpec::number("rows", "Rows", 1.0)
            .with_range(Some(1.0), Some(12.0))
            .as_type(),
        ParamSpec::length("mullion_width", "Mullion / transom width", 0.06).as_type(),
        ParamSpec::length("transom_height", "Transom height (0 = even rows)", 0.0)
            .with_range(Some(0.0), None)
            .as_type(),
        ParamSpec::length("sash_width", "Sash width (0 = fixed)", sash)
            .with_range(Some(0.0), None)
            .as_type(),
        ParamSpec::number("bars_x", "Vertical glazing bars", 0.0)
            .with_range(Some(0.0), Some(20.0))
            .as_type(),
        ParamSpec::number("bars_y", "Horizontal glazing bars", 0.0)
            .with_range(Some(0.0), Some(20.0))
            .as_type(),
        ParamSpec::length("arch_rise", "Arch rise (0 = flat head)", 0.0)
            .with_range(Some(0.0), None)
            .as_type(),
    ]
}

fn opening_recipe(door: bool) -> OpeningRecipe {
    OpeningRecipe {
        arch_rise: Expr::param("arch_rise"),
        frame_width: Expr::param("frame_width"),
        threshold: !door,
        columns: Expr::param("columns"),
        rows: Expr::param("rows"),
        mullion_width: Expr::param("mullion_width"),
        transom_height: Expr::param("transom_height"),
        infill: if door {
            OpeningInfill::Leaf
        } else {
            OpeningInfill::Glass
        },
        sash_width: Expr::param("sash_width"),
        bars_x: Expr::param("bars_x"),
        bars_y: Expr::param("bars_y"),
        leaf_thickness: Expr::param("thickness"),
        plan_symbol: if door {
            OpeningPlanSymbol::Swing
        } else {
            OpeningPlanSymbol::Window
        },
        ..OpeningRecipe::default()
    }
}

fn species(genus: &str, id: &str, name: &str, values: &[(&str, f64)]) -> Species {
    let mut map = ParamMap::new();
    for (k, v) in values {
        let value = if matches!(*k, "columns" | "rows" | "bars_x" | "bars_y") {
            ParamValue::Number(*v)
        } else {
            ParamValue::Length(*v)
        };
        map.set(*k, value);
    }
    Species {
        id: id.into(),
        genus: genus.into(),
        name: name.into(),
        values: map,
    }
}

/// Shipped window and door types.
pub fn builtin_species() -> Vec<Species> {
    vec![
        species(
            "apex.window",
            "apex.window.single-1200x1400",
            "Window 1200×1400 single sash",
            &[],
        ),
        species(
            "apex.window",
            "apex.window.double-1500x1400",
            "Window 1500×1400 two sashes + mullion",
            &[("width", 1.5), ("columns", 2.0), ("mullion_width", 0.08)],
        ),
        species(
            "apex.window",
            "apex.window.arched-900x1600",
            "Window 900×1600 arched, glazing bars",
            &[
                ("width", 0.9),
                ("height", 1.6),
                ("arch_rise", 0.45),
                ("bars_x", 1.0),
                ("bars_y", 2.0),
            ],
        ),
        species(
            "apex.door",
            "apex.door.single-900x2100",
            "Door 900×2100 single leaf",
            &[],
        ),
        species(
            "apex.door",
            "apex.door.double-1400x2100",
            "Door 1400×2100 double leaf",
            &[("width", 1.4), ("columns", 2.0), ("mullion_width", 0.01)],
        ),
        species(
            "apex.door",
            "apex.door.transom-1000x2500",
            "Door 1000×2500 with glazed transom",
            &[
                ("width", 1.0),
                ("height", 2.5),
                ("rows", 2.0),
                ("transom_height", 2.1),
            ],
        ),
    ]
}

fn door() -> ComponentDefinition {
    ComponentDefinition {
        opening: Some(opening_recipe(true)),
        default_species: Some("apex.door.single-900x2100".into()),
        genus: Some(GenusDef::opening_body(vec!["wall".into()])),
        id: "apex.door".to_string(),
        display_name: "Door".to_string(),
        category: "opening".to_string(),
        source: ComponentSource::BuiltIn,
        placement: PlacementKind::Point,
        placement_options: PlacementOptions::default(),
        params: vec![
            ParamSpec::text(SPECIES_PARAM, "Species", "apex.door.single-900x2100"),
            ParamSpec::length("sill", "Sill", 0.0).with_range(Some(0.0), None),
        ]
        .into_iter()
        .chain(opening_type_specs(0.9, 2.1, 0.0))
        .collect(),
        recipe: GeometryRecipe::Extrude {
            profile: ProfileSpec::Rectangle {
                width: Expr::param("width"),
                height: Expr::param("thickness"),
            },
            frame: FrameSource::PlacementCurve { t: Expr::zero() },
            height: Expr::param("height"),
        },
        descriptor: Descriptor::new("Door hosted in a wall: cuts a real opening (with reveals) through its parent wall and shows a leaf and plan swing symbol.")
            .points("point: one point on the host wall's centreline; pass `parent` = the wall id")
            .constraint("must have a parent whose category is 'wall'; the point is projected onto the wall")
            .example("Door 2 m along a wall", json!({"component": "apex.door", "points": [[2, 0, 0]], "parent": "<wall-id>"})),
        host_cut: Some(HostCutSpec {
            host_categories: vec!["wall".into()],
        }),
        level_height_params: vec![],
        ifc_entity: Some("IfcDoor".into()),
        joinable: false,
    }
}

fn window() -> ComponentDefinition {
    ComponentDefinition {
        opening: Some(opening_recipe(false)),
        default_species: Some("apex.window.single-1200x1400".into()),
        genus: Some(GenusDef::opening_body(vec!["wall".into()])),
        id: "apex.window".to_string(),
        display_name: "Window".to_string(),
        category: "opening".to_string(),
        source: ComponentSource::BuiltIn,
        placement: PlacementKind::Point,
        placement_options: PlacementOptions::default(),
        params: vec![
            ParamSpec::text(SPECIES_PARAM, "Species", "apex.window.single-1200x1400"),
            ParamSpec::length("sill", "Sill", 0.9).with_range(Some(0.0), None),
        ]
        .into_iter()
        .chain(opening_type_specs(1.2, 1.4, 0.04))
        .collect(),
        recipe: GeometryRecipe::Extrude {
            profile: ProfileSpec::Rectangle {
                width: Expr::param("width"),
                height: Expr::param("thickness"),
            },
            frame: FrameSource::PlacementCurve { t: Expr::zero() },
            height: Expr::param("height"),
        },
        descriptor: Descriptor::new("Window hosted in a wall: cuts an opening at `sill` height with frame and glass.")
            .points("point: one point on the host wall's centreline; pass `parent` = the wall id")
            .constraint("must have a parent whose category is 'wall'")
            .example("Window", json!({"component": "apex.window", "points": [[5, 0, 0]], "parent": "<wall-id>", "params": {"sill": 0.9}})),
        host_cut: Some(HostCutSpec {
            host_categories: vec!["wall".into()],
        }),
        level_height_params: vec![],
        ifc_entity: Some("IfcWindow".into()),
        joinable: false,
    }
}

/// Nested genus emitting one part of the opening recipe in scope (frame,
/// or sash / glass / leaf). Windows and doors nest both.
fn opening_part_genus(id: &str, name: &str, part: OpeningPartKind) -> ComponentDefinition {
    ComponentDefinition {
        opening: None,
        default_species: None,
        genus: Some(GenusDef::opening_part(part)),
        id: id.to_string(),
        display_name: name.to_string(),
        category: "genus-part".to_string(),
        source: ComponentSource::BuiltIn,
        placement: PlacementKind::Point,
        placement_options: PlacementOptions::default(),
        params: vec![ParamSpec::length("sill", "Sill", 0.0).with_range(Some(0.0), None)]
            .into_iter()
            .chain(opening_type_specs(1.2, 1.4, 0.04))
            .collect(),
        recipe: GeometryRecipe::Extrude {
            profile: ProfileSpec::Rectangle {
                width: Expr::param("width"),
                height: Expr::param("thickness"),
            },
            frame: FrameSource::PlacementCurve { t: Expr::zero() },
            height: Expr::param("height"),
        },
        descriptor: Descriptor::new("Nested part genus used inside window/door genera: emits the frame or the infill (sash, glass, leaf) of the opening recipe in scope. Not placed on its own.")
            .constraint("only meaningful nested in a genus that carries an `opening` recipe"),
        host_cut: None,
        level_height_params: vec![],
        ifc_entity: None,
        joinable: false,
    }
}

fn slab_opening() -> ComponentDefinition {
    ComponentDefinition {
        opening: None,
        default_species: None,
        genus: None,
        id: "apex.slab_opening".to_string(),
        display_name: "Slab opening".to_string(),
        category: "opening".to_string(),
        source: ComponentSource::BuiltIn,
        placement: PlacementKind::Polyline,
        placement_options: PlacementOptions::closed_boundary(),
        params: vec![ParamSpec::length("depth", "Depth", 0.5)],
        recipe: GeometryRecipe::Extrude {
            profile: ProfileSpec::FromPlacement,
            frame: FrameSource::WorkPlane,
            height: Expr::param("depth"),
        },
        descriptor: Descriptor::new(
            "Opening in a slab (shaft, stair well): a closed boundary that cuts its parent slab.",
        )
        .points("polyline: 3+ boundary points; pass `parent` = the slab id")
        .constraint("parent must be a slab"),
        host_cut: Some(HostCutSpec {
            host_categories: vec!["slab".into()],
        }),
        level_height_params: vec![],
        ifc_entity: Some("IfcOpeningElement".into()),
        joinable: false,
    }
}

fn stair() -> ComponentDefinition {
    ComponentDefinition {
        opening: None,
        default_species: None,
        genus: None,
        id: "apex.stair".to_string(),
        display_name: "Stair".to_string(),
        category: "stair".to_string(),
        source: ComponentSource::BuiltIn,
        placement: PlacementKind::TwoPoint,
        placement_options: PlacementOptions::default(),
        params: vec![
            ParamSpec::length("width", "Width", 1.0),
            ParamSpec::length("riser", "Riser", 0.17),
            ParamSpec::length("tread", "Tread", 0.28),
            // Base level → top level: seeded from the storey rise so a new
            // stair lands on the next level up.
            ParamSpec::length("height", "Height to top level", 0.0).with_range(Some(0.0), None),
        ],
        recipe: GeometryRecipe::Custom {
            builder_id: "apex.stair.run".into(),
        },
        descriptor: Descriptor::new("Straight stair run from the level up `height` (defaults to the storey rise). Automatically cuts a well in the slab above.")
            .points("two_point: bottom-start and run-direction end [x, y, z]")
            .example("Stair along z", json!({"component": "apex.stair", "points": [[1, 0, 1.5], [1, 0, 6]]})),
        host_cut: None,
        level_height_params: vec!["height".into()],
        ifc_entity: Some("IfcStair".into()),
        joinable: false,
    }
}

fn roof_flat() -> ComponentDefinition {
    ComponentDefinition {
        opening: None,
        default_species: None,
        genus: None,
        id: "apex.roof".to_string(),
        display_name: "Roof".to_string(),
        category: "roof".to_string(),
        source: ComponentSource::BuiltIn,
        placement: PlacementKind::Polyline,
        placement_options: PlacementOptions::closed_boundary(),
        params: vec![
            ParamSpec::length("thickness", "Thickness", 0.2),
            // Sub-element shape (JSON, see `project::slab_shape`); empty = flat.
            ParamSpec::text(SLAB_SHAPE, "Shape", ""),
        ],
        recipe: GeometryRecipe::Extrude {
            profile: ProfileSpec::FromPlacement,
            frame: FrameSource::WorkPlane,
            height: Expr::param("thickness"),
        },
        descriptor: Descriptor::new("Flat roof: a closed boundary extruded by `thickness`; sloped via set_slab_shape like a slab.")
            .points("polyline: 3+ boundary points"),
        host_cut: None,
        level_height_params: vec![],
        ifc_entity: Some("IfcRoof".into()),
        joinable: false,
    }
}

fn roof_pitched() -> ComponentDefinition {
    ComponentDefinition {
        opening: None,
        default_species: None,
        genus: None,
        id: "apex.roof.pitched".to_string(),
        display_name: "Pitched roof".to_string(),
        category: "roof".to_string(),
        source: ComponentSource::BuiltIn,
        placement: PlacementKind::TwoPoint,
        placement_options: PlacementOptions::default(),
        params: vec![
            ParamSpec::choice("roof_type", "Roof type", &["gable", "hip"], "gable"),
            ParamSpec::length("width", "Width", 8.0),
            ParamSpec::choice("slope_by", "Slope by", &["rise", "angle"], "rise"),
            ParamSpec::length("rise", "Rise", 1.8),
            ParamSpec::angle("pitch", "Pitch", 30f64.to_radians()),
            ParamSpec::length("thickness", "Thickness", 0.15),
            ParamSpec::length("overhang", "Overhang", 0.0).with_range(Some(0.0), None),
            ParamSpec::choice(
                "eave_cut",
                "Eave cut",
                &["vertical", "horizontal", "perpendicular"],
                "vertical",
            ),
            // Eave height above the level: new roofs are seeded from the storey rise so the
            // roof sits on top of the walls; 0 keeps older documents unchanged.
            ParamSpec::length("base_offset", "Eave elevation offset", 0.0).with_range(None, None),
        ],
        recipe: GeometryRecipe::Custom {
            builder_id: "apex.roof.pitched".into(),
        },
        descriptor: Descriptor::new("Pitched roof (gable or hip) as one watertight solid over a rectangle: the two points give the centre line from one end wall to the other, `width` is the size across it, slope by rise or angle, optional overhang on all sides and eave cut. Seated at the storey rise so it sits on the walls.")
            .points("two_point: centre line [x, y, z] (plan) from end wall to end wall; the covered rectangle is |b - a| x width, plus overhang")
            .constraint("for a hip roof the real ridge is shorter than the line by `width` (hips slope in from both ends); for a gable it is the full line")
            .constraint("an L-shaped plan needs two roofs, one per rectangle, overlapping at the corner")
            .example("Gable along x", json!({"component": "apex.roof.pitched", "points": [[0, 0, 4], [10, 0, 4]], "params": {"width": 8, "overhang": 0.5}})),
        host_cut: None,
        level_height_params: vec!["base_offset".into()],
        ifc_entity: Some("IfcRoof".into()),
        joinable: false,
    }
}

fn pipe() -> ComponentDefinition {
    ComponentDefinition {
        opening: None,
        default_species: None,
        genus: None,
        id: "apex.pipe".to_string(),
        display_name: "Pipe".to_string(),
        category: "mep.pipe".to_string(),
        source: ComponentSource::BuiltIn,
        placement: PlacementKind::Path,
        placement_options: PlacementOptions::free_elevation(),
        params: vec![
            ParamSpec::profile("profile", "Profile", "apex.pipe.round", &[]),
            ParamSpec::text("system", "System", "P-1"),
        ],
        recipe: GeometryRecipe::Sweep {
            profile: ProfileSpec::FromParam {
                param: "profile".into(),
            },
            justification: Justification::Center,
            start_offset: Expr::zero(),
            end_offset: Expr::zero(),
        },
        descriptor: Descriptor::new(
            "MEP pipe: round profile swept along a 3D path at a free elevation.",
        )
        .points("path: 2+ points [x, y, z]; y is the centreline elevation"),
        host_cut: None,
        level_height_params: vec![],
        ifc_entity: Some("IfcFlowSegment".into()),
        joinable: false,
    }
}

fn duct() -> ComponentDefinition {
    ComponentDefinition {
        opening: None,
        default_species: None,
        genus: None,
        id: "apex.duct".to_string(),
        display_name: "Duct".to_string(),
        category: "mep.duct".to_string(),
        source: ComponentSource::BuiltIn,
        placement: PlacementKind::Path,
        placement_options: PlacementOptions::free_elevation(),
        params: vec![
            ParamSpec::profile("profile", "Profile", "apex.duct.rect", &[]),
            ParamSpec::text("system", "System", "S-1"),
        ],
        recipe: GeometryRecipe::Sweep {
            profile: ProfileSpec::FromParam {
                param: "profile".into(),
            },
            justification: Justification::Center,
            start_offset: Expr::zero(),
            end_offset: Expr::zero(),
        },
        descriptor: Descriptor::new("MEP duct: rectangular profile swept along a 3D path.")
            .points("path: 2+ points [x, y, z]"),
        host_cut: None,
        level_height_params: vec![],
        ifc_entity: Some("IfcFlowSegment".into()),
        joinable: false,
    }
}

fn cable_tray() -> ComponentDefinition {
    ComponentDefinition {
        opening: None,
        default_species: None,
        genus: None,
        id: "apex.cable_tray".to_string(),
        display_name: "Cable tray".to_string(),
        category: "mep.tray".to_string(),
        source: ComponentSource::BuiltIn,
        placement: PlacementKind::Path,
        placement_options: PlacementOptions::free_elevation(),
        params: vec![
            ParamSpec::profile("profile", "Profile", "apex.tray.rect", &[]),
            ParamSpec::text("system", "System", "E-1"),
        ],
        recipe: GeometryRecipe::Sweep {
            profile: ProfileSpec::FromParam {
                param: "profile".into(),
            },
            justification: Justification::Center,
            start_offset: Expr::zero(),
            end_offset: Expr::zero(),
        },
        descriptor: Descriptor::new("Cable tray swept along a 3D path.")
            .points("path: 2+ points [x, y, z]"),
        host_cut: None,
        level_height_params: vec![],
        ifc_entity: Some("IfcCableCarrierSegment".into()),
        joinable: false,
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
        assert_eq!(registry.len(), builtin_components().len());
        for id in ["apex.wall", "apex.column", "apex.beam", "apex.slab"] {
            let def = registry.get(id).unwrap_or_else(|| panic!("missing {id}"));
            assert_eq!(def.source, ComponentSource::BuiltIn);
            assert!(def.validate().is_ok());
        }
        assert!(
            registry.get("apex.arc_wall").is_none(),
            "arc is a wall draw mode, not a second component"
        );
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
            .build_mesh(
                "apex.wall",
                &placement,
                &params,
                ground(),
                std::iter::empty(),
            )
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
            .build_mesh(
                "apex.wall",
                &placement,
                &ParamMap::new(),
                ground(),
                std::iter::empty(),
            )
            .expect("mesh");

        let size = size_of(&mesh);
        assert!((size[1] - 3.0).abs() < EPS, "default height");
        assert!((size[2] - 0.2).abs() < EPS, "default thickness");
    }

    #[test]
    fn a_wall_accepts_line_arc_and_polyline_on_the_same_type() {
        let registry = ComponentRegistry::with_builtins();
        let wall = registry.get("apex.wall").unwrap();
        assert_eq!(wall.placement, PlacementKind::Path);
        assert!(
            registry.get("apex.arc_wall").is_none(),
            "arc wall must not be a second component"
        );

        let line = Placement::line(Vec3::ZERO, Vec3::new(5.0, 0.0, 0.0));
        let arc = PlacementKind::ThreePointArc
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
        let poly = PlacementKind::Polyline
            .build(
                &[
                    Vec3::ZERO,
                    Vec3::new(4.0, 0.0, 0.0),
                    Vec3::new(4.0, 0.0, 3.0),
                ],
                0.0,
                &ground(),
            )
            .expect("polyline");

        let line_mesh = registry
            .build_mesh(
                "apex.wall",
                &line,
                &ParamMap::new(),
                ground(),
                std::iter::empty(),
            )
            .expect("line");
        let arc_mesh = registry
            .build_mesh(
                "apex.wall",
                &arc,
                &ParamMap::new(),
                ground(),
                std::iter::empty(),
            )
            .expect("arc");
        let poly_mesh = registry
            .build_mesh(
                "apex.wall",
                &poly,
                &ParamMap::new(),
                ground(),
                std::iter::empty(),
            )
            .expect("poly");

        assert_eq!(line_mesh.triangle_count(), 12);
        assert!(
            arc_mesh.triangle_count() > 12,
            "a curved wall has more faces"
        );
        assert!(poly_mesh.triangle_count() > 12, "a polyline has more faces");
        let (min, max) = arc_mesh.aabb().unwrap();
        assert!(min[1].abs() < EPS && (max[1] - 3.0).abs() < EPS);
    }

    #[test]
    fn switching_a_wall_profile_needs_no_new_type() {
        let mut registry = ComponentRegistry::with_builtins();
        let thick = ParamMap::new().with("thickness", ParamValue::Length(0.4));
        registry
            .update_profile_type_values("apex.wall.rect", &thick)
            .expect("rect type");
        registry
            .update_profile_type_values("apex.wall.round", &thick)
            .expect("round type");

        let placement = Placement::line(Vec3::ZERO, Vec3::new(5.0, 0.0, 0.0));
        let rect = ParamMap::new().with("height", ParamValue::Length(3.0));
        let round = rect
            .clone()
            .with("profile", ParamValue::ProfileRef("apex.wall.round".into()));

        let rect_mesh = registry
            .build_mesh("apex.wall", &placement, &rect, ground(), std::iter::empty())
            .expect("rect");
        let round_mesh = registry
            .build_mesh(
                "apex.wall",
                &placement,
                &round,
                ground(),
                std::iter::empty(),
            )
            .expect("round");

        let rect_size = size_of(&rect_mesh);
        let round_size = size_of(&round_mesh);
        assert!((rect_size[1] - 3.0).abs() < EPS, "rect height");
        assert!((rect_size[2] - 0.4).abs() < EPS, "rect thickness");
        assert!(
            (round_size[1] - 0.4).abs() < 1e-2,
            "round diameter follows thickness, got {}",
            round_size[1]
        );
        assert!(
            (round_size[2] - 0.4).abs() < 1e-2,
            "round in the thickness axis, got {}",
            round_size[2]
        );
        assert!(
            round_mesh.triangle_count() > rect_mesh.triangle_count(),
            "a circular section has more faces"
        );
    }

    #[test]
    fn a_column_is_added_with_data_alone() {
        let mut registry = ComponentRegistry::with_builtins();
        registry
            .update_profile_type_values(
                "apex.rect",
                &ParamMap::new()
                    .with("width", ParamValue::Length(0.5))
                    .with("depth", ParamValue::Length(0.3)),
            )
            .expect("type");
        let placement = Placement::point(Vec3::new(2.0, 0.0, 3.0));
        let params = ParamMap::new().with("height", ParamValue::Length(4.0));

        let mesh = registry
            .build_mesh(
                "apex.column",
                &placement,
                &params,
                ground(),
                std::iter::empty(),
            )
            .expect("mesh");

        let size = size_of(&mesh);
        assert!((size[0] - 0.5).abs() < EPS, "width {}", size[0]);
        assert!((size[1] - 4.0).abs() < EPS, "height {}", size[1]);
        assert!((size[2] - 0.3).abs() < EPS, "depth {}", size[2]);
    }

    #[test]
    fn switching_a_column_profile_needs_no_new_type() {
        let mut registry = ComponentRegistry::with_builtins();
        registry
            .update_profile_type_values(
                "apex.rect",
                &ParamMap::new()
                    .with("width", ParamValue::Length(0.6))
                    .with("depth", ParamValue::Length(0.3)),
            )
            .expect("rect type");
        registry
            .update_profile_type_values(
                "apex.round",
                &ParamMap::new().with("width", ParamValue::Length(0.6)),
            )
            .expect("round type");
        let placement = Placement::point(Vec3::ZERO);
        let rect = ParamMap::new().with("height", ParamValue::Length(3.0));
        let round = rect
            .clone()
            .with("profile", ParamValue::ProfileRef("apex.round".into()));

        let rect_mesh = registry
            .build_mesh(
                "apex.column",
                &placement,
                &rect,
                ground(),
                std::iter::empty(),
            )
            .expect("rect");
        let round_mesh = registry
            .build_mesh(
                "apex.column",
                &placement,
                &round,
                ground(),
                std::iter::empty(),
            )
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
            .build_mesh(
                "apex.beam",
                &placement,
                &ParamMap::new(),
                ground(),
                std::iter::empty(),
            )
            .expect("mesh");
        let wall = registry
            .build_mesh(
                "apex.wall",
                &placement,
                &ParamMap::new(),
                ground(),
                std::iter::empty(),
            )
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
                std::iter::empty(),
            )
            .unwrap_err();
        assert_eq!(
            err,
            RegistryError::PlacementMismatch {
                component: "apex.wall".into(),
                expected: "path",
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
                    ground(),
                    std::iter::empty(),
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
    fn registration_without_a_descriptor_fails() {
        let base = builtin_components()
            .into_iter()
            .find(|d| d.id == "apex.column")
            .unwrap();
        let mut registry = ComponentRegistry::new();
        let mut blank = base.clone();
        blank.id = "acme.blank".into();
        blank.descriptor = crate::Descriptor::default();
        let err = registry.register(blank).unwrap_err();
        assert!(err.to_string().contains("descriptor"), "{err}");
        assert!(registry.get("acme.blank").is_none());

        let mut whitespace = base.clone();
        whitespace.id = "acme.ws".into();
        whitespace.descriptor = crate::Descriptor::new("   ");
        assert!(registry.register(whitespace).is_err());

        // Authored JSON without a descriptor does not even parse.
        let mut value = serde_json::to_value(&base).unwrap();
        value.as_object_mut().unwrap().remove("descriptor");
        value["id"] = json!("acme.nodesc");
        let parsed: Result<ComponentDefinition, _> = serde_json::from_value(value);
        assert!(parsed.unwrap_err().to_string().contains("descriptor"));

        let mut ok = base;
        ok.id = "acme.ok".into();
        ok.descriptor = crate::Descriptor::new("A described post.");
        registry.register(ok).unwrap();
    }

    #[test]
    fn every_builtin_has_a_descriptor_with_a_valid_example() {
        for def in builtin_components() {
            assert!(!def.descriptor.is_missing(), "{}", def.id);
            for ex in &def.descriptor.examples {
                assert_eq!(
                    ex.input["component"],
                    def.id.as_str(),
                    "{} example names its type",
                    def.id
                );
            }
        }
    }

    #[test]
    fn an_invalid_component_is_refused_at_registration() {
        let mut registry = ComponentRegistry::new();
        let def = ComponentDefinition {
            opening: None,
            default_species: None,
            genus: None,
            descriptor: crate::Descriptor::new("test"),
            id: "acme.broken".into(),
            display_name: "Broken".into(),
            category: "generic".into(),
            source: ComponentSource::Visual,
            placement: PlacementKind::Point,
            placement_options: PlacementOptions::default(),
            host_cut: None,
            level_height_params: vec![],
            ifc_entity: None,
            joinable: false,
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
            opening: None,
            default_species: None,
            genus: None,
            descriptor: crate::Descriptor::new("test"),
            id: "acme.table".into(),
            display_name: "Table".into(),
            category: "furniture".into(),
            source: ComponentSource::Module {
                id: "acme.furniture".into(),
            },
            placement: PlacementKind::Point,
            placement_options: PlacementOptions::default(),
            host_cut: None,
            level_height_params: vec![],
            ifc_entity: None,
            joinable: false,
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
                std::iter::empty(),
            )
            .expect("mesh");
        let size = size_of(&mesh);
        assert!((size[0] - 1.2).abs() < 1e-2, "diameter {}", size[0]);
        assert!((size[1] - 0.05).abs() < EPS);
        assert_eq!(registry.len(), builtin_components().len() + 1);
    }

    #[test]
    fn a_component_can_be_installed_from_authored_json() {
        let json = r#"{
            "id": "acme.plinth",
            "descriptor": {"purpose": "Test component acme.plinth."},
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
                std::iter::empty(),
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
                opening: None,
                default_species: None,
                genus: None,
                descriptor: crate::Descriptor::new("test"),
                id: "acme.marker".into(),
                display_name: "Marker".into(),
                category: "annotation".into(),
                source: ComponentSource::Module { id: "acme".into() },
                placement: PlacementKind::Point,
                placement_options: PlacementOptions::default(),
                host_cut: None,
                level_height_params: vec![],
                ifc_entity: None,
                joinable: false,
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
                std::iter::empty(),
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
            .build_element_mesh(&element, ground(), std::iter::empty())
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

    #[test]
    fn wall_section_dimensions_live_on_the_profile_type() {
        let registry = ComponentRegistry::with_builtins();
        let wall = registry.get("apex.wall").unwrap();
        let ids: Vec<_> = wall.params.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "profile",
                "allow_join_start",
                "allow_join_end",
                "attach_top",
                "attach_top_to",
                "attach_base",
                "attach_base_to"
            ]
        );
        let profile = registry.profile("apex.wall.rect").expect("rect");
        assert!(profile
            .params
            .iter()
            .any(|p| p.id == "height" && p.binding.is_instance()));
        assert!(profile
            .params
            .iter()
            .any(|p| p.id == "thickness" && p.binding.is_type()));
    }

    #[test]
    fn persistable_params_keep_instance_keys_and_drop_type_keys() {
        let registry = ComponentRegistry::with_builtins();
        let raw = ParamMap::new()
            .with("height", ParamValue::Length(4.0))
            .with("thickness", ParamValue::Length(0.9));
        let stored = registry
            .persistable_params("apex.wall", &raw)
            .expect("persist");
        assert_eq!(stored.number("height"), Some(4.0));
        assert!(stored.get("thickness").is_none());
        assert_eq!(stored.text("profile"), Some("apex.wall.rect"));
    }

    #[test]
    fn a_type_formula_may_not_read_an_instance_parameter() {
        let mut registry = ComponentRegistry::new();
        let mut formulas = BTreeMap::new();
        formulas.insert(
            "thickness".into(),
            Expr::param("height") / Expr::constant(2.0),
        );
        let profile = ProfileType {
            id: "acme.bad".into(),
            display_name: "Bad".into(),
            category: "wall".into(),
            params: vec![
                ParamSpec::length("thickness", "Thickness", 0.2).as_type(),
                ParamSpec::length("height", "Height", 3.0),
            ],
            spec: ProfileSpec::Rectangle {
                width: Expr::param("thickness"),
                height: Expr::param("height"),
            },
            type_values: ParamMap::new(),
            formulas,
            sketch: None,
        };
        assert!(matches!(
            registry.upsert_profile(profile).unwrap_err(),
            RegistryError::Definition(DefinitionError::TypeDependsOnInstance { .. })
        ));
    }

    #[test]
    fn preview_profile_evaluates_the_spec_to_an_outline() {
        let registry = ComponentRegistry::with_builtins();
        let spec = ProfileSpec::Rectangle {
            width: Expr::param("thickness"),
            height: Expr::param("height"),
        };
        let params = ParamMap::new()
            .with("thickness", ParamValue::Length(0.2))
            .with("height", ParamValue::Length(3.0));
        let profile = registry.preview_profile(&spec, &params).expect("preview");
        let (min, max) = profile.bounds();
        assert!((max[0] - min[0] - 0.2).abs() < EPS);
        assert!((max[1] - min[1] - 3.0).abs() < EPS);
    }

    #[test]
    fn a_slab_extrudes_a_closed_polyline_for_thickness() {
        let registry = ComponentRegistry::with_builtins();
        let placement = PlacementKind::Polyline
            .build(
                &[
                    Vec3::ZERO,
                    Vec3::new(5.0, 0.0, 0.0),
                    Vec3::new(5.0, 0.0, 4.0),
                    Vec3::new(0.0, 0.0, 4.0),
                ],
                0.0,
                &ground(),
            )
            .expect("polyline");
        let params = ParamMap::new().with("thickness", ParamValue::Length(0.25));

        let mesh = registry
            .build_mesh(
                "apex.slab",
                &placement,
                &params,
                ground(),
                std::iter::empty(),
            )
            .expect("mesh");

        let size = size_of(&mesh);
        assert!((size[0] - 5.0).abs() < EPS, "width {}", size[0]);
        assert!((size[1] - 0.25).abs() < EPS, "thickness {}", size[1]);
        assert!((size[2] - 4.0).abs() < EPS, "depth {}", size[2]);
        assert!(mesh.aabb().unwrap().0[1].abs() < EPS, "sits on the level");
    }

    #[test]
    fn a_slab_rejects_an_open_two_point_boundary() {
        let registry = ComponentRegistry::with_builtins();
        let placement = PlacementKind::Polyline
            .build(&[Vec3::ZERO, Vec3::new(3.0, 0.0, 0.0)], 0.0, &ground())
            .expect("polyline");
        assert!(matches!(
            registry
                .build_mesh(
                    "apex.slab",
                    &placement,
                    &ParamMap::new(),
                    ground(),
                    std::iter::empty()
                )
                .unwrap_err(),
            RegistryError::Recipe(RecipeError::BoundaryTooSmall(2))
        ));
    }

    #[test]
    fn a_slab_rejects_point_placement() {
        let registry = ComponentRegistry::with_builtins();
        assert_eq!(
            registry
                .build_mesh(
                    "apex.slab",
                    &Placement::point(Vec3::ZERO),
                    &ParamMap::new(),
                    ground(),
                    std::iter::empty(),
                )
                .unwrap_err(),
            RegistryError::PlacementMismatch {
                component: "apex.slab".into(),
                expected: "polyline",
                actual: "point"
            }
        );
    }

    #[test]
    fn upsert_compiles_a_sketch_before_storing_the_profile() {
        use crate::sketch::{ProfileSketch, SketchDimension};

        let mut registry = ComponentRegistry::new();
        registry
            .upsert_profile(ProfileType {
                id: "user.l".into(),
                display_name: "L".into(),
                category: "wall".into(),
                params: vec![ParamSpec::length("thickness", "Thickness", 0.2).as_type()],
                spec: ProfileSpec::Rectangle {
                    width: Expr::constant(1.0),
                    height: Expr::constant(1.0),
                },
                type_values: ParamMap::new(),
                formulas: Default::default(),
                sketch: Some(ProfileSketch {
                    holes: Vec::new(),
                    vertices: vec![
                        [0.0, 0.0],
                        [1.0, 0.0],
                        [1.0, 0.2],
                        [0.2, 0.2],
                        [0.2, 1.0],
                        [0.0, 1.0],
                    ],
                    dimensions: vec![SketchDimension {
                        edge: 1,
                        param: "thickness".into(),
                    }],
                    constraints: vec![],
                }),
            })
            .expect("upsert");
        let stored = registry.profile("user.l").expect("stored");
        assert!(matches!(stored.spec, ProfileSpec::Polygon { .. }));
    }
}
