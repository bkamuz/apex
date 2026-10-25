use apex_core::Project;
use apex_core::ProjectSnapshot;

#[test]
fn browser_snap_imports() {
    let raw = include_str!("browser_snap.json");
    let snap: ProjectSnapshot = serde_json::from_str(raw).expect("deserialize browser export");
    let mut project = Project::new();
    project.import_snapshot(snap).expect("import browser snap");
    assert_eq!(project.sheets().count(), 1);
}
