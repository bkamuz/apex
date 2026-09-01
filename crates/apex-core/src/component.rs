//! Components as data.
//!
//! A [`ComponentDefinition`] is the whole description of an object type:
//! how it is placed, what parameters it takes, and a [`GeometryRecipe`] saying
//! how to turn those into a mesh. Built-in types are described with exactly the
//! same structure a module or the visual editor produces, so nothing about
//! walls is privileged.

use std::collections::BTreeMap;

use apex_geometry::{
    extrude, sweep, Frame, GeometryError, Justification, Profile, SweepOptions, TriangleMesh,
};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::element::ComponentId;
use crate::expr::{Expr, ExprError};
use crate::param::{ParamBinding, ParamError, ParamId, ParamMap, ParamSpec};
use crate::placement::{Placement, PlacementError, PlacementKind};
use crate::sketch::{ProfileSketch, SketchError};

pub type ModuleId = String;
pub type ProfileId = String;

/// Named, reusable profile types a component can point at.
pub type ProfileLibrary = BTreeMap<ProfileId, ProfileType>;

/// Guards against a named profile that eventually references itself.
const MAX_PROFILE_DEPTH: usize = 8;

/// Not `Eq`: geometry errors carry the float that failed.
#[derive(Debug, Clone, PartialEq, Error)]
pub enum RecipeError {
    #[error(transparent)]
    Expr(#[from] ExprError),
    #[error("geometry: {0}")]
    Geometry(GeometryError),
    #[error(transparent)]
    Placement(#[from] PlacementError),
    #[error("this recipe needs a curve placement, but the element is point-placed")]
    NeedsCurve,
    #[error("unknown profile '{0}'")]
    UnknownProfile(ProfileId),
    #[error("parameter '{0}' does not name a profile")]
    NotAProfileParam(ParamId),
    #[error("profile '{0}' references itself")]
    RecursiveProfile(ProfileId),
    #[error("no builder registered for '{0}'")]
    UnknownBuilder(String),
    #[error("a group recipe needs at least one step")]
    EmptyGroup,
}

impl From<GeometryError> for RecipeError {
    fn from(e: GeometryError) -> Self {
        Self::Geometry(e)
    }
}

/// How a component came to exist. Authoring is a property, not a separate kind
/// of thing: a visually built component can later gain a `Custom` recipe step
/// from a module without changing what it is.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ComponentSource {
    BuiltIn,
    /// Assembled by the user in the editor, no code involved.
    #[default]
    Visual,
    Module {
        id: ModuleId,
    },
}

/// Which coordinate system a recipe step builds in.
///
/// The indirection that lets a user-authored reference point become a frame
/// source later without rewriting any recipe.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "from", rename_all = "snake_case")]
pub enum FrameSource {
    /// The level's work plane, moved to the element's origin. Ignores any
    /// rotation or tangent, so the result stays aligned with the level.
    WorkPlane,
    /// The placement's own frame at `t`, following rotation or curve tangent.
    PlacementCurve { t: Expr },
    /// Reserved for reference points and planes; not resolvable yet.
    Ref { id: String },
}

impl Default for FrameSource {
    fn default() -> Self {
        Self::PlacementCurve {
            t: Expr::constant(0.0),
        }
    }
}

impl FrameSource {
    fn resolve(&self, ctx: &RecipeContext) -> Result<Frame, RecipeError> {
        match self {
            Self::WorkPlane => Ok(ctx.work_plane.with_origin(ctx.placement.origin())),
            Self::PlacementCurve { t } => {
                let t = t.eval_f32(ctx.params)?;
                Ok(ctx.placement.frame_at(t, &ctx.work_plane)?)
            }
            Self::Ref { id } => Err(RecipeError::UnknownProfile(id.clone())),
        }
    }
}

/// A cross-section, described parametrically so it rebuilds when params change.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "shape", rename_all = "snake_case")]
pub enum ProfileSpec {
    Rectangle {
        width: Expr,
        height: Expr,
    },
    Circle {
        radius: Expr,
        #[serde(default = "default_segments")]
        segments: u32,
    },
    Polygon {
        points: Vec<[Expr; 2]>,
    },
    /// A profile from the shared library.
    Named {
        id: ProfileId,
    },
    /// The profile named by a parameter. This is what makes profiles swappable
    /// per element rather than per component.
    FromParam {
        param: ParamId,
    },
}

fn default_segments() -> u32 {
    24
}

impl ProfileSpec {
    pub fn evaluate(
        &self,
        params: &ParamMap,
        library: &ProfileLibrary,
    ) -> Result<Profile, RecipeError> {
        self.evaluate_at(params, library, 0)
    }

    fn evaluate_at(
        &self,
        params: &ParamMap,
        library: &ProfileLibrary,
        depth: usize,
    ) -> Result<Profile, RecipeError> {
        match self {
            Self::Rectangle { width, height } => Ok(Profile::rectangle(
                width.eval_f32(params)?,
                height.eval_f32(params)?,
            )?),
            Self::Circle { radius, segments } => {
                Ok(Profile::circle(radius.eval_f32(params)?, *segments)?)
            }
            Self::Polygon { points } => {
                let evaluated = points
                    .iter()
                    .map(|[u, v]| Ok([u.eval_f32(params)?, v.eval_f32(params)?]))
                    .collect::<Result<Vec<_>, ExprError>>()?;
                Ok(Profile::polygon(evaluated)?)
            }
            Self::Named { id } => {
                if depth >= MAX_PROFILE_DEPTH {
                    return Err(RecipeError::RecursiveProfile(id.clone()));
                }
                library
                    .get(id)
                    .ok_or_else(|| RecipeError::UnknownProfile(id.clone()))?
                    .spec
                    .evaluate_at(params, library, depth + 1)
            }
            Self::FromParam { param } => {
                let id = params
                    .text(param)
                    .ok_or_else(|| RecipeError::NotAProfileParam(param.clone()))?;
                Self::Named { id: id.to_string() }.evaluate_at(params, library, depth)
            }
        }
    }

    fn collect_params(&self, out: &mut Vec<ParamId>) {
        match self {
            Self::Rectangle { width, height } => {
                out.extend(width.referenced_params());
                out.extend(height.referenced_params());
            }
            Self::Circle { radius, .. } => out.extend(radius.referenced_params()),
            Self::Polygon { points } => {
                for [u, v] in points {
                    out.extend(u.referenced_params());
                    out.extend(v.referenced_params());
                }
            }
            Self::Named { .. } => {}
            Self::FromParam { param } => out.push(param.clone()),
        }
    }

    /// Every parameter this spec reads, for validating a profile type.
    pub fn referenced_params(&self) -> Vec<ParamId> {
        let mut out = Vec::new();
        self.collect_params(&mut out);
        out.sort();
        out.dedup();
        out
    }
}

/// How to turn a placement plus parameters into a mesh.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum GeometryRecipe {
    /// Run the profile along the placement curve. Walls, beams, pipes.
    Sweep {
        profile: ProfileSpec,
        #[serde(default)]
        justification: Justification,
        #[serde(default = "Expr::zero")]
        start_offset: Expr,
        #[serde(default = "Expr::zero")]
        end_offset: Expr,
    },
    /// Push the profile off its own plane. Columns, pads, slabs.
    Extrude {
        profile: ProfileSpec,
        #[serde(default)]
        frame: FrameSource,
        height: Expr,
    },
    /// Several steps unioned into one mesh.
    Group { steps: Vec<GeometryRecipe> },
    /// Escape hatch: a builder supplied by a module.
    Custom { builder_id: String },
}

impl GeometryRecipe {
    /// Every parameter this recipe reads, for validating a definition.
    pub fn referenced_params(&self) -> Vec<ParamId> {
        let mut out = Vec::new();
        self.collect_params(&mut out);
        out.sort();
        out.dedup();
        out
    }

    fn collect_params(&self, out: &mut Vec<ParamId>) {
        match self {
            Self::Sweep {
                profile,
                start_offset,
                end_offset,
                ..
            } => {
                profile.collect_params(out);
                out.extend(start_offset.referenced_params());
                out.extend(end_offset.referenced_params());
            }
            Self::Extrude {
                profile,
                frame,
                height,
            } => {
                profile.collect_params(out);
                if let FrameSource::PlacementCurve { t } = frame {
                    out.extend(t.referenced_params());
                }
                out.extend(height.referenced_params());
            }
            Self::Group { steps } => {
                for step in steps {
                    step.collect_params(out);
                }
            }
            // A custom builder reads whatever it likes; nothing to validate here.
            Self::Custom { .. } => {}
        }
    }
}

/// Everything a recipe needs to produce geometry.
pub struct RecipeContext<'a> {
    pub placement: &'a Placement,
    pub params: &'a ParamMap,
    pub work_plane: Frame,
    pub profiles: &'a ProfileLibrary,
}

/// A mesh generator supplied by a module, reached through `GeometryRecipe::Custom`.
pub trait MeshBuilder {
    fn build(&self, ctx: &RecipeContext) -> Result<TriangleMesh, RecipeError>;
}

impl<F> MeshBuilder for F
where
    F: Fn(&RecipeContext) -> Result<TriangleMesh, RecipeError>,
{
    fn build(&self, ctx: &RecipeContext) -> Result<TriangleMesh, RecipeError> {
        self(ctx)
    }
}

/// Evaluate a recipe. `builders` resolves `Custom` steps.
pub fn evaluate_recipe(
    recipe: &GeometryRecipe,
    ctx: &RecipeContext,
    builders: &BTreeMap<String, Box<dyn MeshBuilder>>,
) -> Result<TriangleMesh, RecipeError> {
    match recipe {
        GeometryRecipe::Sweep {
            profile,
            justification,
            start_offset,
            end_offset,
        } => {
            let curve = ctx.placement.curve().ok_or(RecipeError::NeedsCurve)?;
            let profile = profile.evaluate(ctx.params, ctx.profiles)?;
            let options = SweepOptions {
                justification: *justification,
                start_extension: start_offset.eval_f32(ctx.params)?,
                end_extension: end_offset.eval_f32(ctx.params)?,
                up: ctx.work_plane.z,
                ..SweepOptions::default()
            };
            Ok(sweep(&profile, curve, &options)?)
        }
        GeometryRecipe::Extrude {
            profile,
            frame,
            height,
        } => {
            let base = frame.resolve(ctx)?;
            let profile = profile.evaluate(ctx.params, ctx.profiles)?;
            Ok(extrude(&profile, &base, height.eval_f32(ctx.params)?)?)
        }
        GeometryRecipe::Group { steps } => {
            if steps.is_empty() {
                return Err(RecipeError::EmptyGroup);
            }
            let mut mesh = TriangleMesh::empty();
            for step in steps {
                mesh.append(&evaluate_recipe(step, ctx, builders)?);
            }
            Ok(mesh)
        }
        GeometryRecipe::Custom { builder_id } => builders
            .get(builder_id)
            .ok_or_else(|| RecipeError::UnknownBuilder(builder_id.clone()))?
            .build(ctx),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum DefinitionError {
    #[error("component '{component}' declares parameter '{param}' twice")]
    DuplicateParam {
        component: ComponentId,
        param: ParamId,
    },
    #[error("component '{component}' recipe uses undeclared parameter '{param}'")]
    UndeclaredParam {
        component: ComponentId,
        param: ParamId,
    },
    #[error("component id must not be empty")]
    EmptyId,
    #[error(
        "profile '{profile}' type parameter '{param}' depends on instance parameter '{referenced}'"
    )]
    TypeDependsOnInstance {
        profile: ProfileId,
        param: ParamId,
        referenced: ParamId,
    },
    #[error("profile '{profile}' sketch needs at least 3 vertices, got {count}")]
    SketchTooSmall { profile: ProfileId, count: usize },
}

/// The complete description of an object type.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ComponentDefinition {
    pub id: ComponentId,
    pub display_name: String,
    /// Free-form, so a user can invent a category without a core change.
    pub category: String,
    #[serde(default)]
    pub source: ComponentSource,
    pub placement: PlacementKind,
    #[serde(default)]
    pub params: Vec<ParamSpec>,
    pub recipe: GeometryRecipe,
}

impl ComponentDefinition {
    /// Catch authoring mistakes at registration rather than at render time.
    pub fn validate(&self) -> Result<(), DefinitionError> {
        if self.id.trim().is_empty() {
            return Err(DefinitionError::EmptyId);
        }

        let mut seen = std::collections::BTreeSet::new();
        for spec in &self.params {
            if !seen.insert(spec.id.as_str()) {
                return Err(DefinitionError::DuplicateParam {
                    component: self.id.clone(),
                    param: spec.id.clone(),
                });
            }
        }

        for param in self.recipe.referenced_params() {
            if !seen.contains(param.as_str()) {
                return Err(DefinitionError::UndeclaredParam {
                    component: self.id.clone(),
                    param,
                });
            }
        }
        Ok(())
    }

    /// Fill in defaults and type-check raw values against this component's schema.
    pub fn resolve_params(&self, raw: &ParamMap) -> Result<ParamMap, crate::param::ParamError> {
        raw.resolve(&self.params)
    }

    /// The first profile-valued parameter, if this component picks a section.
    pub fn profile_param_id(&self) -> Option<&str> {
        self.params.iter().find_map(|spec| match spec.kind {
            crate::param::ParamKind::Profile { .. } => Some(spec.id.as_str()),
            _ => None,
        })
    }
}

/// A reusable section: shape plus type/instance parameters.
///
/// For a wall, the profile type *is* the wall type: thickness is typically a
/// type parameter, height an instance parameter. Column height stays on the
/// component because it is an extrude, not part of the section.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProfileType {
    pub id: ProfileId,
    pub display_name: String,
    /// `wall`, `column`, `beam`, or a user category. Filters the tool picker.
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub params: Vec<ParamSpec>,
    pub spec: ProfileSpec,
    /// Current values of type-bound parameters.
    #[serde(default)]
    pub type_values: ParamMap,
    /// Derived parameters, keyed by param id. Type formulas may not read instance ids.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub formulas: BTreeMap<ParamId, Expr>,
    /// Mouse-drawn outline. When present, [`ProfileType::compile_sketch`]
    /// overwrites `spec` with a parametric polygon.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sketch: Option<ProfileSketch>,
}

impl ProfileType {
    /// A nameless shape with no parameters, for tests and nested aliases.
    pub fn shape(id: impl Into<ProfileId>, spec: ProfileSpec) -> Self {
        let id = id.into();
        Self {
            display_name: id.clone(),
            id,
            category: String::new(),
            params: vec![],
            spec,
            type_values: ParamMap::new(),
            formulas: BTreeMap::new(),
            sketch: None,
        }
    }

    /// Turn a drawn sketch into a parametric [`ProfileSpec::Polygon`].
    pub fn compile_sketch(&mut self) -> Result<(), DefinitionError> {
        let Some(sketch) = &self.sketch else {
            return Ok(());
        };
        match sketch.to_profile_spec() {
            Ok(spec) => {
                self.spec = spec;
                Ok(())
            }
            Err(SketchError::TooSmall(count)) => Err(DefinitionError::SketchTooSmall {
                profile: self.id.clone(),
                count,
            }),
        }
    }

    pub fn type_params(&self) -> impl Iterator<Item = &ParamSpec> {
        self.params.iter().filter(|spec| spec.binding.is_type())
    }

    pub fn instance_params(&self) -> impl Iterator<Item = &ParamSpec> {
        self.params.iter().filter(|spec| spec.binding.is_instance())
    }

    pub fn validate(&self) -> Result<(), DefinitionError> {
        if self.id.trim().is_empty() {
            return Err(DefinitionError::EmptyId);
        }

        let mut seen = std::collections::BTreeSet::new();
        for spec in &self.params {
            if !seen.insert(spec.id.as_str()) {
                return Err(DefinitionError::DuplicateParam {
                    component: self.id.clone(),
                    param: spec.id.clone(),
                });
            }
        }

        for param in self.spec.referenced_params() {
            if matches!(
                self.spec,
                ProfileSpec::Named { .. } | ProfileSpec::FromParam { .. }
            ) {
                break;
            }
            if !seen.contains(param.as_str()) {
                return Err(DefinitionError::UndeclaredParam {
                    component: self.id.clone(),
                    param,
                });
            }
        }

        for (id, expr) in &self.formulas {
            if !seen.contains(id.as_str()) {
                return Err(DefinitionError::UndeclaredParam {
                    component: self.id.clone(),
                    param: id.clone(),
                });
            }
            self.reject_type_depends_on_instance(id, expr, &seen)?;
        }
        Ok(())
    }

    /// A type-bound expression (formula, or a spec treated as type-level) may
    /// not read an instance parameter. Instance expressions may read type ids.
    fn reject_type_depends_on_instance(
        &self,
        owner: &ParamId,
        expr: &Expr,
        declared: &std::collections::BTreeSet<&str>,
    ) -> Result<(), DefinitionError> {
        let owner_is_type = self
            .params
            .iter()
            .find(|spec| spec.id == *owner)
            .is_some_and(|spec| spec.binding.is_type());
        if !owner_is_type {
            return Ok(());
        }
        for referenced in expr.referenced_params() {
            if !declared.contains(referenced.as_str()) {
                return Err(DefinitionError::UndeclaredParam {
                    component: self.id.clone(),
                    param: referenced,
                });
            }
            let referenced_is_instance = self
                .params
                .iter()
                .find(|spec| spec.id == referenced)
                .is_some_and(|spec| spec.binding.is_instance());
            if referenced_is_instance {
                return Err(DefinitionError::TypeDependsOnInstance {
                    profile: self.id.clone(),
                    param: owner.clone(),
                    referenced,
                });
            }
        }
        Ok(())
    }

    pub fn resolve_type_values(&self) -> Result<ParamMap, ParamError> {
        let specs: Vec<_> = self.type_params().cloned().collect();
        let mut map = self.type_values.resolve(&specs)?;
        self.apply_formulas(&mut map, ParamBinding::Type)?;
        Ok(map)
    }

    fn apply_formulas(&self, map: &mut ParamMap, binding: ParamBinding) -> Result<(), ParamError> {
        for spec in &self.params {
            if spec.binding != binding {
                continue;
            }
            let Some(expr) = self.formulas.get(&spec.id) else {
                continue;
            };
            let number = expr.eval(map).map_err(formula_param_error)?;
            let value = crate::param::ParamValue::Number(number).coerce(&spec.id, &spec.kind)?;
            spec.check_range(&value)?;
            map.set(spec.id.clone(), value);
        }
        Ok(())
    }

    /// Overlay instance values (and instance formulas) on resolved type values.
    pub fn merge_eval_params(&self, raw_instance: &ParamMap) -> Result<ParamMap, ParamError> {
        let mut map = self.resolve_type_values()?;
        let instance_specs: Vec<_> = self.instance_params().cloned().collect();
        let instance = raw_instance.resolve(&instance_specs)?;
        map = map.merged(&instance);
        self.apply_formulas(&mut map, ParamBinding::Instance)?;
        Ok(map)
    }
}

fn formula_param_error(err: ExprError) -> ParamError {
    match err {
        ExprError::UnknownParam(id) => ParamError::Missing { id },
        ExprError::NotNumeric(id) => ParamError::TypeMismatch {
            id,
            expected: "a number",
        },
        ExprError::DivisionByZero => ParamError::OutOfRange {
            id: "formula".into(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::param::{ParamKind, ParamValue};
    use glam::Vec3;

    const EPS: f32 = 1e-4;

    fn no_builders() -> BTreeMap<String, Box<dyn MeshBuilder>> {
        BTreeMap::new()
    }

    fn ctx<'a>(
        placement: &'a Placement,
        params: &'a ParamMap,
        profiles: &'a ProfileLibrary,
    ) -> RecipeContext<'a> {
        RecipeContext {
            placement,
            params,
            work_plane: Frame::horizontal(0.0),
            profiles,
        }
    }

    fn size_of(mesh: &TriangleMesh) -> [f32; 3] {
        let (min, max) = mesh.aabb().expect("aabb");
        [max[0] - min[0], max[1] - min[1], max[2] - min[2]]
    }

    #[test]
    fn a_sweep_recipe_reads_its_dimensions_from_params() {
        let recipe = GeometryRecipe::Sweep {
            profile: ProfileSpec::Rectangle {
                width: Expr::param("thickness"),
                height: Expr::param("height"),
            },
            justification: Justification::BaseCenter,
            start_offset: Expr::zero(),
            end_offset: Expr::zero(),
        };
        let placement = Placement::line(Vec3::ZERO, Vec3::new(5.0, 0.0, 0.0));
        let params = ParamMap::new()
            .with("height", ParamValue::Length(3.0))
            .with("thickness", ParamValue::Length(0.2));
        let profiles = ProfileLibrary::new();

        let mesh = evaluate_recipe(
            &recipe,
            &ctx(&placement, &params, &profiles),
            &no_builders(),
        )
        .expect("mesh");
        let size = size_of(&mesh);
        assert!((size[0] - 5.0).abs() < EPS);
        assert!((size[1] - 3.0).abs() < EPS);
        assert!((size[2] - 0.2).abs() < EPS);
    }

    #[test]
    fn changing_a_param_changes_the_geometry() {
        let recipe = GeometryRecipe::Sweep {
            profile: ProfileSpec::Rectangle {
                width: Expr::param("thickness"),
                height: Expr::param("height"),
            },
            justification: Justification::BaseCenter,
            start_offset: Expr::zero(),
            end_offset: Expr::zero(),
        };
        let placement = Placement::line(Vec3::ZERO, Vec3::new(5.0, 0.0, 0.0));
        let profiles = ProfileLibrary::new();

        let short = ParamMap::new()
            .with("height", ParamValue::Length(2.0))
            .with("thickness", ParamValue::Length(0.2));
        let tall = ParamMap::new()
            .with("height", ParamValue::Length(6.0))
            .with("thickness", ParamValue::Length(0.2));

        let a = evaluate_recipe(&recipe, &ctx(&placement, &short, &profiles), &no_builders())
            .expect("mesh");
        let b = evaluate_recipe(&recipe, &ctx(&placement, &tall, &profiles), &no_builders())
            .expect("mesh");
        assert!((size_of(&a)[1] - 2.0).abs() < EPS);
        assert!((size_of(&b)[1] - 6.0).abs() < EPS);
    }

    #[test]
    fn expressions_inside_a_recipe_are_evaluated() {
        // A rebate half the thickness wide.
        let recipe = GeometryRecipe::Sweep {
            profile: ProfileSpec::Rectangle {
                width: Expr::param("thickness") / Expr::constant(2.0),
                height: Expr::param("height"),
            },
            justification: Justification::BaseCenter,
            start_offset: Expr::zero(),
            end_offset: Expr::zero(),
        };
        let placement = Placement::line(Vec3::ZERO, Vec3::new(5.0, 0.0, 0.0));
        let params = ParamMap::new()
            .with("height", ParamValue::Length(3.0))
            .with("thickness", ParamValue::Length(0.4));
        let profiles = ProfileLibrary::new();

        let mesh = evaluate_recipe(
            &recipe,
            &ctx(&placement, &params, &profiles),
            &no_builders(),
        )
        .expect("mesh");
        assert!((size_of(&mesh)[2] - 0.2).abs() < EPS, "half of 0.4");
    }

    #[test]
    fn a_sweep_on_a_point_placement_fails_clearly() {
        let recipe = GeometryRecipe::Sweep {
            profile: ProfileSpec::Rectangle {
                width: Expr::constant(0.2),
                height: Expr::constant(3.0),
            },
            justification: Justification::BaseCenter,
            start_offset: Expr::zero(),
            end_offset: Expr::zero(),
        };
        let placement = Placement::point(Vec3::ZERO);
        let params = ParamMap::new();
        let profiles = ProfileLibrary::new();

        assert_eq!(
            evaluate_recipe(
                &recipe,
                &ctx(&placement, &params, &profiles),
                &no_builders()
            )
            .unwrap_err(),
            RecipeError::NeedsCurve
        );
    }

    #[test]
    fn an_extrude_recipe_stands_the_profile_up_at_the_point() {
        let recipe = GeometryRecipe::Extrude {
            profile: ProfileSpec::Rectangle {
                width: Expr::param("width"),
                height: Expr::param("depth"),
            },
            frame: FrameSource::default(),
            height: Expr::param("height"),
        };
        let placement = Placement::point(Vec3::new(2.0, 0.0, 3.0));
        let params = ParamMap::new()
            .with("width", ParamValue::Length(0.4))
            .with("depth", ParamValue::Length(0.6))
            .with("height", ParamValue::Length(3.0));
        let profiles = ProfileLibrary::new();

        let mesh = evaluate_recipe(
            &recipe,
            &ctx(&placement, &params, &profiles),
            &no_builders(),
        )
        .expect("mesh");
        let size = size_of(&mesh);
        assert!((size[0] - 0.4).abs() < EPS, "width {}", size[0]);
        assert!((size[1] - 3.0).abs() < EPS, "height {}", size[1]);
        assert!((size[2] - 0.6).abs() < EPS, "depth {}", size[2]);

        let (min, _) = mesh.aabb().expect("aabb");
        assert!((min[1] - 0.0).abs() < EPS, "should stand on the work plane");
    }

    #[test]
    fn work_plane_frame_source_ignores_the_placement_rotation() {
        let recipe = |frame: FrameSource| GeometryRecipe::Extrude {
            profile: ProfileSpec::Rectangle {
                width: Expr::constant(2.0),
                height: Expr::constant(0.2),
            },
            frame,
            height: Expr::constant(1.0),
        };
        let placement = Placement::Point {
            origin: Vec3::ZERO,
            rotation: std::f32::consts::FRAC_PI_2,
        };
        let params = ParamMap::new();
        let profiles = ProfileLibrary::new();
        let c = ctx(&placement, &params, &profiles);

        let aligned = evaluate_recipe(&recipe(FrameSource::WorkPlane), &c, &no_builders()).unwrap();
        let turned = evaluate_recipe(&recipe(FrameSource::default()), &c, &no_builders()).unwrap();

        assert!(
            (size_of(&aligned)[0] - 2.0).abs() < EPS,
            "stays level-aligned"
        );
        assert!(
            (size_of(&turned)[2] - 2.0).abs() < EPS,
            "follows the placement rotation"
        );
    }

    #[test]
    fn a_group_recipe_unions_its_steps() {
        let column = GeometryRecipe::Extrude {
            profile: ProfileSpec::Rectangle {
                width: Expr::constant(0.4),
                height: Expr::constant(0.4),
            },
            frame: FrameSource::default(),
            height: Expr::constant(3.0),
        };
        let pad = GeometryRecipe::Extrude {
            profile: ProfileSpec::Rectangle {
                width: Expr::constant(1.0),
                height: Expr::constant(1.0),
            },
            frame: FrameSource::default(),
            height: Expr::constant(0.2),
        };
        let group = GeometryRecipe::Group {
            steps: vec![column.clone(), pad],
        };

        let placement = Placement::point(Vec3::ZERO);
        let params = ParamMap::new();
        let profiles = ProfileLibrary::new();
        let c = ctx(&placement, &params, &profiles);

        let one = evaluate_recipe(&column, &c, &no_builders()).unwrap();
        let both = evaluate_recipe(&group, &c, &no_builders()).unwrap();

        assert_eq!(both.triangle_count(), one.triangle_count() * 2);
        // The wider base pad must show up in the footprint.
        assert!((size_of(&both)[0] - 1.0).abs() < EPS);
    }

    #[test]
    fn an_empty_group_is_rejected() {
        let placement = Placement::point(Vec3::ZERO);
        let params = ParamMap::new();
        let profiles = ProfileLibrary::new();
        assert_eq!(
            evaluate_recipe(
                &GeometryRecipe::Group { steps: vec![] },
                &ctx(&placement, &params, &profiles),
                &no_builders()
            )
            .unwrap_err(),
            RecipeError::EmptyGroup
        );
    }

    #[test]
    fn a_custom_step_calls_the_registered_builder() {
        let mut builders: BTreeMap<String, Box<dyn MeshBuilder>> = BTreeMap::new();
        builders.insert(
            "acme.blob".to_string(),
            Box::new(|_: &RecipeContext| {
                let mut mesh = TriangleMesh::empty();
                mesh.push_triangle([0.0; 3], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]);
                Ok(mesh)
            }),
        );

        let placement = Placement::point(Vec3::ZERO);
        let params = ParamMap::new();
        let profiles = ProfileLibrary::new();
        let recipe = GeometryRecipe::Custom {
            builder_id: "acme.blob".into(),
        };

        let mesh =
            evaluate_recipe(&recipe, &ctx(&placement, &params, &profiles), &builders).unwrap();
        assert_eq!(mesh.triangle_count(), 1);

        let missing = GeometryRecipe::Custom {
            builder_id: "acme.nope".into(),
        };
        assert_eq!(
            evaluate_recipe(&missing, &ctx(&placement, &params, &profiles), &builders).unwrap_err(),
            RecipeError::UnknownBuilder("acme.nope".into())
        );
    }

    #[test]
    fn a_named_profile_comes_from_the_library() {
        let mut profiles = ProfileLibrary::new();
        profiles.insert(
            "acme.slim".into(),
            ProfileType::shape(
                "acme.slim",
                ProfileSpec::Rectangle {
                    width: Expr::constant(0.1),
                    height: Expr::constant(2.0),
                },
            ),
        );

        let recipe = GeometryRecipe::Sweep {
            profile: ProfileSpec::Named {
                id: "acme.slim".into(),
            },
            justification: Justification::BaseCenter,
            start_offset: Expr::zero(),
            end_offset: Expr::zero(),
        };
        let placement = Placement::line(Vec3::ZERO, Vec3::new(4.0, 0.0, 0.0));
        let params = ParamMap::new();

        let mesh = evaluate_recipe(
            &recipe,
            &ctx(&placement, &params, &profiles),
            &no_builders(),
        )
        .expect("mesh");
        assert!((size_of(&mesh)[2] - 0.1).abs() < EPS);
        assert!((size_of(&mesh)[1] - 2.0).abs() < EPS);
    }

    #[test]
    fn a_profile_parameter_swaps_the_cross_section_per_element() {
        let mut profiles = ProfileLibrary::new();
        profiles.insert(
            "acme.thin".into(),
            ProfileType::shape(
                "acme.thin",
                ProfileSpec::Rectangle {
                    width: Expr::constant(0.1),
                    height: Expr::constant(1.0),
                },
            ),
        );
        profiles.insert(
            "acme.fat".into(),
            ProfileType::shape(
                "acme.fat",
                ProfileSpec::Rectangle {
                    width: Expr::constant(0.9),
                    height: Expr::constant(1.0),
                },
            ),
        );

        let recipe = GeometryRecipe::Sweep {
            profile: ProfileSpec::FromParam {
                param: "profile".into(),
            },
            justification: Justification::BaseCenter,
            start_offset: Expr::zero(),
            end_offset: Expr::zero(),
        };
        let placement = Placement::line(Vec3::ZERO, Vec3::new(4.0, 0.0, 0.0));

        let thin = ParamMap::new().with("profile", ParamValue::ProfileRef("acme.thin".into()));
        let fat = ParamMap::new().with("profile", ParamValue::ProfileRef("acme.fat".into()));

        let a = evaluate_recipe(&recipe, &ctx(&placement, &thin, &profiles), &no_builders())
            .expect("mesh");
        let b = evaluate_recipe(&recipe, &ctx(&placement, &fat, &profiles), &no_builders())
            .expect("mesh");

        assert!((size_of(&a)[2] - 0.1).abs() < EPS);
        assert!((size_of(&b)[2] - 0.9).abs() < EPS);
    }

    #[test]
    fn an_unknown_profile_is_reported() {
        let profiles = ProfileLibrary::new();
        let placement = Placement::line(Vec3::ZERO, Vec3::new(4.0, 0.0, 0.0));
        let params = ParamMap::new();
        let recipe = GeometryRecipe::Sweep {
            profile: ProfileSpec::Named {
                id: "missing".into(),
            },
            justification: Justification::default(),
            start_offset: Expr::zero(),
            end_offset: Expr::zero(),
        };
        assert_eq!(
            evaluate_recipe(
                &recipe,
                &ctx(&placement, &params, &profiles),
                &no_builders()
            )
            .unwrap_err(),
            RecipeError::UnknownProfile("missing".into())
        );
    }

    #[test]
    fn a_self_referencing_profile_does_not_loop_forever() {
        let mut profiles = ProfileLibrary::new();
        profiles.insert(
            "loop".into(),
            ProfileType::shape(
                "loop",
                ProfileSpec::Named {
                    id: "loop".to_string(),
                },
            ),
        );
        let params = ParamMap::new();
        assert_eq!(
            ProfileSpec::Named { id: "loop".into() }
                .evaluate(&params, &profiles)
                .unwrap_err(),
            RecipeError::RecursiveProfile("loop".into())
        );
    }

    #[test]
    fn validate_rejects_a_recipe_that_uses_an_undeclared_param() {
        let def = ComponentDefinition {
            id: "acme.thing".into(),
            display_name: "Thing".into(),
            category: "generic".into(),
            source: ComponentSource::Visual,
            placement: PlacementKind::TwoPoint,
            params: vec![ParamSpec::length("height", "Height", 3.0)],
            recipe: GeometryRecipe::Sweep {
                profile: ProfileSpec::Rectangle {
                    width: Expr::param("thicknes"), // typo
                    height: Expr::param("height"),
                },
                justification: Justification::BaseCenter,
                start_offset: Expr::zero(),
                end_offset: Expr::zero(),
            },
        };

        assert_eq!(
            def.validate().unwrap_err(),
            DefinitionError::UndeclaredParam {
                component: "acme.thing".into(),
                param: "thicknes".into()
            },
            "a typo must be caught at registration, not at render"
        );
    }

    #[test]
    fn validate_rejects_duplicate_and_empty_ids() {
        let mut def = ComponentDefinition {
            id: "acme.thing".into(),
            display_name: "Thing".into(),
            category: "generic".into(),
            source: ComponentSource::Visual,
            placement: PlacementKind::Point,
            params: vec![
                ParamSpec::length("height", "Height", 3.0),
                ParamSpec::length("height", "Height again", 4.0),
            ],
            recipe: GeometryRecipe::Extrude {
                profile: ProfileSpec::Circle {
                    radius: Expr::constant(0.5),
                    segments: 16,
                },
                frame: FrameSource::default(),
                height: Expr::param("height"),
            },
        };
        assert_eq!(
            def.validate().unwrap_err(),
            DefinitionError::DuplicateParam {
                component: "acme.thing".into(),
                param: "height".into()
            }
        );

        def.params.pop();
        assert!(def.validate().is_ok());

        def.id = "  ".into();
        assert_eq!(def.validate().unwrap_err(), DefinitionError::EmptyId);
    }

    #[test]
    fn a_definition_round_trips_through_json() {
        let def = ComponentDefinition {
            id: "acme.table".into(),
            display_name: "Table".into(),
            category: "furniture".into(),
            source: ComponentSource::Module {
                id: "acme.furniture".into(),
            },
            placement: PlacementKind::Point,
            params: vec![ParamSpec::length("height", "Height", 0.75)],
            recipe: GeometryRecipe::Extrude {
                profile: ProfileSpec::Circle {
                    radius: Expr::constant(0.6),
                    segments: 32,
                },
                frame: FrameSource::WorkPlane,
                height: Expr::param("height"),
            },
        };

        let json = serde_json::to_string(&def).expect("serialize");
        assert!(json.contains(r#""placement":"point""#), "json was {json}");
        assert!(json.contains(r#""op":"extrude""#), "json was {json}");
        assert_eq!(
            serde_json::from_str::<ComponentDefinition>(&json).unwrap(),
            def
        );
    }

    #[test]
    fn a_definition_can_be_authored_as_plain_json() {
        // The shape a module or the visual editor would hand us.
        let json = r#"{
            "id": "acme.post",
            "display_name": "Post",
            "category": "structure",
            "source": "visual",
            "placement": "point",
            "params": [
                {"id": "height", "label": "Height", "kind": "length", "default": 2.5},
                {"id": "radius", "label": "Radius", "kind": "length", "default": 0.05}
            ],
            "recipe": {
                "op": "extrude",
                "profile": {"shape": "circle", "radius": {"op": "param", "id": "radius"}},
                "height": {"op": "param", "id": "height"}
            }
        }"#;

        let def: ComponentDefinition = serde_json::from_str(json).expect("parse");
        assert!(def.validate().is_ok());
        assert_eq!(def.source, ComponentSource::Visual);
        assert_eq!(def.placement, PlacementKind::Point);
        assert!(matches!(
            def.params[1].kind,
            crate::param::ParamKind::Length
        ));

        let params = def.resolve_params(&ParamMap::new()).expect("defaults");
        let profiles = ProfileLibrary::new();
        let placement = Placement::point(Vec3::ZERO);
        let mesh = evaluate_recipe(
            &def.recipe,
            &ctx(&placement, &params, &profiles),
            &no_builders(),
        )
        .expect("mesh");
        assert!((size_of(&mesh)[1] - 2.5).abs() < EPS, "height from JSON");
    }

    #[test]
    fn resolve_params_applies_this_components_schema() {
        let def = ComponentDefinition {
            id: "acme.thing".into(),
            display_name: "Thing".into(),
            category: "generic".into(),
            source: ComponentSource::Visual,
            placement: PlacementKind::Point,
            params: vec![ParamSpec {
                id: "style".into(),
                label: "Style".into(),
                kind: ParamKind::Choice {
                    options: vec!["a".into(), "b".into()],
                },
                default: ParamValue::Choice("a".into()),
                min: None,
                max: None,
                unit: None,
                binding: crate::param::ParamBinding::Instance,
            }],
            recipe: GeometryRecipe::Custom {
                builder_id: "x".into(),
            },
        };

        let resolved = def.resolve_params(&ParamMap::new()).expect("defaults");
        assert_eq!(resolved.text("style"), Some("a"));
        assert!(def
            .resolve_params(&ParamMap::new().with("style", ParamValue::Text("z".into())))
            .is_err());
    }

    #[test]
    fn compile_sketch_replaces_the_spec_with_a_driven_polygon() {
        use crate::sketch::{ProfileSketch, SketchDimension};

        let mut profile = ProfileType {
            id: "user.drawn".into(),
            display_name: "Drawn".into(),
            category: "wall".into(),
            params: vec![
                ParamSpec::length("thickness", "Thickness", 0.2).as_type(),
                ParamSpec::length("height", "Height", 3.0),
            ],
            spec: ProfileSpec::Circle {
                radius: Expr::constant(1.0),
                segments: 8,
            },
            type_values: ParamMap::new(),
            formulas: Default::default(),
            sketch: Some(ProfileSketch {
                vertices: vec![[0.0, 0.0], [0.2, 0.0], [0.2, 3.0], [0.0, 3.0]],
                dimensions: vec![
                    SketchDimension {
                        edge: 0,
                        param: "thickness".into(),
                    },
                    SketchDimension {
                        edge: 1,
                        param: "height".into(),
                    },
                ],
            }),
        };
        profile.compile_sketch().expect("compile");
        assert!(matches!(profile.spec, ProfileSpec::Polygon { .. }));
        profile.validate().expect("valid");

        let params = profile.merge_eval_params(&ParamMap::new()).expect("merge");
        let geom = profile
            .spec
            .evaluate(&params, &ProfileLibrary::new())
            .expect("geom");
        let (min, max) = geom.bounds();
        assert!((max[0] - min[0] - 0.2).abs() < EPS);
        assert!((max[1] - min[1] - 3.0).abs() < EPS);
    }
}
