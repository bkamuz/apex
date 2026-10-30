//! Compile the vendored SMLib kernel and the Apex bridge into a static lib.
use std::path::PathBuf;

fn main() {
    let root =
        PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap()).join("../../third_party/smlib");
    let mut build = cc::Build::new();
    build
        .cpp(true)
        .std("c++17")
        .opt_level(2)
        .warnings(false)
        .extra_warnings(false)
        .flag_if_supported("-w")
        .flag_if_supported("-ffp-contract=off")
        .define("NDEBUG", None)
        .define("NOMINMAX", None)
        .define("SM_NO_DEBUG_CODE", None)
        .define("SM_NO_GFX_OUTPUT_CODE", None)
        .define("SM_API_EXPORTS", None)
        .include(root.join("shim"))
        .include(root.join("SMLib/inc"))
        .include(root.join("SM_API/inc"))
        .flag("-include")
        .flag("SmApiGeneral.h");
    for dir in ["SMLib/src", "SM_API/src"] {
        let mut files: Vec<_> = std::fs::read_dir(root.join(dir))
            .unwrap()
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().is_some_and(|x| x == "cpp"))
            .filter(|p| {
                let n = p.file_name().unwrap().to_string_lossy();
                n != "StdAfx.cpp" && n != "SmDllMain.cpp"
            })
            .collect();
        files.sort();
        build.files(files);
    }
    build.file(root.join("bridge/apex_smlib.cpp"));
    build.compile("apex_smlib");
    println!("cargo:rerun-if-changed=../../third_party/smlib/bridge");
    println!("cargo:rerun-if-changed=../../third_party/smlib/shim");
}
