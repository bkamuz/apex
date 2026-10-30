//! Tessellated mesh component used by IFC import.
//!
//! Geometry lives in the `_mesh` text param as JSON `{ "p": [...], "i": [...] }`
//! in the element's local frame (placement origin). The inspector hides params
//! whose id starts with `_`.

use apex_geometry::TriangleMesh;
use glam::Vec3;
use serde::Deserialize;

use crate::component::{
    ComponentDefinition, ComponentSource, GeometryRecipe, MeshBuilder, PlacementOptions,
    RecipeContext, RecipeError,
};
use crate::descriptor::Descriptor;
use crate::param::{ParamMap, ParamSpec, ParamValue};
use crate::placement::PlacementKind;

/// Built-in component id for imported IFC tessellations.
pub const IFC_MESH_COMPONENT: &str = "apex.ifc.mesh";

#[derive(Debug, Deserialize)]
struct MeshJson {
    p: Vec<f32>,
    i: Vec<u32>,
}

/// Decode the compact tessellation JSON stored on IFC mesh instances.
pub fn decode_ifc_mesh_json(text: &str) -> Option<TriangleMesh> {
    let parsed: MeshJson = serde_json::from_str(text).ok()?;
    if parsed.p.len() < 9 || parsed.i.len() < 3 {
        return None;
    }
    Some(mesh_from_indexed(&parsed.p, &parsed.i))
}

/// Build the world-space mesh for an IFC instance from its params + placement origin.
pub fn ifc_mesh_from_params(params: &ParamMap) -> Option<TriangleMesh> {
    let text = params.text("_mesh")?;
    decode_ifc_mesh_json(text)
}

pub fn ifc_mesh_definition() -> ComponentDefinition {
    ComponentDefinition {
        opening: None,
        default_species: None,
        genus: None,
        id: IFC_MESH_COMPONENT.into(),
        display_name: "IFC mesh".into(),
        category: "ifc".into(),
        source: ComponentSource::BuiltIn,
        placement: PlacementKind::Point,
        placement_options: PlacementOptions {
            min_points: Some(1),
            closed: false,
            seat_on_level: false,
        },
        params: vec![
            ParamSpec::text("ifc_type", "IFC type", "IfcBuildingElementProxy"),
            ParamSpec::text("source_name", "Source name", ""),
            // Hidden in the inspector (id starts with `_`); carries tessellation.
            ParamSpec::text("_mesh", "Mesh", ""),
        ],
        recipe: GeometryRecipe::Custom {
            builder_id: "apex.ifc.mesh".into(),
        },
        descriptor: Descriptor::new(
            "Tessellated product imported from IFC. Geometry is stored as a triangle mesh; not parametric.",
        ),
        host_cut: None,
        level_height_params: vec![],
        ifc_entity: Some("IfcBuildingElementProxy".into()),
        joinable: false,
    }
}

pub fn ifc_mesh_builder() -> Box<dyn MeshBuilder> {
    Box::new(|ctx: &RecipeContext| -> Result<TriangleMesh, RecipeError> {
        let local = ifc_mesh_from_params(ctx.params).unwrap_or_else(TriangleMesh::empty);
        let origin = ctx.placement.origin();
        Ok(offset_mesh(&local, origin))
    })
}

/// Encode a local-space mesh for the `_mesh` param.
pub fn encode_ifc_mesh_json(mesh: &TriangleMesh) -> String {
    serde_json::json!({ "p": mesh.positions, "i": mesh.indices }).to_string()
}

pub fn encode_ifc_mesh_param(mesh: &TriangleMesh) -> ParamValue {
    ParamValue::Text(encode_ifc_mesh_json(mesh))
}

fn offset_mesh(mesh: &TriangleMesh, delta: Vec3) -> TriangleMesh {
    let mut out = mesh.clone();
    for p in out.positions.chunks_mut(3) {
        p[0] += delta.x;
        p[1] += delta.y;
        p[2] += delta.z;
    }
    for p in out.edges.chunks_mut(3) {
        p[0] += delta.x;
        p[1] += delta.y;
        p[2] += delta.z;
    }
    out
}

fn mesh_from_indexed(positions: &[f32], indices: &[u32]) -> TriangleMesh {
    let mut mesh = TriangleMesh::empty();
    for tri in indices.chunks(3) {
        if tri.len() < 3 {
            continue;
        }
        let vert = |i: u32| -> Option<[f32; 3]> {
            let i = i as usize;
            Some([
                *positions.get(i * 3)?,
                *positions.get(i * 3 + 1)?,
                *positions.get(i * 3 + 2)?,
            ])
        };
        let (Some(a), Some(b), Some(c)) = (vert(tri[0]), vert(tri[1]), vert(tri[2])) else {
            continue;
        };
        let ab = Vec3::from(b) - Vec3::from(a);
        let ac = Vec3::from(c) - Vec3::from(a);
        let n = ab.cross(ac).normalize_or_zero().to_array();
        mesh.push_triangle(a, b, c, n);
        mesh.push_edge(a, b);
        mesh.push_edge(b, c);
        mesh.push_edge(c, a);
    }
    mesh
}
