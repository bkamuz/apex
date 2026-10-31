//! IFC4 export and import for Apex projects.
//!
//! **Export** writes tessellated `IfcTriangulatedFaceSet` meshes for components
//! plus extruded `IfcSpace` volumes from plan spaces. Semantic type comes from
//! `ComponentDefinition.ifc_entity` (or a fallback mapping by category /
//! explicit [`IfcMapping`]), so plugins extend export without per-type branches
//! in the shell.
//!
//! Hosted `IfcOpeningElement` children emit `IfcRelVoidsElement` against their
//! parent when both products export. Doors/windows stay `IfcDoor`/`IfcWindow`
//! with the host mesh already CSG-cut (no separate opening + `IfcRelFillsElement`
//! yet — see gaps in the AP-34 notes).
//!
//! **Import** parses STEP Physical Files, resolves storeys and products with
//! triangulated / faceted / extruded geometry (including composite-curve
//! profiles and mapped items), applies `IfcUnitAssignment` length scale, and
//! places `apex.ifc.mesh` instances into a fresh project.

mod import;
mod parse;

pub use import::{
    import_ifc4_into, import_meshes_into, ImportError, ImportStats, MeshImportLevel,
    MeshImportPayload, MeshImportProduct,
};

use std::collections::BTreeMap;
use std::fmt::Write as _;

use apex_core::{
    ComponentDefinition, Element, ElementId, Level, Project, Space, TriangleMesh,
    IFC_MESH_COMPONENT,
};
use apex_geometry::Curve;
use glam::Vec3;
use uuid::Uuid;

/// Optional overrides: component id → IFC entity type name (`IfcWall`, …).
pub type IfcMapping = BTreeMap<String, String>;

/// Export the live project as an IFC4 STEP file string.
pub fn export_ifc4(project: &Project, mapping: &IfcMapping) -> String {
    let mut out = String::new();
    write_file(&mut out, project, mapping);
    out
}

fn write_file(out: &mut String, project: &Project, mapping: &IfcMapping) {
    let mut ids = IdGen::new();
    writeln!(out, "ISO-10303-21;").ok();
    writeln!(out, "HEADER;").ok();
    writeln!(
        out,
        "FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');"
    )
    .ok();
    writeln!(
        out,
        "FILE_NAME('apex-export.ifc','{}',('Apex'),('Apex'),'Apex','Apex','');",
        iso_timestamp()
    )
    .ok();
    writeln!(out, "FILE_SCHEMA(('IFC4'));").ok();
    writeln!(out, "ENDSEC;").ok();
    writeln!(out, "DATA;").ok();

    let project_id = ids.next();
    let owner_hist = ids.next();
    let person = ids.next();
    let org = ids.next();
    let person_org = ids.next();
    let app = ids.next();
    let unit_assign = ids.next();
    let area_unit = ids.next();
    let volume_unit = ids.next();
    let plane_angle = ids.next();
    let si_length = ids.next();
    let geo_ctx = ids.next();
    let world = ids.next();
    let dir_x = ids.next();
    let dir_z = ids.next();
    let cart = ids.next();
    let site = ids.next();
    let building = ids.next();
    let local_placement_site = ids.next();
    let local_placement_bldg = ids.next();
    let relative_site = ids.next();
    let relative_bldg = ids.next();

    writeln!(out, "#{person}=IFCPERSON($,$,'ApexUser',$,$,$,$,$);").ok();
    writeln!(out, "#{org}=IFCORGANIZATION($,'Apex',$,$,$);").ok();
    writeln!(
        out,
        "#{person_org}=IFCPERSONANDORGANIZATION(#{person},#{org},$);"
    )
    .ok();
    writeln!(
        out,
        "#{app}=IFCAPPLICATION(#{org},'0.1','Apex BIM','Apex');"
    )
    .ok();
    writeln!(
        out,
        "#{owner_hist}=IFCOWNERHISTORY(#{person_org},#{app},$,.ADDED.,$,$,$,0);"
    )
    .ok();

    writeln!(out, "#{si_length}=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);").ok();
    writeln!(
        out,
        "#{area_unit}=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);"
    )
    .ok();
    writeln!(
        out,
        "#{volume_unit}=IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.);"
    )
    .ok();
    writeln!(
        out,
        "#{plane_angle}=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);"
    )
    .ok();
    writeln!(
        out,
        "#{unit_assign}=IFCUNITASSIGNMENT((#{si_length},#{area_unit},#{volume_unit},#{plane_angle}));"
    )
    .ok();

    writeln!(out, "#{dir_x}=IFCDIRECTION((1.,0.,0.));").ok();
    writeln!(out, "#{dir_z}=IFCDIRECTION((0.,0.,1.));").ok();
    writeln!(out, "#{cart}=IFCCARTESIANPOINT((0.,0.,0.));").ok();
    writeln!(
        out,
        "#{world}=IFCAXIS2PLACEMENT3D(#{cart},#{dir_z},#{dir_x});"
    )
    .ok();
    writeln!(
        out,
        "#{geo_ctx}=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-05,#{world},$);"
    )
    .ok();

    writeln!(
        out,
        "#{project_id}=IFCPROJECT('{guid}',#{owner_hist},'Apex Project',$,$,$,$,(#{geo_ctx}),#{unit_assign});",
        guid = new_guid()
    )
    .ok();

    writeln!(out, "#{relative_site}=IFCAXIS2PLACEMENT3D(#{cart},$,$);").ok();
    writeln!(
        out,
        "#{local_placement_site}=IFCLOCALPLACEMENT($,#{relative_site});"
    )
    .ok();
    writeln!(
        out,
        "#{site}=IFCSITE('{guid}',#{owner_hist},'Site',$,$,#{local_placement_site},$,$,.ELEMENT.,$,$,$,$,$);",
        guid = new_guid()
    )
    .ok();

    writeln!(out, "#{relative_bldg}=IFCAXIS2PLACEMENT3D(#{cart},$,$);").ok();
    writeln!(
        out,
        "#{local_placement_bldg}=IFCLOCALPLACEMENT(#{local_placement_site},#{relative_bldg});"
    )
    .ok();
    writeln!(
        out,
        "#{building}=IFCBUILDING('{guid}',#{owner_hist},'Building',$,$,#{local_placement_bldg},$,$,.ELEMENT.,$,$,$);",
        guid = new_guid()
    )
    .ok();

    let rel_agg_site = ids.next();
    let rel_agg_bldg = ids.next();
    writeln!(
        out,
        "#{rel_agg_site}=IFCRELAGGREGATES('{guid}',#{owner_hist},$,$,#{project_id},(#{site}));",
        guid = new_guid()
    )
    .ok();
    writeln!(
        out,
        "#{rel_agg_bldg}=IFCRELAGGREGATES('{guid}',#{owner_hist},$,$,#{site},(#{building}));",
        guid = new_guid()
    )
    .ok();

    let mut levels: Vec<Level> = project.document().levels().cloned().collect();
    levels.sort_by(|a, b| {
        a.elevation
            .partial_cmp(&b.elevation)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.name.cmp(&b.name))
    });

    let mut storey_ids: BTreeMap<String, usize> = BTreeMap::new();
    let mut storey_list = Vec::new();
    for level in &levels {
        let storey = ids.next();
        let place = ids.next();
        let axis = ids.next();
        let pt = ids.next();
        // IFC Z-up; Apex Y-up — storey elevation maps to IFC Z.
        writeln!(
            out,
            "#{pt}=IFCCARTESIANPOINT((0.,0.,{z:.6}));",
            z = level.elevation
        )
        .ok();
        writeln!(out, "#{axis}=IFCAXIS2PLACEMENT3D(#{pt},$,$);").ok();
        writeln!(
            out,
            "#{place}=IFCLOCALPLACEMENT(#{local_placement_bldg},#{axis});"
        )
        .ok();
        let name = escape(&level.name);
        writeln!(
            out,
            "#{storey}=IFCBUILDINGSTOREY('{guid}',#{owner_hist},'{name}',$,$,#{place},$,$,.ELEMENT.,{elev:.6});",
            guid = new_guid(),
            elev = level.elevation
        )
        .ok();
        storey_ids.insert(level.id.to_string(), storey);
        storey_list.push(storey);
    }

    if !storey_list.is_empty() {
        let rel = ids.next();
        let list = storey_list
            .iter()
            .map(|id| format!("#{id}"))
            .collect::<Vec<_>>()
            .join(",");
        writeln!(
            out,
            "#{rel}=IFCRELAGGREGATES('{guid}',#{owner_hist},$,$,#{building},({list}));",
            guid = new_guid()
        )
        .ok();
    }

    let body_ctx = ids.next();
    writeln!(
        out,
        "#{body_ctx}=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#{geo_ctx},$,.MODEL_VIEW.,$);"
    )
    .ok();

    let mut contained: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
    let mut product_by_element: BTreeMap<ElementId, usize> = BTreeMap::new();
    let mut opening_children: Vec<(ElementId, ElementId)> = Vec::new();

    for element in project.document().elements() {
        let Some(mesh) = project.document().get_mesh(element.id) else {
            continue;
        };
        if mesh.is_empty() {
            continue;
        }
        let def = project.registry().get(&element.component_id);
        let entity = resolve_ifc_entity(element, def, mapping);
        let product = write_product(out, &mut ids, owner_hist, body_ctx, element, mesh, &entity);
        product_by_element.insert(element.id, product);
        if entity == "IfcOpeningElement" {
            if let Some(parent) = element.parent_id {
                opening_children.push((parent, element.id));
            }
        }
        let level_key = project
            .effective_level_id(element.id)
            .unwrap_or(element.level_id)
            .to_string();
        if let Some(&storey) = storey_ids.get(&level_key) {
            contained.entry(storey).or_default().push(product);
        }
    }

    for (parent_id, child_id) in opening_children {
        let (Some(&host), Some(&opening)) = (
            product_by_element.get(&parent_id),
            product_by_element.get(&child_id),
        ) else {
            continue;
        };
        let rel = ids.next();
        writeln!(
            out,
            "#{rel}=IFCRELVOIDSELEMENT('{guid}',#{owner_hist},$,$,#{host},#{opening});",
            guid = new_guid()
        )
        .ok();
    }

    let level_elev: BTreeMap<String, f64> = levels
        .iter()
        .map(|level| (level.id.to_string(), level.elevation as f64))
        .collect();

    for space in project.document().spaces() {
        let Some(product) = write_space(out, &mut ids, owner_hist, body_ctx, space, &level_elev)
        else {
            continue;
        };
        let level_key = space.level_id.to_string();
        if let Some(&storey) = storey_ids.get(&level_key) {
            contained.entry(storey).or_default().push(product);
        }
    }

    for (storey, products) in contained {
        if products.is_empty() {
            continue;
        }
        let rel = ids.next();
        let list = products
            .iter()
            .map(|id| format!("#{id}"))
            .collect::<Vec<_>>()
            .join(",");
        writeln!(
            out,
            "#{rel}=IFCRELCONTAINEDINSPATIALSTRUCTURE('{guid}',#{owner_hist},$,$,({list}),#{storey});",
            guid = new_guid()
        )
        .ok();
    }

    writeln!(out, "ENDSEC;").ok();
    writeln!(out, "END-ISO-10303-21;").ok();
}

/// Plan space → `IfcSpace` with an extruded footprint (Apex Y-up → IFC Z-up).
fn write_space(
    out: &mut String,
    ids: &mut IdGen,
    owner_hist: usize,
    body_ctx: usize,
    space: &Space,
    level_elev: &BTreeMap<String, f64>,
) -> Option<usize> {
    let ring = space_ring_points(space)?;
    let height = space
        .resolved_params()
        .number("height")
        .filter(|h| *h > 1e-4)
        .unwrap_or(2.5);
    let elev = level_elev
        .get(&space.level_id.to_string())
        .copied()
        .unwrap_or(0.0);

    let product = ids.next();
    let place = ids.next();
    let axis = ids.next();
    let origin = ids.next();
    let shape = ids.next();
    let rep = ids.next();
    let solid = ids.next();
    let profile = ids.next();
    let polyline = ids.next();
    let extrude_dir = ids.next();
    let solid_pos = ids.next();
    let solid_origin = ids.next();

    // Storey-relative placement at the level elevation (IFC Z-up).
    writeln!(out, "#{origin}=IFCCARTESIANPOINT((0.,0.,{elev:.6}));").ok();
    writeln!(out, "#{axis}=IFCAXIS2PLACEMENT3D(#{origin},$,$);").ok();
    writeln!(out, "#{place}=IFCLOCALPLACEMENT($,#{axis});").ok();

    let mut poly_pts = Vec::new();
    for p in &ring {
        let pt = ids.next();
        // Apex plan XZ → IFC local XY of the extruded profile.
        let x = p.x as f64;
        let y = -p.z as f64;
        writeln!(out, "#{pt}=IFCCARTESIANPOINT(({x:.6},{y:.6}));").ok();
        poly_pts.push(pt);
    }
    // Close the ring.
    if let Some(first) = poly_pts.first().copied() {
        poly_pts.push(first);
    }
    let poly_list = poly_pts
        .iter()
        .map(|id| format!("#{id}"))
        .collect::<Vec<_>>()
        .join(",");
    writeln!(out, "#{polyline}=IFCPOLYLINE(({poly_list}));").ok();
    writeln!(
        out,
        "#{profile}=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#{polyline});"
    )
    .ok();
    writeln!(out, "#{solid_origin}=IFCCARTESIANPOINT((0.,0.,0.));").ok();
    writeln!(
        out,
        "#{solid_pos}=IFCAXIS2PLACEMENT3D(#{solid_origin},$,$);"
    )
    .ok();
    writeln!(out, "#{extrude_dir}=IFCDIRECTION((0.,0.,1.));").ok();
    writeln!(
        out,
        "#{solid}=IFCEXTRUDEDAREASOLID(#{profile},#{solid_pos},#{extrude_dir},{height:.6});"
    )
    .ok();
    writeln!(
        out,
        "#{rep}=IFCSHAPEREPRESENTATION(#{body_ctx},'Body','SweptSolid',(#{solid}));"
    )
    .ok();
    writeln!(out, "#{shape}=IFCPRODUCTDEFINITIONSHAPE($,$,(#{rep}));").ok();

    let params = space.resolved_params();
    let label = params
        .text("label")
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(space.name.as_str());
    let name = escape(label);
    writeln!(
        out,
        "#{product}=IFCSPACE('{guid}',#{owner_hist},'{name}',$,$,#{place},#{shape},$,.ELEMENT.,.SPACE.,$);",
        guid = new_guid(),
    )
    .ok();
    Some(product)
}

fn space_ring_points(space: &Space) -> Option<Vec<Vec3>> {
    let curve = space.placement.curve()?;
    let Curve::Polyline { points } = curve else {
        return None;
    };
    let ring: Vec<Vec3> = if points.len() > 3 && points.first() == points.last() {
        points[..points.len() - 1].to_vec()
    } else {
        points.to_vec()
    };
    if ring.len() < 3 {
        return None;
    }
    Some(ring)
}

fn write_product(
    out: &mut String,
    ids: &mut IdGen,
    owner_hist: usize,
    body_ctx: usize,
    element: &Element,
    mesh: &TriangleMesh,
    entity: &str,
) -> usize {
    let product = ids.next();
    let place = ids.next();
    let axis = ids.next();
    let origin = ids.next();
    let shape = ids.next();
    let rep_map = ids.next();
    let face_set = ids.next();
    let coords = ids.next();

    // Identity placement; mesh points are already in world Y-up → convert to Z-up.
    writeln!(out, "#{origin}=IFCCARTESIANPOINT((0.,0.,0.));").ok();
    writeln!(out, "#{axis}=IFCAXIS2PLACEMENT3D(#{origin},$,$);").ok();
    writeln!(out, "#{place}=IFCLOCALPLACEMENT($,#{axis});").ok();

    let mut points = String::new();
    for chunk in mesh.positions.as_chunks::<3>().0 {
        let x = chunk[0];
        let y = -chunk[2];
        let z = chunk[1];
        if !points.is_empty() {
            points.push(',');
        }
        write!(points, "({x:.6},{y:.6},{z:.6})").ok();
    }
    writeln!(out, "#{coords}=IFCCARTESIANPOINTLIST3D(({points}));").ok();

    let mut faces = String::new();
    for tri in mesh.indices.as_chunks::<3>().0 {
        if !faces.is_empty() {
            faces.push(',');
        }
        write!(
            faces,
            "({a},{b},{c})",
            a = tri[0] + 1,
            b = tri[1] + 1,
            c = tri[2] + 1
        )
        .ok();
    }
    writeln!(
        out,
        "#{face_set}=IFCTRIANGULATEDFACESET(#{coords},$,.F.,({faces}),$);"
    )
    .ok();
    writeln!(
        out,
        "#{rep_map}=IFCSHAPEREPRESENTATION(#{body_ctx},'Body','Tessellation',(#{face_set}));"
    )
    .ok();
    writeln!(out, "#{shape}=IFCPRODUCTDEFINITIONSHAPE($,$,(#{rep_map}));").ok();

    let name = escape(&element.name);
    let tag = entity_tag(entity);
    writeln!(
        out,
        "#{product}={tag}('{guid}',#{owner_hist},'{name}',$,$,#{place},#{shape},$);",
        guid = new_guid(),
    )
    .ok();
    product
}

fn entity_tag(entity: &str) -> String {
    match entity {
        "IfcWall" => "IFCWALL",
        "IfcSlab" => "IFCSLAB",
        "IfcColumn" => "IFCCOLUMN",
        "IfcBeam" => "IFCBEAM",
        "IfcDoor" => "IFCDOOR",
        "IfcWindow" => "IFCWINDOW",
        "IfcRoof" => "IFCROOF",
        "IfcStair" => "IFCSTAIR",
        "IfcOpeningElement" => "IFCOPENINGELEMENT",
        "IfcSpace" => "IFCSPACE",
        "IfcFlowSegment" => "IFCFLOWSEGMENT",
        "IfcCableCarrierSegment" => "IFCCABLECARRIERSEGMENT",
        _ => "IFCBUILDINGELEMENTPROXY",
    }
    .into()
}

fn resolve_ifc_entity(
    element: &Element,
    def: Option<&ComponentDefinition>,
    mapping: &IfcMapping,
) -> String {
    if let Some(mapped) = mapping.get(&element.component_id) {
        return mapped.clone();
    }
    // Imported IFC meshes carry the original entity on `ifc_type`.
    if element.component_id == IFC_MESH_COMPONENT {
        if let Some(t) = element.params.text("ifc_type") {
            if !t.is_empty() {
                return t.to_string();
            }
        }
    }
    if let Some(def) = def {
        if let Some(entity) = &def.ifc_entity {
            return entity.clone();
        }
        return match def.category.as_str() {
            "wall" => "IfcWall",
            "slab" => "IfcSlab",
            "column" => "IfcColumn",
            "beam" => "IfcBeam",
            "opening" => "IfcOpeningElement",
            "stair" => "IfcStair",
            "roof" => "IfcRoof",
            c if c.starts_with("mep.") => "IfcFlowSegment",
            _ => "IfcBuildingElementProxy",
        }
        .to_string();
    }
    "IfcBuildingElementProxy".into()
}

fn escape(value: &str) -> String {
    value.replace('\\', "\\\\").replace('\'', "''")
}

fn new_guid() -> String {
    Uuid::new_v4().simple().to_string().to_uppercase()
}

fn iso_timestamp() -> String {
    "2026-01-01T00:00:00".into()
}

struct IdGen {
    next: usize,
}

impl IdGen {
    fn new() -> Self {
        Self { next: 1 }
    }

    fn next(&mut self) -> usize {
        let id = self.next;
        self.next += 1;
        id
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use apex_core::{ParamMap, Placement};
    use glam::Vec3;

    #[test]
    fn empty_project_writes_valid_step_wrapper() {
        let project = Project::new();
        let text = export_ifc4(&project, &IfcMapping::new());
        assert!(text.starts_with("ISO-10303-21;"));
        assert!(text.contains("END-ISO-10303-21;"));
        assert!(text.contains("IFCPROJECT"));
        assert!(text.contains("IFCBUILDINGSTOREY"));
    }

    #[test]
    fn wall_exports_as_ifcwall_with_triangulation() {
        let mut project = Project::new();
        project
            .create_element(
                "apex.wall",
                Placement::line(Vec3::ZERO, Vec3::new(4.0, 0.0, 0.0)),
                ParamMap::new(),
            )
            .expect("wall");
        let text = export_ifc4(&project, &IfcMapping::new());
        assert!(text.contains("IFCWALL"));
        assert!(text.contains("IFCTRIANGULATEDFACESET"));
        assert!(text.contains("IFCRELCONTAINEDINSPATIALSTRUCTURE"));
    }

    #[test]
    fn space_exports_as_ifcspace_extrusion() {
        use apex_core::PlacementKind;
        use apex_geometry::Frame;

        let mut project = Project::new();
        let ground = Frame::horizontal(0.0);
        let placement = PlacementKind::Polyline
            .build(
                &[
                    Vec3::ZERO,
                    Vec3::new(4.0, 0.0, 0.0),
                    Vec3::new(4.0, 0.0, 3.0),
                    Vec3::new(0.0, 0.0, 3.0),
                ],
                0.0,
                &ground,
            )
            .expect("placement");
        project
            .create_space(
                placement,
                ParamMap::new().with("label", apex_core::ParamValue::Text("Kitchen".into())),
            )
            .expect("space");
        let text = export_ifc4(&project, &IfcMapping::new());
        assert!(text.contains("IFCSPACE"));
        assert!(text.contains("IFCEXTRUDEDAREASOLID"));
        assert!(text.contains("IFCARBITRARYCLOSEDPROFILEDEF"));
        assert!(text.contains("'Kitchen'"));
        assert!(text.contains("IFCRELCONTAINEDINSPATIALSTRUCTURE"));
    }

    #[test]
    fn slab_opening_exports_rel_voids() {
        let mut project = Project::new();
        let slab_pts = [
            Vec3::new(0.0, 0.0, 0.0),
            Vec3::new(6.0, 0.0, 0.0),
            Vec3::new(6.0, 0.0, 4.0),
            Vec3::new(0.0, 0.0, 4.0),
        ];
        let slab_placement = project
            .placement_from_points("apex.slab", &slab_pts, 0.0)
            .expect("slab placement");
        let slab = project
            .create_element("apex.slab", slab_placement, ParamMap::new())
            .expect("slab");
        let opening_pts = [
            Vec3::new(2.0, 0.0, 1.0),
            Vec3::new(3.0, 0.0, 1.0),
            Vec3::new(3.0, 0.0, 2.0),
            Vec3::new(2.0, 0.0, 2.0),
        ];
        let opening_placement = project
            .placement_from_points("apex.slab_opening", &opening_pts, 0.0)
            .expect("opening placement");
        let opening = project
            .create_element_with_parent(
                "apex.slab_opening",
                opening_placement,
                ParamMap::new(),
                Some(slab),
            )
            .expect("opening");
        assert_eq!(
            project.document().get_element(opening).unwrap().parent_id,
            Some(slab)
        );
        let text = export_ifc4(&project, &IfcMapping::new());
        assert!(text.contains("IFCSLAB"), "missing IFCSLAB");
        assert!(
            text.contains("IFCOPENINGELEMENT"),
            "missing IFCOPENINGELEMENT"
        );
        assert!(
            text.contains("IFCRELVOIDSELEMENT"),
            "missing IFCRELVOIDSELEMENT"
        );
    }
}
