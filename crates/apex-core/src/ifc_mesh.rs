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

/// Cosine of the feature-edge bend threshold (~20°), matching `apex_geometry`.
const FEATURE_EDGE_COS: f32 = 0.9393727; // cos(0.35 rad)
/// Quantize positions when welding IFC-Lite flat-shaded verts (mm-ish).
const WELD_Q: f32 = 1e4;

fn mesh_from_indexed(positions: &[f32], indices: &[u32]) -> TriangleMesh {
    // IFC-Lite (and many tessellators) emit unique verts per face for flat
    // shading. Weld by quantized position so opposite half-edges meet and we
    // keep silhouette / crease edges instead of every triangle diagonal.
    let mut weld: std::collections::HashMap<[i64; 3], u32> = std::collections::HashMap::new();
    let mut welded_pos: Vec<[f32; 3]> = Vec::new();
    let remap = |i: u32,
                 weld: &mut std::collections::HashMap<[i64; 3], u32>,
                 welded_pos: &mut Vec<[f32; 3]>|
     -> Option<u32> {
        let i = i as usize;
        let p = [
            *positions.get(i * 3)?,
            *positions.get(i * 3 + 1)?,
            *positions.get(i * 3 + 2)?,
        ];
        let key = [
            (p[0] * WELD_Q).round() as i64,
            (p[1] * WELD_Q).round() as i64,
            (p[2] * WELD_Q).round() as i64,
        ];
        if let Some(&id) = weld.get(&key) {
            return Some(id);
        }
        let id = welded_pos.len() as u32;
        weld.insert(key, id);
        welded_pos.push(p);
        Some(id)
    };

    let mut welded_indices: Vec<u32> = Vec::with_capacity(indices.len());
    for tri in indices.chunks(3) {
        if tri.len() < 3 {
            continue;
        }
        let (Some(a), Some(b), Some(c)) = (
            remap(tri[0], &mut weld, &mut welded_pos),
            remap(tri[1], &mut weld, &mut welded_pos),
            remap(tri[2], &mut weld, &mut welded_pos),
        ) else {
            continue;
        };
        if a == b || b == c || c == a {
            continue;
        }
        welded_indices.extend_from_slice(&[a, b, c]);
    }

    let mut mesh = TriangleMesh::empty();
    let mut face_normals: Vec<Vec3> = Vec::new();
    let mut halfedges: std::collections::HashMap<(u32, u32), usize> =
        std::collections::HashMap::new();

    for tri in welded_indices.chunks(3) {
        let a = welded_pos[tri[0] as usize];
        let b = welded_pos[tri[1] as usize];
        let c = welded_pos[tri[2] as usize];
        let ab = Vec3::from(b) - Vec3::from(a);
        let ac = Vec3::from(c) - Vec3::from(a);
        let n = ab.cross(ac).normalize_or_zero();
        let face_i = face_normals.len();
        face_normals.push(n);
        mesh.push_triangle(a, b, c, n.to_array());
        halfedges.insert((tri[0], tri[1]), face_i);
        halfedges.insert((tri[1], tri[2]), face_i);
        halfedges.insert((tri[2], tri[0]), face_i);
    }

    let mut seen: std::collections::HashSet<(u32, u32)> = std::collections::HashSet::new();
    // Prefer sharp creases, then boundaries; cap so dense tessellations stay interactive.
    const EDGE_CAP: usize = 2_048;
    let mut creases: Vec<(u32, u32)> = Vec::new();
    let mut boundaries: Vec<(u32, u32)> = Vec::new();
    for (&(a, b), &fi) in &halfedges {
        let key = if a < b { (a, b) } else { (b, a) };
        if !seen.insert(key) {
            continue;
        }
        match halfedges.get(&(b, a)) {
            Some(&fj) => {
                if face_normals[fi].dot(face_normals[fj]) < FEATURE_EDGE_COS {
                    creases.push((a, b));
                }
            }
            None => boundaries.push((a, b)),
        }
    }
    for (a, b) in creases.into_iter().chain(boundaries).take(EDGE_CAP) {
        mesh.push_edge(welded_pos[a as usize], welded_pos[b as usize]);
    }
    mesh
}
