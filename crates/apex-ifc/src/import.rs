//! IFC4 (and IFC2X3-ish) import into an Apex [`Project`].
//!
//! Scope: products that expose `IfcTriangulatedFaceSet`, faceted B-rep faces,
//! extruded area solids (including `IfcCompositeCurve` profiles with line and
//! circular arc segments), and `IfcMappedItem` instances, plus
//! `IfcBuildingStorey` levels. Length units come from `IfcUnitAssignment`
//! (not an arbitrary `IfcSIUnit` in the file). Placements follow
//! `IfcLocalPlacement` chains. Geometry is converted from IFC Z-up into Apex
//! Y-up and stored on `apex.ifc.mesh` instances.

use std::collections::{BTreeMap, HashMap, HashSet};

use apex_core::{
    encode_ifc_mesh_param, ifc_mesh_from_params, Element, LevelId, ParamMap, ParamValue, Placement,
    Project, TriangleMesh, IFC_MESH_COMPONENT,
};
use glam::{Mat4, Vec3, Vec4};

use crate::parse::{parse_step, Entity, ParseError, StepFile, Value};

/// Summary returned after a successful import.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportStats {
    pub levels: usize,
    pub products: usize,
    pub skipped_no_mesh: usize,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportError(pub String);

impl std::fmt::Display for ImportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for ImportError {}

impl From<ParseError> for ImportError {
    fn from(e: ParseError) -> Self {
        Self(e.0)
    }
}

struct Storey {
    id: u64,
    name: String,
    elevation: f32,
}

struct Product {
    id: u64,
    type_name: String,
    name: String,
    placement: Option<u64>,
    representation: Option<u64>,
    storey: Option<u64>,
}

/// Replace `project` contents with geometry parsed from an IFC STEP string.
pub fn import_ifc4_into(project: &mut Project, text: &str) -> Result<ImportStats, ImportError> {
    let file = parse_step(text)?;
    let length_scale = length_scale_metres(&file);
    let storeys = collect_storeys(&file, length_scale);
    let mut products = collect_products(&file);
    assign_storeys(&file, &mut products);

    let mut warnings = Vec::new();
    if storeys.is_empty() {
        warnings.push("no IfcBuildingStorey found; using a single Level 0".into());
    }

    *project = Project::new();
    project.clear_history();

    let mut level_by_storey: HashMap<u64, LevelId> = HashMap::new();
    let default_level = project
        .document()
        .active_level_id()
        .ok_or_else(|| ImportError("fresh project has no level".into()))?;

    let level_count;
    if storeys.is_empty() {
        level_by_storey.insert(0, default_level);
        level_count = 1;
    } else {
        let mut sorted = storeys;
        sorted.sort_by(|a, b| {
            a.elevation
                .partial_cmp(&b.elevation)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.name.cmp(&b.name))
        });
        for (index, storey) in sorted.iter().enumerate() {
            let level_id = if index == 0 {
                if let Some(level) = project.document_mut().get_level_mut(default_level) {
                    level.name = storey.name.clone();
                    level.elevation = storey.elevation;
                }
                default_level
            } else {
                project.add_level(&storey.name, storey.elevation)
            };
            level_by_storey.insert(storey.id, level_id);
        }
        let _ = project.set_active_level(default_level);
        level_count = sorted.len();
    }

    let mut imported = 0usize;
    let mut skipped = 0usize;

    for product in &products {
        let Some(mesh_ifc) = product_mesh(&file, product, length_scale) else {
            skipped += 1;
            continue;
        };
        let transform = product
            .placement
            .map(|id| resolve_placement(&file, id, length_scale))
            .unwrap_or(Mat4::IDENTITY);
        let mesh_world = transform_mesh_ifc_to_apex(&mesh_ifc, transform);
        if mesh_world.is_empty() {
            skipped += 1;
            continue;
        }

        let (origin, local_mesh) = localize_mesh(&mesh_world);
        let level_id = product
            .storey
            .and_then(|s| level_by_storey.get(&s).copied())
            .or_else(|| nearest_level(project, origin.y))
            .unwrap_or(default_level);

        let mut params = ParamMap::new();
        params.set("_mesh", encode_ifc_mesh_param(&local_mesh));
        params.set(
            "ifc_type",
            ParamValue::Text(pretty_ifc_type(&product.type_name)),
        );
        if !product.name.is_empty() {
            params.set("source_name", ParamValue::Text(product.name.clone()));
        }

        let name = if product.name.is_empty() {
            format!("{} {}", pretty_ifc_type(&product.type_name), imported + 1)
        } else {
            product.name.clone()
        };
        let element = Element::new(
            name,
            IFC_MESH_COMPONENT,
            level_id,
            Placement::point(origin),
            params,
        );
        let mesh = ifc_mesh_from_params(&element.params)
            .map(|m| offset_mesh(&m, origin))
            .unwrap_or_else(|| mesh_world.clone());
        project.document_mut().upsert_element(element, mesh);
        imported += 1;
    }

    if imported == 0 {
        return Err(ImportError(
            "IFC contained no importable tessellated products \
             (need IfcTriangulatedFaceSet, faceted faces, or simple extrusions)"
                .into(),
        ));
    }

    Ok(ImportStats {
        levels: level_count,
        products: imported,
        skipped_no_mesh: skipped,
        warnings,
    })
}

fn pretty_ifc_type(type_name: &str) -> String {
    let t = type_name.trim().to_ascii_uppercase();
    match t.as_str() {
        "IFCWALL" | "IFCWALLSTANDARDCASE" => "IfcWall".into(),
        "IFCSLAB" => "IfcSlab".into(),
        "IFCCOLUMN" => "IfcColumn".into(),
        "IFCBEAM" => "IfcBeam".into(),
        "IFCDOOR" => "IfcDoor".into(),
        "IFCWINDOW" => "IfcWindow".into(),
        "IFCROOF" => "IfcRoof".into(),
        "IFCSTAIR" | "IFCSTAIRFLIGHT" => "IfcStair".into(),
        "IFCOPENINGELEMENT" => "IfcOpeningElement".into(),
        "IFCFLOWSEGMENT" => "IfcFlowSegment".into(),
        "IFCCABLECARRIERSEGMENT" => "IfcCableCarrierSegment".into(),
        "IFCBUILDINGELEMENTPROXY" | "IFCPROXY" => "IfcBuildingElementProxy".into(),
        "IFCSPACE" => "IfcSpace".into(),
        other => {
            let rest = other.strip_prefix("IFC").unwrap_or(other);
            let mut out = String::from("Ifc");
            for (i, c) in rest.chars().enumerate() {
                if i == 0 {
                    out.push(c.to_ascii_uppercase());
                } else {
                    out.push(c.to_ascii_lowercase());
                }
            }
            out
        }
    }
}

fn nearest_level(project: &Project, y: f32) -> Option<LevelId> {
    project
        .document()
        .levels()
        .min_by(|a, b| {
            (a.elevation - y)
                .abs()
                .partial_cmp(&(b.elevation - y).abs())
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .map(|l| l.id)
}

fn length_scale_metres(file: &StepFile) -> f32 {
    // Prefer units listed on IfcUnitAssignment. Scanning every IfcSIUnit is
    // wrong when a file declares both MILLI.METRE and METRE (common in Revit):
    // HashMap iteration order would flip the model by 1000×.
    let assigned: Vec<u64> = file
        .of_type("IFCUNITASSIGNMENT")
        .flat_map(|e| e.args.iter())
        .filter_map(Value::as_list)
        .flatten()
        .filter_map(Value::as_ref_id)
        .collect();
    if let Some(scale) = length_scale_from_units(file, &assigned) {
        return scale;
    }
    let all: Vec<u64> = file.of_type("IFCSIUNIT").map(|e| e.id).collect();
    length_scale_from_units(file, &all).unwrap_or(1.0)
}

fn length_scale_from_units(file: &StepFile, ids: &[u64]) -> Option<f32> {
    for &id in ids {
        let Some(unit) = file.get(id) else {
            continue;
        };
        if unit.type_name != "IFCSIUNIT" {
            continue;
        }
        let kind = unit.args.get(1).and_then(|v| match v {
            Value::Enum(s) => Some(s.as_str()),
            _ => None,
        });
        if kind != Some("LENGTHUNIT") {
            continue;
        }
        let prefix = unit.args.get(2).and_then(|v| match v {
            Value::Enum(s) => Some(s.as_str()),
            Value::Null => Some(""),
            _ => None,
        });
        let name = unit.args.get(3).and_then(|v| match v {
            Value::Enum(s) => Some(s.as_str()),
            _ => None,
        });
        if name != Some("METRE") {
            continue;
        }
        return Some(match prefix.unwrap_or("") {
            "MILLI" => 0.001,
            "CENTI" => 0.01,
            "DECI" => 0.1,
            "KILO" => 1000.0,
            _ => 1.0,
        });
    }
    None
}

fn collect_storeys(file: &StepFile, scale: f32) -> Vec<Storey> {
    file.of_type("IFCBUILDINGSTOREY")
        .map(|e| {
            let name = e
                .args
                .get(2)
                .and_then(Value::as_str)
                .unwrap_or("Storey")
                .to_string();
            let elevation = e.args.get(9).and_then(Value::as_f64).unwrap_or(0.0) as f32 * scale;
            Storey {
                id: e.id,
                name,
                elevation,
            }
        })
        .collect()
}

fn collect_products(file: &StepFile) -> Vec<Product> {
    let mut out = Vec::new();
    for entity in file.entities.values() {
        if !is_product_type(&entity.type_name) {
            continue;
        }
        let name = entity
            .args
            .get(2)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let placement = entity.args.get(5).and_then(Value::as_ref_id);
        let representation = entity.args.get(6).and_then(Value::as_ref_id);
        out.push(Product {
            id: entity.id,
            type_name: entity.type_name.clone(),
            name,
            placement,
            representation,
            storey: None,
        });
    }
    out.sort_by_key(|p| p.id);
    out
}

fn is_product_type(type_name: &str) -> bool {
    matches!(
        type_name,
        "IFCWALL"
            | "IFCWALLSTANDARDCASE"
            | "IFCSLAB"
            | "IFCCOLUMN"
            | "IFCBEAM"
            | "IFCDOOR"
            | "IFCWINDOW"
            | "IFCROOF"
            | "IFCSTAIR"
            | "IFCSTAIRFLIGHT"
            | "IFCRAILING"
            | "IFCMEMBER"
            | "IFCPLATE"
            | "IFCFOOTING"
            | "IFCPILE"
            | "IFCCURTAINWALL"
            | "IFCBUILDINGELEMENTPROXY"
            | "IFCFLOWSEGMENT"
            | "IFCFLOWFITTING"
            | "IFCFLOWTERMINAL"
            | "IFCDISTRIBUTIONELEMENT"
            | "IFCCABLECARRIERSEGMENT"
            | "IFCCOVERING"
            | "IFCFURNISHINGELEMENT"
            | "IFCSPACE"
            | "IFCOPENINGELEMENT"
            | "IFCPROXY"
    ) || type_name.starts_with("IFCBUILDINGELEMENT")
        || type_name.starts_with("IFCDISTRIBUTION")
        || type_name.starts_with("IFCFLOW")
}

fn assign_storeys(file: &StepFile, products: &mut [Product]) {
    let mut by_id: HashMap<u64, usize> = HashMap::new();
    for (i, p) in products.iter().enumerate() {
        by_id.insert(p.id, i);
    }
    for rel in file.of_type("IFCRELCONTAINEDINSPATIALSTRUCTURE") {
        let relating = rel.args.iter().rev().find_map(Value::as_ref_id);
        let related = rel
            .args
            .iter()
            .find_map(|v| v.as_list())
            .into_iter()
            .flatten()
            .filter_map(Value::as_ref_id);
        let Some(storey) = relating else {
            continue;
        };
        if file
            .get(storey)
            .is_none_or(|e| e.type_name != "IFCBUILDINGSTOREY")
        {
            continue;
        }
        for pid in related {
            if let Some(&idx) = by_id.get(&pid) {
                products[idx].storey = Some(storey);
            }
        }
    }
}

fn product_mesh(file: &StepFile, product: &Product, scale: f32) -> Option<TriangleMesh> {
    let shape_id = product.representation?;
    let shape = file.get(shape_id)?;
    let reps: Vec<u64> = shape
        .args
        .iter()
        .find_map(Value::as_list)
        .into_iter()
        .flatten()
        .filter_map(Value::as_ref_id)
        .collect();
    // Prefer solid body / tessellation contexts; Axis/FootPrint are often 2D
    // and would otherwise dilute or confuse import.
    let mut body_first = reps.clone();
    body_first.sort_by_key(|id| {
        let id = *id;
        let Some(entity) = file.get(id) else {
            return 2u8;
        };
        let ident = entity
            .args
            .get(1)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_lowercase();
        match ident.as_str() {
            "body" | "tessellation" | "facetation" | "solidmodel" | "brep" => 0,
            "box" | "boundingbox" => 2,
            _ => 1,
        }
    });
    let mut mesh = TriangleMesh::empty();
    for rep_id in body_first {
        let before = mesh.triangle_count();
        collect_representation_mesh(
            file,
            rep_id,
            scale,
            Mat4::IDENTITY,
            &mut mesh,
            &mut HashSet::new(),
        );
        // Once we have body triangles, stop — skip Axis/FootPrint overlays.
        if mesh.triangle_count() > before {
            let ident = file
                .get(rep_id)
                .and_then(|e| e.args.get(1).and_then(Value::as_str))
                .unwrap_or("")
                .to_ascii_lowercase();
            if matches!(
                ident.as_str(),
                "body" | "tessellation" | "facetation" | "solidmodel" | "brep"
            ) {
                break;
            }
        }
    }
    if mesh.is_empty() {
        None
    } else {
        Some(mesh)
    }
}

fn collect_representation_mesh(
    file: &StepFile,
    id: u64,
    scale: f32,
    local: Mat4,
    out: &mut TriangleMesh,
    visiting: &mut HashSet<u64>,
) {
    if !visiting.insert(id) {
        return;
    }
    let Some(entity) = file.get(id) else {
        return;
    };
    match entity.type_name.as_str() {
        "IFCTRIANGULATEDFACESET" => {
            if let Some(m) = triangulated_face_set(file, entity, scale) {
                out.append(&transform_mesh_local(&m, local));
            }
        }
        "IFCPOLYLOOP" => {
            if let Some(m) = poly_loop_mesh(file, entity, scale) {
                out.append(&transform_mesh_local(&m, local));
            }
        }
        "IFCEXTRUDEDAREASOLID" => {
            if let Some(m) = extruded_area_solid(file, entity, scale) {
                out.append(&transform_mesh_local(&m, local));
            }
        }
        "IFCMAPPEDITEM" => {
            // MappingSource = IfcRepresentationMap; MappingTarget = Cartesian op.
            let Some(map_id) = entity.args.first().and_then(Value::as_ref_id) else {
                return;
            };
            let op = entity
                .args
                .get(1)
                .and_then(Value::as_ref_id)
                .map(|oid| cartesian_operator_matrix(file, oid, scale))
                .unwrap_or(Mat4::IDENTITY);
            let Some(map) = file.get(map_id) else {
                return;
            };
            if map.type_name != "IFCREPRESENTATIONMAP" {
                return;
            }
            let origin = map
                .args
                .first()
                .and_then(Value::as_ref_id)
                .map(|oid| axis2placement_matrix(file, oid, scale))
                .unwrap_or(Mat4::IDENTITY);
            let Some(mapped_rep) = map.args.get(1).and_then(Value::as_ref_id) else {
                return;
            };
            // Parent space ← MappingTarget ← MappingOrigin ← mapped geometry.
            let child = local * op * origin;
            collect_representation_mesh(file, mapped_rep, scale, child, out, visiting);
        }
        "IFCBOOLEANRESULT" | "IFCBOOLEANCLIPPINGRESULT" => {
            // MVP: keep the first operand that yields triangles (no CSG yet).
            for arg in &entity.args {
                let before = out.triangle_count();
                walk_value_for_geometry(file, arg, scale, local, out, visiting);
                if out.triangle_count() > before {
                    break;
                }
            }
        }
        _ => {
            for arg in &entity.args {
                walk_value_for_geometry(file, arg, scale, local, out, visiting);
            }
        }
    }
}

fn walk_value_for_geometry(
    file: &StepFile,
    value: &Value,
    scale: f32,
    local: Mat4,
    out: &mut TriangleMesh,
    visiting: &mut HashSet<u64>,
) {
    match value {
        Value::Ref(id) => collect_representation_mesh(file, *id, scale, local, out, visiting),
        Value::List(items) => {
            for item in items {
                walk_value_for_geometry(file, item, scale, local, out, visiting);
            }
        }
        Value::Typed { inner, .. } => {
            walk_value_for_geometry(file, inner, scale, local, out, visiting)
        }
        _ => {}
    }
}

fn transform_mesh_local(mesh: &TriangleMesh, transform: Mat4) -> TriangleMesh {
    if transform == Mat4::IDENTITY {
        return mesh.clone();
    }
    let mut out = TriangleMesh::empty();
    let n_verts = mesh.vertex_count();
    let mut positions = Vec::with_capacity(mesh.positions.len());
    let mut normals = Vec::with_capacity(mesh.normals.len());
    for i in 0..n_verts {
        let p = Vec3::new(
            mesh.positions[i * 3],
            mesh.positions[i * 3 + 1],
            mesh.positions[i * 3 + 2],
        );
        let n = Vec3::new(
            mesh.normals.get(i * 3).copied().unwrap_or(0.0),
            mesh.normals.get(i * 3 + 1).copied().unwrap_or(0.0),
            mesh.normals.get(i * 3 + 2).copied().unwrap_or(1.0),
        );
        let pw = (transform * Vec4::new(p.x, p.y, p.z, 1.0)).truncate();
        let nw = (transform * Vec4::new(n.x, n.y, n.z, 0.0))
            .truncate()
            .normalize_or_zero();
        positions.extend_from_slice(&pw.to_array());
        normals.extend_from_slice(&nw.to_array());
    }
    out.positions = positions;
    out.normals = normals;
    out.indices = mesh.indices.clone();
    // Keep authoring edges (profile / shell) — do not explode every triangle
    // diagonal into the wireframe.
    out.edges = transform_edge_list(&mesh.edges, transform);
    out
}

fn transform_edge_list(edges: &[f32], transform: Mat4) -> Vec<f32> {
    let mut out = Vec::with_capacity(edges.len());
    for p in edges.chunks(3) {
        if p.len() < 3 {
            break;
        }
        let pw = (transform * Vec4::new(p[0], p[1], p[2], 1.0)).truncate();
        out.extend_from_slice(&pw.to_array());
    }
    out
}

fn cartesian_operator_matrix(file: &StepFile, id: u64, scale: f32) -> Mat4 {
    let Some(entity) = file.get(id) else {
        return Mat4::IDENTITY;
    };
    if !entity
        .type_name
        .starts_with("IFCCARTESIANTRANSFORMATIONOPERATOR")
    {
        return Mat4::IDENTITY;
    }
    let axis1 = entity
        .args
        .first()
        .and_then(Value::as_ref_id)
        .and_then(|did| direction(file, did))
        .unwrap_or(Vec3::X)
        .normalize_or_zero();
    let axis2 = entity
        .args
        .get(1)
        .and_then(Value::as_ref_id)
        .and_then(|did| direction(file, did));
    let origin = entity
        .args
        .get(2)
        .and_then(Value::as_ref_id)
        .and_then(|pid| cartesian_point(file, pid, scale))
        .unwrap_or(Vec3::ZERO);
    let scale_u = entity.args.get(3).and_then(Value::as_f64).unwrap_or(1.0) as f32;
    let axis3 = entity
        .args
        .get(4)
        .and_then(Value::as_ref_id)
        .and_then(|did| direction(file, did));

    let x = if axis1.length_squared() < 1e-12 {
        Vec3::X
    } else {
        axis1
    };
    let z = axis3
        .map(|a| a.normalize_or_zero())
        .filter(|a| a.length_squared() > 1e-12)
        .unwrap_or_else(|| {
            axis2
                .map(|y| x.cross(y).normalize_or_zero())
                .filter(|a| a.length_squared() > 1e-12)
                .unwrap_or(Vec3::Z)
        });
    let y = axis2
        .map(|a| a.normalize_or_zero())
        .filter(|a| a.length_squared() > 1e-12)
        .unwrap_or_else(|| z.cross(x).normalize_or_zero());
    let y = if y.length_squared() < 1e-12 {
        z.cross(x).normalize_or_zero()
    } else {
        y
    };
    let s = if scale_u.abs() < 1e-12 { 1.0 } else { scale_u };
    Mat4::from_cols(
        Vec4::new(x.x * s, x.y * s, x.z * s, 0.0),
        Vec4::new(y.x * s, y.y * s, y.z * s, 0.0),
        Vec4::new(z.x * s, z.y * s, z.z * s, 0.0),
        Vec4::new(origin.x, origin.y, origin.z, 1.0),
    )
}

fn triangulated_face_set(file: &StepFile, entity: &Entity, scale: f32) -> Option<TriangleMesh> {
    let coords_id = entity.args.first()?.as_ref_id()?;
    let coords = file.get(coords_id)?;
    if coords.type_name != "IFCCARTESIANPOINTLIST3D" {
        return None;
    }
    let points = coords.args.first()?.as_list()?;
    let mut positions = Vec::with_capacity(points.len() * 3);
    for pt in points {
        let xyz = pt.as_list()?;
        if xyz.len() < 3 {
            return None;
        }
        positions.push(xyz[0].as_f64()? as f32 * scale);
        positions.push(xyz[1].as_f64()? as f32 * scale);
        positions.push(xyz[2].as_f64()? as f32 * scale);
    }
    let indices_list = entity
        .args
        .get(3)
        .and_then(Value::as_list)
        .or_else(|| entity.args.get(2).and_then(Value::as_list))?;
    let mut indices = Vec::new();
    for tri in indices_list {
        let idx = tri.as_list()?;
        if idx.len() < 3 {
            continue;
        }
        let a = idx[0].as_f64()? as u32;
        let b = idx[1].as_f64()? as u32;
        let c = idx[2].as_f64()? as u32;
        if a == 0 || b == 0 || c == 0 {
            continue;
        }
        indices.push(a - 1);
        indices.push(b - 1);
        indices.push(c - 1);
    }
    let mut mesh = mesh_from_indexed(&positions, &indices);
    // Drop per-triangle edges so the IFC→Apex transform can emit a boundary
    // wireframe instead of triangulation diagonals.
    mesh.edges.clear();
    Some(mesh)
}

fn poly_loop_mesh(file: &StepFile, entity: &Entity, scale: f32) -> Option<TriangleMesh> {
    let points = entity.args.first()?.as_list()?;
    let mut ring = Vec::new();
    for pref in points {
        let id = pref.as_ref_id()?;
        ring.push(cartesian_point(file, id, scale)?);
    }
    if ring.len() < 3 {
        return None;
    }
    let mut mesh = TriangleMesh::empty();
    let normal = polygon_normal(&ring);
    for i in 1..ring.len().saturating_sub(1) {
        mesh.push_triangle(
            ring[0].to_array(),
            ring[i].to_array(),
            ring[i + 1].to_array(),
            normal.to_array(),
        );
        mesh.push_edge(ring[i].to_array(), ring[i + 1].to_array());
    }
    mesh.push_edge(ring[0].to_array(), ring[1].to_array());
    mesh.push_edge(ring[ring.len() - 1].to_array(), ring[0].to_array());
    Some(mesh)
}

fn extruded_area_solid(file: &StepFile, entity: &Entity, scale: f32) -> Option<TriangleMesh> {
    let profile_id = entity.args.first()?.as_ref_id()?;
    let position_id = entity.args.get(1).and_then(Value::as_ref_id);
    let dir_id = entity.args.get(2).and_then(Value::as_ref_id)?;
    let depth = entity.args.get(3).and_then(Value::as_f64)? as f32 * scale;
    if depth.abs() < 1e-6 {
        return None;
    }
    let dir = direction(file, dir_id)?.normalize_or_zero();
    if dir.length_squared() < 1e-12 {
        return None;
    }
    let profile = profile_xy(file, profile_id, scale)?;
    if profile.len() < 3 {
        return None;
    }
    let placement = position_id
        .map(|id| axis2placement_matrix(file, id, scale))
        .unwrap_or(Mat4::IDENTITY);

    let bottom: Vec<Vec3> = profile
        .iter()
        .map(|p| (placement * Vec4::new(p.x, p.y, 0.0, 1.0)).truncate())
        .collect();
    let extrude = if (dir - Vec3::Z).length() < 1e-4 {
        (placement * Vec4::new(0.0, 0.0, depth, 0.0)).truncate()
    } else {
        let world_dir = (placement * Vec4::new(dir.x, dir.y, dir.z, 0.0))
            .truncate()
            .normalize_or_zero();
        world_dir * depth
    };
    let top: Vec<Vec3> = bottom.iter().map(|p| *p + extrude).collect();
    let mut mesh = TriangleMesh::empty();
    let n_bot = -extrude.normalize_or_zero();
    let n_top = extrude.normalize_or_zero();
    for i in 1..bottom.len().saturating_sub(1) {
        mesh.push_triangle(
            bottom[0].to_array(),
            bottom[i + 1].to_array(),
            bottom[i].to_array(),
            n_bot.to_array(),
        );
        mesh.push_triangle(
            top[0].to_array(),
            top[i].to_array(),
            top[i + 1].to_array(),
            n_top.to_array(),
        );
    }
    for i in 0..bottom.len() {
        let j = (i + 1) % bottom.len();
        let a = bottom[i];
        let b = bottom[j];
        let c = top[j];
        let d = top[i];
        let n = (b - a).cross(d - a).normalize_or_zero();
        mesh.push_triangle(a.to_array(), b.to_array(), c.to_array(), n.to_array());
        mesh.push_triangle(a.to_array(), c.to_array(), d.to_array(), n.to_array());
        mesh.push_edge(a.to_array(), b.to_array());
        mesh.push_edge(d.to_array(), c.to_array());
        mesh.push_edge(a.to_array(), d.to_array());
    }
    Some(mesh)
}

fn profile_xy(file: &StepFile, id: u64, scale: f32) -> Option<Vec<Vec3>> {
    let entity = file.get(id)?;
    match entity.type_name.as_str() {
        "IFCRECTANGLEPROFILEDEF" => {
            let xdim = entity.args.get(3).and_then(Value::as_f64)? as f32 * scale;
            let ydim = entity.args.get(4).and_then(Value::as_f64)? as f32 * scale;
            let pos = entity
                .args
                .get(2)
                .and_then(Value::as_ref_id)
                .map(|pid| axis2placement_matrix(file, pid, scale))
                .unwrap_or(Mat4::IDENTITY);
            let hx = xdim * 0.5;
            let hy = ydim * 0.5;
            let corners = [
                Vec3::new(-hx, -hy, 0.0),
                Vec3::new(hx, -hy, 0.0),
                Vec3::new(hx, hy, 0.0),
                Vec3::new(-hx, hy, 0.0),
            ];
            Some(
                corners
                    .into_iter()
                    .map(|p| (pos * Vec4::new(p.x, p.y, p.z, 1.0)).truncate())
                    .collect(),
            )
        }
        "IFCCIRCLEPROFILEDEF" => {
            let radius = entity.args.get(3).and_then(Value::as_f64)? as f32 * scale;
            let pos = entity
                .args
                .get(2)
                .and_then(Value::as_ref_id)
                .map(|pid| axis2placement_matrix(file, pid, scale))
                .unwrap_or(Mat4::IDENTITY);
            let n = 24;
            Some(
                (0..n)
                    .map(|i| {
                        let a = (i as f32) / (n as f32) * std::f32::consts::TAU;
                        let p = Vec3::new(radius * a.cos(), radius * a.sin(), 0.0);
                        (pos * Vec4::new(p.x, p.y, p.z, 1.0)).truncate()
                    })
                    .collect(),
            )
        }
        "IFCARBITRARYCLOSEDPROFILEDEF" | "IFCARBITRARYPROFILEDEFWITHVOIDS" => {
            let curve_id = entity.args.get(2).and_then(Value::as_ref_id)?;
            polyline_from_curve(file, curve_id, scale)
        }
        _ => None,
    }
}

fn polyline_from_curve(file: &StepFile, id: u64, scale: f32) -> Option<Vec<Vec3>> {
    let entity = file.get(id)?;
    match entity.type_name.as_str() {
        "IFCPOLYLINE" => {
            let pts = entity.args.first()?.as_list()?;
            let mut out = Vec::new();
            for pref in pts {
                out.push(cartesian_point(file, pref.as_ref_id()?, scale)?);
            }
            if out.len() >= 2 && (out[0] - *out.last().unwrap()).length() < 1e-5 {
                out.pop();
            }
            Some(out)
        }
        "IFCINDEXEDPOLYCURVE" => {
            let list_id = entity.args.first()?.as_ref_id()?;
            let list = file.get(list_id)?;
            let points = list.args.first()?.as_list()?;
            let mut out = Vec::new();
            for pt in points {
                let xy = pt.as_list()?;
                out.push(Vec3::new(
                    xy.first()?.as_f64()? as f32 * scale,
                    xy.get(1)?.as_f64()? as f32 * scale,
                    0.0,
                ));
            }
            Some(out)
        }
        "IFCCOMPOSITECURVE" => composite_curve_xy(file, entity, scale),
        "IFCTRIMMEDCURVE" => trimmed_curve_xy(file, entity, scale),
        "IFCCIRCLE" => {
            // Full circle fallback (closed profile).
            let mut pts = circle_arc_xy(file, id, scale, 0.0, std::f32::consts::TAU, true)?;
            if pts.len() > 1 {
                pts.pop(); // drop duplicate close for profile rings
            }
            Some(pts)
        }
        _ => None,
    }
}

fn composite_curve_xy(file: &StepFile, entity: &Entity, scale: f32) -> Option<Vec<Vec3>> {
    let segments = entity.args.first()?.as_list()?;
    let mut out = Vec::new();
    for seg_ref in segments {
        let seg_id = seg_ref.as_ref_id()?;
        let seg = file.get(seg_id)?;
        if seg.type_name != "IFCCOMPOSITECURVESEGMENT"
            && seg.type_name != "IFCCOMPOSITECURVESEGMENTS"
        {
            // Some exporters nest the parent curve directly.
            if let Some(pts) = polyline_from_curve(file, seg_id, scale) {
                append_ring_points(&mut out, &pts);
            }
            continue;
        }
        let same_sense = seg
            .args
            .get(1)
            .map(|v| match v {
                Value::Enum(s) => s.eq_ignore_ascii_case("T") || s.eq_ignore_ascii_case("TRUE"),
                _ => true,
            })
            .unwrap_or(true);
        let parent_id = seg.args.get(2).and_then(Value::as_ref_id)?;
        let mut pts = polyline_from_curve(file, parent_id, scale)?;
        if !same_sense {
            pts.reverse();
        }
        append_ring_points(&mut out, &pts);
    }
    if out.len() >= 2 && (out[0] - *out.last().unwrap()).length() < 1e-4 * scale.max(1.0) {
        out.pop();
    }
    if out.len() < 3 {
        None
    } else {
        Some(out)
    }
}

fn append_ring_points(out: &mut Vec<Vec3>, pts: &[Vec3]) {
    if pts.is_empty() {
        return;
    }
    let start = if out.last().is_some_and(|p| (*p - pts[0]).length() < 1e-4) {
        1
    } else {
        0
    };
    out.extend_from_slice(&pts[start..]);
}

fn trimmed_curve_xy(file: &StepFile, entity: &Entity, scale: f32) -> Option<Vec<Vec3>> {
    let basis_id = entity.args.first().and_then(Value::as_ref_id)?;
    let basis = file.get(basis_id)?;
    let sense = entity
        .args
        .get(3)
        .map(|v| match v {
            Value::Enum(s) => s.eq_ignore_ascii_case("T") || s.eq_ignore_ascii_case("TRUE"),
            _ => true,
        })
        .unwrap_or(true);
    match basis.type_name.as_str() {
        "IFCCIRCLE" => {
            let t1 = trim_parameter(entity.args.get(1)?)?;
            let t2 = trim_parameter(entity.args.get(2)?)?;
            circle_arc_xy(file, basis_id, scale, t1, t2, sense)
        }
        "IFCPOLYLINE" => polyline_from_curve(file, basis_id, scale),
        _ => None,
    }
}

fn trim_parameter(value: &Value) -> Option<f32> {
    match value {
        Value::List(items) => items.iter().find_map(trim_parameter),
        Value::Typed { type_name, inner } => {
            if type_name.eq_ignore_ascii_case("IFCPARAMETERVALUE")
                || type_name.eq_ignore_ascii_case("IFCPLANEANGLEMEASURE")
            {
                inner.as_f64().map(|v| v as f32)
            } else {
                trim_parameter(inner)
            }
        }
        Value::Float(v) => Some(*v as f32),
        Value::Int(v) => Some(*v as f32),
        _ => None,
    }
}

/// Tessellate a circular arc in the profile plane.
///
/// Trim parameters are plane angles. Revit IFC2x3 commonly writes degrees even
/// when the unit assignment claims radians — values with |θ| > 2π+ε are treated
/// as degrees.
fn circle_arc_xy(
    file: &StepFile,
    circle_id: u64,
    scale: f32,
    trim1: f32,
    trim2: f32,
    sense: bool,
) -> Option<Vec<Vec3>> {
    let circle = file.get(circle_id)?;
    if circle.type_name != "IFCCIRCLE" {
        return None;
    }
    let pos_id = circle.args.first().and_then(Value::as_ref_id)?;
    let radius = circle.args.get(1).and_then(Value::as_f64)? as f32 * scale;
    if radius < 1e-9 {
        return None;
    }
    let placement = axis2placement_matrix(file, pos_id, scale);
    let to_rad = |v: f32| {
        if v.abs() > std::f32::consts::TAU + 0.1 {
            v.to_radians()
        } else {
            v
        }
    };
    let mut a0 = to_rad(trim1);
    let mut a1 = to_rad(trim2);
    if !sense {
        std::mem::swap(&mut a0, &mut a1);
    }
    // Sweep in the sense direction (increasing angle when sense is true).
    let mut delta = a1 - a0;
    if sense {
        while delta <= 1e-6 {
            delta += std::f32::consts::TAU;
        }
        while delta > std::f32::consts::TAU + 1e-4 {
            delta -= std::f32::consts::TAU;
        }
    } else {
        while delta >= -1e-6 {
            delta -= std::f32::consts::TAU;
        }
        while delta < -std::f32::consts::TAU - 1e-4 {
            delta += std::f32::consts::TAU;
        }
    }
    let segs = ((delta.abs() / std::f32::consts::TAU) * 32.0)
        .ceil()
        .max(4.0) as usize;
    let mut out = Vec::with_capacity(segs + 1);
    for i in 0..=segs {
        let t = i as f32 / segs as f32;
        let a = a0 + delta * t;
        let local = Vec3::new(radius * a.cos(), radius * a.sin(), 0.0);
        out.push((placement * Vec4::new(local.x, local.y, local.z, 1.0)).truncate());
    }
    Some(out)
}

fn cartesian_point(file: &StepFile, id: u64, scale: f32) -> Option<Vec3> {
    let entity = file.get(id)?;
    let coords = entity.args.first()?.as_list()?;
    let x = coords.first()?.as_f64()? as f32 * scale;
    let y = coords.get(1)?.as_f64()? as f32 * scale;
    let z = coords.get(2).and_then(Value::as_f64).unwrap_or(0.0) as f32 * scale;
    Some(Vec3::new(x, y, z))
}

fn direction(file: &StepFile, id: u64) -> Option<Vec3> {
    let entity = file.get(id)?;
    let coords = entity.args.first()?.as_list()?;
    Some(Vec3::new(
        coords.first()?.as_f64()? as f32,
        coords.get(1)?.as_f64()? as f32,
        coords.get(2).and_then(Value::as_f64).unwrap_or(0.0) as f32,
    ))
}

fn resolve_placement(file: &StepFile, id: u64, scale: f32) -> Mat4 {
    let mut chain = Vec::new();
    let mut current = Some(id);
    let mut guard = 0;
    while let Some(cid) = current {
        guard += 1;
        if guard > 64 {
            break;
        }
        let Some(entity) = file.get(cid) else {
            break;
        };
        if entity.type_name != "IFCLOCALPLACEMENT" {
            break;
        }
        let parent = entity.args.first().and_then(Value::as_ref_id);
        let relative = entity.args.get(1).and_then(Value::as_ref_id);
        if let Some(rel) = relative {
            chain.push(axis2placement_matrix(file, rel, scale));
        }
        current = parent;
    }
    let mut mat = Mat4::IDENTITY;
    for local in chain.into_iter().rev() {
        mat *= local;
    }
    mat
}

fn axis2placement_matrix(file: &StepFile, id: u64, scale: f32) -> Mat4 {
    let Some(entity) = file.get(id) else {
        return Mat4::IDENTITY;
    };
    let origin = entity
        .args
        .first()
        .and_then(Value::as_ref_id)
        .and_then(|pid| cartesian_point(file, pid, scale))
        .unwrap_or(Vec3::ZERO);
    if entity.type_name == "IFCAXIS2PLACEMENT2D" {
        let x = entity
            .args
            .get(1)
            .and_then(Value::as_ref_id)
            .and_then(|did| direction(file, did))
            .unwrap_or(Vec3::X)
            .normalize_or_zero();
        let x = if x.length_squared() < 1e-12 {
            Vec3::X
        } else {
            x
        };
        let y = Vec3::new(-x.y, x.x, 0.0);
        let z = Vec3::Z;
        return Mat4::from_cols(
            Vec4::new(x.x, x.y, x.z, 0.0),
            Vec4::new(y.x, y.y, y.z, 0.0),
            Vec4::new(z.x, z.y, z.z, 0.0),
            Vec4::new(origin.x, origin.y, origin.z, 1.0),
        );
    }
    let axis = entity
        .args
        .get(1)
        .and_then(Value::as_ref_id)
        .and_then(|did| direction(file, did))
        .unwrap_or(Vec3::Z)
        .normalize_or_zero();
    let z = if axis.length_squared() < 1e-12 {
        Vec3::Z
    } else {
        axis
    };
    let ref_dir = entity
        .args
        .get(2)
        .and_then(Value::as_ref_id)
        .and_then(|did| direction(file, did))
        .unwrap_or(Vec3::X);
    let mut x = (ref_dir - z * ref_dir.dot(z)).normalize_or_zero();
    if x.length_squared() < 1e-12 {
        x = z.any_orthonormal_vector();
    }
    let y = z.cross(x).normalize_or_zero();
    Mat4::from_cols(
        Vec4::new(x.x, x.y, x.z, 0.0),
        Vec4::new(y.x, y.y, y.z, 0.0),
        Vec4::new(z.x, z.y, z.z, 0.0),
        Vec4::new(origin.x, origin.y, origin.z, 1.0),
    )
}

fn transform_mesh_ifc_to_apex(mesh: &TriangleMesh, transform: Mat4) -> TriangleMesh {
    let mut out = TriangleMesh::empty();
    let n_verts = mesh.vertex_count();
    let mut positions = Vec::with_capacity(mesh.positions.len());
    let mut normals = Vec::with_capacity(mesh.normals.len());
    for i in 0..n_verts {
        let p = Vec3::new(
            mesh.positions[i * 3],
            mesh.positions[i * 3 + 1],
            mesh.positions[i * 3 + 2],
        );
        let n = Vec3::new(
            mesh.normals.get(i * 3).copied().unwrap_or(0.0),
            mesh.normals.get(i * 3 + 1).copied().unwrap_or(0.0),
            mesh.normals.get(i * 3 + 2).copied().unwrap_or(1.0),
        );
        let pw = (transform * Vec4::new(p.x, p.y, p.z, 1.0)).truncate();
        let nw = (transform * Vec4::new(n.x, n.y, n.z, 0.0))
            .truncate()
            .normalize_or_zero();
        // IFC Z-up → Apex Y-up: (x, y, z)_ifc → (x, z, -y)_apex
        positions.push(pw.x);
        positions.push(pw.z);
        positions.push(-pw.y);
        normals.push(nw.x);
        normals.push(nw.z);
        normals.push(-nw.y);
    }
    out.positions = positions;
    out.normals = normals;
    out.indices = mesh.indices.clone();
    if mesh.edges.is_empty() {
        // Tessellated face sets often carry no feature edges — keep a boundary
        // wireframe (edges used by exactly one triangle) instead of every
        // triangulation diagonal.
        out.edges = boundary_edges_from_indices(&out.positions, &out.indices);
    } else {
        for p in mesh.edges.chunks(3) {
            if p.len() < 3 {
                break;
            }
            let pw = (transform * Vec4::new(p[0], p[1], p[2], 1.0)).truncate();
            out.edges.push(pw.x);
            out.edges.push(pw.z);
            out.edges.push(-pw.y);
        }
    }
    out
}

fn boundary_edges_from_indices(positions: &[f32], indices: &[u32]) -> Vec<f32> {
    let mut counts: BTreeMap<(u32, u32), u32> = BTreeMap::new();
    for tri in indices.chunks(3) {
        if tri.len() < 3 {
            continue;
        }
        for (a, b) in [(tri[0], tri[1]), (tri[1], tri[2]), (tri[2], tri[0])] {
            let key = if a < b { (a, b) } else { (b, a) };
            *counts.entry(key).or_default() += 1;
        }
    }
    let mut edges = Vec::new();
    for ((a, b), count) in counts {
        if count != 1 {
            continue;
        }
        let ai = (a as usize) * 3;
        let bi = (b as usize) * 3;
        if ai + 3 > positions.len() || bi + 3 > positions.len() {
            continue;
        }
        edges.extend_from_slice(&positions[ai..ai + 3]);
        edges.extend_from_slice(&positions[bi..bi + 3]);
    }
    edges
}

fn localize_mesh(mesh: &TriangleMesh) -> (Vec3, TriangleMesh) {
    let Some((min, max)) = mesh.aabb() else {
        return (Vec3::ZERO, mesh.clone());
    };
    let origin = Vec3::new(
        (min[0] + max[0]) * 0.5,
        (min[1] + max[1]) * 0.5,
        (min[2] + max[2]) * 0.5,
    );
    (origin, offset_mesh(mesh, -origin))
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

fn polygon_normal(ring: &[Vec3]) -> Vec3 {
    let mut n = Vec3::ZERO;
    for i in 0..ring.len() {
        let a = ring[i];
        let b = ring[(i + 1) % ring.len()];
        n += a.cross(b);
    }
    n.normalize_or_zero()
}

/// One storey contributed by an external tessellator (IFC-Lite, web-ifc, …).
///
/// Elevations and mesh coordinates must already be in **Apex Y-up metres**.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct MeshImportLevel {
    pub name: String,
    pub elevation: f32,
}

/// One triangle mesh product from an external tessellator.
///
/// `positions` are local to `origin` (world = local + origin). Indices are
/// triangle lists. Optional `level_index` indexes into [`MeshImportPayload::levels`].
#[derive(Debug, Clone, serde::Deserialize)]
pub struct MeshImportProduct {
    pub name: String,
    pub ifc_type: String,
    pub origin: [f32; 3],
    pub positions: Vec<f32>,
    pub indices: Vec<u32>,
    #[serde(default)]
    pub level_index: Option<usize>,
}

/// Payload for [`import_meshes_into`] — pre-tessellated IFC products.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct MeshImportPayload {
    #[serde(default)]
    pub levels: Vec<MeshImportLevel>,
    pub products: Vec<MeshImportProduct>,
}

/// Replace `project` with externally tessellated IFC meshes (already Y-up metres).
pub fn import_meshes_into(
    project: &mut Project,
    payload: MeshImportPayload,
) -> Result<ImportStats, ImportError> {
    if payload.products.is_empty() {
        return Err(ImportError(
            "IFC mesh import contained no products".into(),
        ));
    }

    let mut warnings = Vec::new();
    if payload.levels.is_empty() {
        warnings.push("no storeys provided; using a single Level 0".into());
    }

    *project = Project::new();
    project.clear_history();

    let default_level = project
        .document()
        .active_level_id()
        .ok_or_else(|| ImportError("fresh project has no level".into()))?;

    let mut level_ids: Vec<LevelId> = Vec::new();
    let level_count;
    if payload.levels.is_empty() {
        level_ids.push(default_level);
        level_count = 1;
    } else {
        let mut sorted: Vec<(usize, &MeshImportLevel)> =
            payload.levels.iter().enumerate().collect();
        sorted.sort_by(|(_, a), (_, b)| {
            a.elevation
                .partial_cmp(&b.elevation)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.name.cmp(&b.name))
        });
        // Map original index → LevelId after sort-stable creation order by elevation.
        let mut by_orig: Vec<Option<LevelId>> = vec![None; payload.levels.len()];
        for (created, (orig_i, storey)) in sorted.iter().enumerate() {
            let level_id = if created == 0 {
                if let Some(level) = project.document_mut().get_level_mut(default_level) {
                    level.name = storey.name.clone();
                    level.elevation = storey.elevation;
                }
                default_level
            } else {
                project.add_level(&storey.name, storey.elevation)
            };
            by_orig[*orig_i] = Some(level_id);
        }
        level_ids = by_orig.into_iter().map(|id| id.expect("level")).collect();
        let _ = project.set_active_level(default_level);
        level_count = payload.levels.len();
    }

    let mut imported = 0usize;
    let mut skipped = 0usize;

    for product in &payload.products {
        if product.positions.len() < 9 || product.indices.len() < 3 {
            skipped += 1;
            continue;
        }
        let origin = Vec3::from_array(product.origin);
        let mut params = ParamMap::new();
        // Encode via decode path so feature edges are regenerated consistently.
        let mesh_json = serde_json::json!({
            "p": product.positions,
            "i": product.indices,
        })
        .to_string();
        let local_mesh = apex_core::decode_ifc_mesh_json(&mesh_json).unwrap_or_else(|| {
            let mut empty = TriangleMesh::empty();
            empty.positions = product.positions.clone();
            empty.indices = product.indices.clone();
            empty
        });
        if local_mesh.is_empty() {
            skipped += 1;
            continue;
        }
        params.set("_mesh", encode_ifc_mesh_param(&local_mesh));
        params.set(
            "ifc_type",
            ParamValue::Text(pretty_ifc_type(&product.ifc_type)),
        );
        if !product.name.is_empty() {
            params.set("source_name", ParamValue::Text(product.name.clone()));
        }

        let level_id = product
            .level_index
            .and_then(|i| level_ids.get(i).copied())
            .or_else(|| nearest_level(project, origin.y))
            .unwrap_or(default_level);

        let name = if product.name.is_empty() {
            format!(
                "{} {}",
                pretty_ifc_type(&product.ifc_type),
                imported + 1
            )
        } else {
            product.name.clone()
        };
        let element = Element::new(
            name,
            IFC_MESH_COMPONENT,
            level_id,
            Placement::point(origin),
            params,
        );
        let mesh = ifc_mesh_from_params(&element.params)
            .map(|m| offset_mesh(&m, origin))
            .unwrap_or_else(|| offset_mesh(&local_mesh, origin));
        project.document_mut().upsert_element(element, mesh);
        imported += 1;
    }

    if imported == 0 {
        return Err(ImportError(
            "IFC mesh import produced no elements (all products empty or invalid)".into(),
        ));
    }

    Ok(ImportStats {
        levels: level_count,
        products: imported,
        skipped_no_mesh: skipped,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use apex_core::ParamMap;
    use glam::Vec3;

    #[test]
    fn round_trip_apex_export_import() {
        let mut project = Project::new();
        project
            .create_element(
                "apex.wall",
                Placement::line(Vec3::ZERO, Vec3::new(4.0, 0.0, 0.0)),
                ParamMap::new(),
            )
            .expect("wall");
        let ifc = crate::export_ifc4(&project, &Default::default());
        let mut imported = Project::new();
        let stats = import_ifc4_into(&mut imported, &ifc).expect("import");
        assert!(stats.products >= 1, "stats={stats:?}");
        assert!(imported.document().elements().count() >= 1);
        assert!(imported
            .document()
            .elements()
            .any(|e| e.component_id == IFC_MESH_COMPONENT));
        let mesh = imported
            .document()
            .elements()
            .find_map(|e| imported.document().get_mesh(e.id))
            .expect("mesh");
        assert!(!mesh.is_empty());
    }

    #[test]
    fn imports_demo_box_fixture() {
        let text = include_str!("../tests/fixtures/demo-box.ifc");
        let mut project = Project::new();
        let stats = import_ifc4_into(&mut project, text).expect("import fixture");
        assert_eq!(stats.products, 1);
        assert_eq!(stats.levels, 1);
        let element = project.document().elements().next().expect("element");
        assert_eq!(element.component_id, IFC_MESH_COMPONENT);
        assert_eq!(element.params.text("ifc_type"), Some("IfcWall"));
        let mesh = project.document().get_mesh(element.id).expect("mesh");
        assert!(mesh.triangle_count() >= 12);
        let (mn, mx) = mesh.aabb().expect("aabb");
        // 4 × 3 × 2.7 m box in IFC → Apex Y-up extents ~4 × 2.7 × 3.
        assert!((mx[0] - mn[0] - 4.0).abs() < 1e-3, "dx {:?}", mx[0] - mn[0]);
        assert!((mx[1] - mn[1] - 2.7).abs() < 1e-3, "dy {:?}", mx[1] - mn[1]);
        assert!((mx[2] - mn[2] - 3.0).abs() < 1e-3, "dz {:?}", mx[2] - mn[2]);
    }

    #[test]
    fn millimetre_unit_assignment_scales_to_metres() {
        let text = include_str!("../tests/fixtures/demo-box-mm.ifc");
        let mut project = Project::new();
        let stats = import_ifc4_into(&mut project, text).expect("import mm fixture");
        assert_eq!(stats.products, 1);
        let mesh = project
            .document()
            .elements()
            .find_map(|e| project.document().get_mesh(e.id))
            .expect("mesh");
        let (mn, mx) = mesh.aabb().expect("aabb");
        // Same physical size as the metre fixture — not 1000× larger.
        assert!((mx[0] - mn[0] - 4.0).abs() < 1e-2, "dx {:?}", mx[0] - mn[0]);
        assert!((mx[1] - mn[1] - 2.7).abs() < 1e-2, "dy {:?}", mx[1] - mn[1]);
        assert!((mx[2] - mn[2] - 3.0).abs() < 1e-2, "dz {:?}", mx[2] - mn[2]);
    }

    #[test]
    fn prefers_assigned_milli_over_sibling_metre_si_unit() {
        // Both MILLI.METRE and METRE appear as IfcSIUnit; only the assigned one
        // must win (Revit-style files).
        let text = r#"
ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('units.ifc','2026-10-30',('Apex'),('Apex'),'Apex','Apex','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPERSON($,$,'ApexUser',$,$,$,$,$);
#2=IFCORGANIZATION($,'Apex',$,$,$);
#3=IFCPERSONANDORGANIZATION(#1,#2,$);
#4=IFCAPPLICATION(#2,'0.1','Apex BIM','Apex');
#5=IFCOWNERHISTORY(#3,#4,$,.ADDED.,$,$,$,0);
#6=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#7=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#8=IFCUNITASSIGNMENT((#6));
#9=IFCDIRECTION((1.,0.,0.));
#10=IFCDIRECTION((0.,0.,1.));
#11=IFCCARTESIANPOINT((0.,0.,0.));
#12=IFCAXIS2PLACEMENT3D(#11,#10,#9);
#13=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-05,#12,$);
#14=IFCPROJECT('PROJ0001',#5,'Demo',$,$,$,$,(#13),#8);
#15=IFCAXIS2PLACEMENT3D(#11,$,$);
#16=IFCLOCALPLACEMENT($,#15);
#17=IFCSITE('SITE0001',#5,'Site',$,$,#16,$,$,.ELEMENT.,$,$,$,$,$);
#18=IFCAXIS2PLACEMENT3D(#11,$,$);
#19=IFCLOCALPLACEMENT(#16,#18);
#20=IFCBUILDING('BLDG0001',#5,'Building',$,$,#19,$,$,.ELEMENT.,$,$,$);
#21=IFCAXIS2PLACEMENT3D(#11,$,$);
#22=IFCLOCALPLACEMENT(#19,#21);
#23=IFCBUILDINGSTOREY('STOR0001',#5,'Level 0',$,$,#22,$,$,.ELEMENT.,0.);
#24=IFCRELAGGREGATES('REL0001',#5,$,$,#14,(#17));
#25=IFCRELAGGREGATES('REL0002',#5,$,$,#17,(#20));
#26=IFCRELAGGREGATES('REL0003',#5,$,$,#20,(#23));
#27=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#13,$,.MODEL_VIEW.,$);
#28=IFCCARTESIANPOINTLIST3D(((0.0,0.0,0.0),(1000.0,0.0,0.0),(1000.0,1000.0,0.0),(0.0,1000.0,0.0),(0.0,0.0,1000.0),(1000.0,0.0,1000.0),(1000.0,1000.0,1000.0),(0.0,1000.0,1000.0)));
#29=IFCTRIANGULATEDFACESET(#28,$,.F.,((1,2,3),(1,3,4),(5,7,6),(5,8,7),(1,5,6),(1,6,2),(2,6,7),(2,7,3),(3,7,8),(3,8,4),(4,8,5),(4,5,1)),$);
#30=IFCSHAPEREPRESENTATION(#27,'Body','Tessellation',(#29));
#31=IFCPRODUCTDEFINITIONSHAPE($,$,(#30));
#32=IFCAXIS2PLACEMENT3D(#11,$,$);
#33=IFCLOCALPLACEMENT($,#32);
#34=IFCWALL('WALL0001',#5,'Unit wall',$,$,#33,#31,$);
#35=IFCRELCONTAINEDINSPATIALSTRUCTURE('REL0004',#5,$,$,(#34),#23);
ENDSEC;
END-ISO-10303-21;
"#;
        let mut project = Project::new();
        let stats = import_ifc4_into(&mut project, text).expect("import");
        assert_eq!(stats.products, 1);
        let mesh = project
            .document()
            .elements()
            .find_map(|e| project.document().get_mesh(e.id))
            .expect("mesh");
        let (mn, mx) = mesh.aabb().expect("aabb");
        let dx = mx[0] - mn[0];
        let dy = mx[1] - mn[1];
        let dz = mx[2] - mn[2];
        assert!(
            (dx - 1.0).abs() < 1e-3 && (dy - 1.0).abs() < 1e-3 && (dz - 1.0).abs() < 1e-3,
            "expected 1 m cube, got {dx}×{dy}×{dz}"
        );
    }

    #[test]
    fn import_meshes_places_y_up_products_on_storeys() {
        // Unit square in XZ at local y=0, placed at world y=3.1 (level 2).
        let payload = MeshImportPayload {
            levels: vec![
                MeshImportLevel {
                    name: "Level 1".into(),
                    elevation: 0.0,
                },
                MeshImportLevel {
                    name: "Level 2".into(),
                    elevation: 3.1,
                },
            ],
            products: vec![MeshImportProduct {
                name: "Wall A".into(),
                ifc_type: "IfcWall".into(),
                origin: [1.0, 3.1, 2.0],
                positions: vec![
                    -0.5, 0.0, -0.1, 0.5, 0.0, -0.1, 0.5, 0.0, 0.1, -0.5, 0.0, 0.1, -0.5, 2.0,
                    -0.1, 0.5, 2.0, -0.1, 0.5, 2.0, 0.1, -0.5, 2.0, 0.1,
                ],
                indices: vec![0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6],
                level_index: Some(1),
            }],
        };
        let mut project = Project::new();
        let stats = import_meshes_into(&mut project, payload).expect("import");
        assert_eq!(stats.levels, 2);
        assert_eq!(stats.products, 1);
        let element = project.document().elements().next().expect("element");
        assert_eq!(element.name, "Wall A");
        let level = project
            .document()
            .get_level(element.level_id)
            .expect("level");
        assert_eq!(level.name, "Level 2");
        assert!((level.elevation - 3.1).abs() < 1e-4);
    }
}
