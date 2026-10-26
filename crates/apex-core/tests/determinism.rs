//! The geometry pipeline must be deterministic: the same commands give
//! byte-identical meshes on every run (no HashMap order / seed leaks).
use apex_core::Project;
use serde_json::{json, Value};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

fn ex(p: &mut Project, v: Value) -> Value {
    p.execute_json(&v.to_string()).unwrap()
}
fn id(v: &Value) -> String {
    v["id"].as_str().unwrap().to_string()
}
fn wall(p: &mut Project, pts: Value) -> String {
    id(&ex(
        p,
        json!({"op":"create_element","component":"apex.wall","points":pts}),
    ))
}

/// The MCP dogfood L-house (no attach) with a boolean niche.
fn l_house(attach: bool) -> Project {
    let mut p = Project::new();
    let ext = wall(
        &mut p,
        json!([
            [0, 0, 0],
            [12, 0, 0],
            [12, 0, 5],
            [7, 0, 5],
            [7, 0, 9],
            [0, 0, 9],
            [0, 0, 0]
        ]),
    );
    let gar = wall(
        &mut p,
        json!([[12, 0, 0], [18, 0, 0], [18, 0, 5], [12, 0, 5]]),
    );
    let w1 = wall(&mut p, json!([[0, 0, 5], [7, 0, 5]]));
    let w2 = wall(&mut p, json!([[7, 0, 0], [7, 0, 5]]));
    let w3 = wall(&mut p, json!([[3.5, 0, 0], [3.5, 0, 5]]));
    let w4 = wall(&mut p, json!([[4, 0, 5], [4, 0, 9]]));
    for (parent, x, z) in [(&ext, 9.5, 0.0), (&w2, 7.0, 2.5), (&w1, 2.0, 5.0)] {
        ex(
            &mut p,
            json!({"op":"create_element","component":"apex.door","parent":parent,"points":[[x,0,z]]}),
        );
    }
    for (x, z) in [
        (1.75, 0.0),
        (5.25, 0.0),
        (0.0, 7.0),
        (2.0, 9.0),
        (5.5, 9.0),
        (12.0, 2.5),
    ] {
        ex(
            &mut p,
            json!({"op":"create_element","component":"apex.window","parent":ext,"points":[[x,0,z]]}),
        );
    }
    ex(
        &mut p,
        json!({"op":"create_element","component":"apex.window","parent":gar,"points":[[18,0,2.5]]}),
    );
    ex(
        &mut p,
        json!({"op":"create_element","component":"apex.slab","points":[[0,0,0],[12,0,0],[12,0,5],[7,0,5],[7,0,9],[0,0,9]]}),
    );
    ex(
        &mut p,
        json!({"op":"create_element","component":"apex.roof.pitched","points":[[0,0,2.5],[12,0,2.5]],"params":{"roof_type":"hip","width":5,"overhang":0.5,"slope_by":"angle","pitch":0.5}}),
    );
    ex(
        &mut p,
        json!({"op":"create_element","component":"apex.roof.pitched","points":[[3.5,0,5],[3.5,0,9]],"params":{"roof_type":"hip","width":7,"overhang":0.5,"slope_by":"angle","pitch":0.5}}),
    );
    if attach {
        ex(
            &mut p,
            json!({"op":"attach_top","ids":[ext,gar,w1,w2,w3,w4]}),
        );
    }
    let col = ex(
        &mut p,
        json!({"op":"create_element","component":"apex.column","points":[[0,0,3]],"params":{"height":1.5}}),
    );
    ex(
        &mut p,
        json!({"op":"boolean","a":ext,"b":id(&col),"operation":"subtract"}),
    );
    p
}

/// Hash of every element mesh plus the validate result.
fn fingerprint(p: &Project) -> (u64, Value) {
    let doc = p.document();
    // Element ids are random UUIDs, so hash the sorted multiset of meshes.
    let mut hs: Vec<u64> = doc
        .elements()
        .filter_map(|e| doc.get_mesh(e.id))
        .map(|m| {
            let mut h = DefaultHasher::new();
            for f in m.positions.iter().chain(&m.normals).chain(&m.edges) {
                f.to_bits().hash(&mut h);
            }
            m.indices.hash(&mut h);
            h.finish()
        })
        .collect();
    hs.sort();
    let mut h = DefaultHasher::new();
    hs.hash(&mut h);
    let v = p.query_json(&json!({"op":"validate"}).to_string()).unwrap();
    (h.finish(), v)
}

fn check(build: impl Fn() -> Project, runs: usize) {
    let (h0, v0) = fingerprint(&build());
    for run in 1..runs {
        let (h, v) = fingerprint(&build());
        assert_eq!(v["errors"], 0, "run {run}: {v}");
        assert_eq!(h, h0, "run {run}: mesh hash differs");
    }
    assert_eq!(v0["errors"], 0, "{v0}");
}

#[test]
fn l_house_is_deterministic() {
    check(|| l_house(false), 30);
}

#[test]
fn l_house_attached_is_deterministic() {
    check(|| l_house(true), 20);
}

/// The two-storey model the Playwright `house-e2e.mjs` script draws: grid,
/// walls with doors and windows on two levels, a diagonal entrance wall, a
/// ramp-shaped slab, a stair, a pitched roof with attached gable walls.
fn e2e_house() -> Project {
    let mut p = Project::new();
    for x in [0.0, 5.0, 10.0] {
        ex(
            &mut p,
            json!({"op":"create_grid_axis","points":[[x,0,-2],[x,0,10]]}),
        );
    }
    for z in [0.0, 4.0, 8.0] {
        ex(
            &mut p,
            json!({"op":"create_grid_axis","points":[[-2,0,z],[12,0,z]]}),
        );
    }
    let storey = |p: &mut Project, entrance: bool| -> Vec<String> {
        let ext = wall(
            p,
            json!([[0, 0, 0], [10, 0, 0], [10, 0, 8], [0, 0, 8], [0, 0, 0]]),
        );
        let mid = wall(p, json!([[5, 0, 0], [5, 0, 8]]));
        let cross = wall(p, json!([[5, 0, 4], [10, 0, 4]]));
        let mut doors = vec![(&mid, 5.0, 2.0), (&mid, 5.0, 6.0)];
        if entrance {
            doors.push((&ext, 2.0, 0.0));
        }
        for (w, x, z) in doors {
            ex(
                p,
                json!({"op":"create_element","component":"apex.door","parent":w,"points":[[x,0,z]]}),
            );
        }
        let mut windows = vec![
            (7.5, 0.0),
            (10.0, 2.0),
            (10.0, 6.0),
            (7.5, 8.0),
            (2.5, 8.0),
            (0.0, 4.0),
        ];
        if !entrance {
            windows.push((2.0, 0.0));
        }
        for (x, z) in windows {
            ex(
                p,
                json!({"op":"create_element","component":"apex.window","parent":ext,"points":[[x,0,z]]}),
            );
        }
        if entrance {
            let diag = wall(p, json!([[10.8, 0, 0.8], [12.8, 0, 2.8]]));
            ex(
                p,
                json!({"op":"create_element","component":"apex.door","parent":diag,"points":[[11.3,0,1.3]]}),
            );
            ex(
                p,
                json!({"op":"create_element","component":"apex.window","parent":diag,"points":[[12.2,0,2.2]]}),
            );
        }
        let _ = cross;
        vec![ext, mid]
    };
    storey(&mut p, true);
    ex(
        &mut p,
        json!({"op":"create_element","component":"apex.slab","points":[[0,0,0],[10,0,0],[10,0,8],[0,0,8]]}),
    );
    let ramp = id(&ex(
        &mut p,
        json!({"op":"create_element","component":"apex.slab","points":[[11,0,4],[14,0,4],[14,0,7],[11,0,7]]}),
    ));
    ex(
        &mut p,
        json!({"op":"set_slab_shape","id":ramp,"shape":{"z":[0,0.6,0.6,0]}}),
    );
    ex(
        &mut p,
        json!({"op":"create_element","component":"apex.stair","points":[[1,0,1.5],[1,0,6]]}),
    );
    ex(
        &mut p,
        json!({"op":"create_level","name":"Level 1","elevation":3.0}),
    );
    ex(&mut p, json!({"op":"set_active_level","id":"Level 1"}));
    let upper = storey(&mut p, false);
    ex(
        &mut p,
        json!({"op":"create_element","component":"apex.slab","points":[[0,0,0],[10,0,0],[10,0,8],[0,0,8]]}),
    );
    let roof = id(&ex(
        &mut p,
        json!({"op":"create_element","component":"apex.roof.pitched","points":[[0,0,4],[10,0,4]]}),
    ));
    ex(&mut p, json!({"op":"attach_top","ids":upper}));
    ex(
        &mut p,
        json!({"op":"update_element","id":roof,"params":{"overhang":0.5,"eave_cut":"perpendicular"}}),
    );
    p
}

#[test]
fn e2e_house_is_deterministic() {
    check(e2e_house, 20);
}

/// Roof-attached walls joined L/T/X with different thicknesses: the cluster
/// share must be byte-identical on every run.
fn attached_joins() -> Project {
    let mut p = Project::new();
    let t = ex(
        &mut p,
        json!({"op":"create_wall_type","name":"Thick 400","thickness":0.4}),
    );
    let prof = t["profile"].as_str().unwrap().to_string();
    let a = id(&ex(
        &mut p,
        json!({"op":"create_element","component":"apex.wall","points":[[0,0,0],[8,0,0],[8,0,5]],"params":{"profile":prof}}),
    ));
    let b = wall(&mut p, json!([[8, 0, 5], [0, 0, 5], [0, 0, 0]]));
    let tee = wall(&mut p, json!([[3, 0, 0], [3, 0, 5]]));
    let x = wall(&mut p, json!([[-1, 0, 2.5], [9, 0, 2.5]]));
    ex(
        &mut p,
        json!({"op":"create_element","component":"apex.roof.pitched","points":[[0,0,2.5],[8,0,2.5]],"params":{"roof_type":"hip","width":5,"overhang":0.5,"slope_by":"angle","pitch":0.5}}),
    );
    ex(&mut p, json!({"op":"attach_top","ids":[a,b,x]}));
    let _ = tee;
    p
}

#[test]
fn attached_joins_are_deterministic() {
    check(attached_joins, 20);
}
