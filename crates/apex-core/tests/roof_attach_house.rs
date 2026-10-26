//! Regression: an L-shaped wall with tee-joined interior walls under two
//! hip roofs (the dogfood house) must clip, not keep its extension.
use apex_core::Project;
use serde_json::json;
fn ex(p: &mut Project, v: serde_json::Value) -> serde_json::Value {
    p.execute_json(&v.to_string()).unwrap()
}
#[test]
fn l_house_with_tee_walls_attaches_cleanly() {
    // Join winners are deterministic now; repeat anyway as a cheap guard
    // against order leaks (see tests/determinism.rs).
    for _ in 0..12 {
        house();
    }
}

fn house() {
    let mut p = Project::new();
    let mut ids = vec![];
    for pts in [
        json!([
            [0, 0, 0],
            [12, 0, 0],
            [12, 0, 5],
            [7, 0, 5],
            [7, 0, 9],
            [0, 0, 9],
            [0, 0, 0]
        ]),
        json!([[0, 0, 5], [7, 0, 5]]),
        json!([[7, 0, 0], [7, 0, 5]]),
        json!([[3.5, 0, 0], [3.5, 0, 5]]),
        json!([[4, 0, 5], [4, 0, 9]]),
    ] {
        let r = ex(
            &mut p,
            json!({"op":"create_element","component":"apex.wall","points":pts}),
        );
        ids.push(r["id"].as_str().unwrap().to_string());
    }
    ex(
        &mut p,
        json!({"op":"create_element","component":"apex.roof.pitched","points":[[0,0,2.5],[12,0,2.5]],"params":{"roof_type":"hip","width":5,"overhang":0.5,"slope_by":"angle","pitch":0.5}}),
    );
    ex(
        &mut p,
        json!({"op":"create_element","component":"apex.roof.pitched","points":[[3.5,0,5],[3.5,0,9]],"params":{"roof_type":"hip","width":7,"overhang":0.5,"slope_by":"angle","pitch":0.5}}),
    );
    // A niche: a column subtracted from the L (the boolean must stay closed
    // whichever way the tee joins pinch the L's corner).
    let col = ex(
        &mut p,
        json!({"op":"create_element","component":"apex.column","points":[[0,0,3]],"params":{"height":1.5}}),
    );
    let niche = ex(
        &mut p,
        json!({"op":"boolean","a":ids[0],"b":col["id"],"operation":"subtract"}),
    );
    ex(&mut p, json!({"op":"attach_top","ids":ids}));
    let v = p.query_json(&json!({"op":"validate"}).to_string()).unwrap();
    assert_eq!(v["errors"], 0, "{v}");
    for id in &ids[1..] {
        let mesh = p.document().get_mesh(id.parse().unwrap()).expect("mesh");
        let top = mesh
            .positions
            .chunks(3)
            .map(|v| v[1])
            .fold(f32::MIN, f32::max);
        // r1 underside ridge ~4.37 is the highest any wall may reach.
        assert!(top < 4.40, "wall {id} pokes through the roof: top {top}");
    }
    // The L's eave wall along z=0 stays under the eave, not at the ridge.
    // The L renders through its boolean.
    let ext = p
        .document()
        .get_mesh(niche["id"].as_str().unwrap().parse().unwrap())
        .unwrap();
    // Along z=0 the underside rises inward from the 3 m eave line, so the
    // inner face must climb a little above 3 m (unclipped = exactly 3 m).
    let top = ext
        .positions
        .chunks(3)
        .filter(|v| v[2] < 0.2)
        .map(|v| v[1])
        .fold(f32::MIN, f32::max);
    assert!(top > 3.02 && top < 3.2, "eave wall top {top}");
}
