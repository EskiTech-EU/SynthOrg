//! The i2pd router is linked into the app on Android: the static libraries
//! made by native/i2pd/build.sh, for the ABI being built.
use std::io::Write;

/// The certificates i2pd checks the reseed servers with, put inside the app:
/// on Android what the package holds cannot be read as files, and the router
/// wants them in its folder. They are written there at the first start.
fn certificates() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("native").join("i2pd").join("out").join("certificates");
    let out = std::path::Path::new(&std::env::var("OUT_DIR").unwrap()).join("certificates.rs");
    let mut file = std::fs::File::create(&out).unwrap();
    writeln!(file, "pub static CERTIFICATES: &[(&str, &[u8])] = &[").unwrap();
    fn walk(dir: &std::path::Path, base: &std::path::Path, file: &mut std::fs::File) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        let mut entries: Vec<_> = entries.filter_map(Result::ok).collect();
        entries.sort_by_key(|e| e.path());
        for entry in entries {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, base, file);
            } else {
                let name = path.strip_prefix(base).unwrap().to_string_lossy().replace('\\', "/");
                writeln!(file, "    ({:?}, include_bytes!({:?})),", name, path.canonicalize().unwrap().to_string_lossy()).unwrap();
            }
        }
    }
    walk(&root, &root, &mut file);
    writeln!(file, "];").unwrap();
    println!("cargo:rerun-if-changed={}", root.display());
}

fn main() {
    certificates();
    let target = std::env::var("TARGET").unwrap_or_default();
    if target.contains("android") {
        let abi = if target.starts_with("aarch64") { "arm64-v8a" } else if target.starts_with("x86_64") { "x86_64" } else { panic!("ABI non supportata per i2pd: {target}") };
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("native").join("i2pd").join("out").join(abi).join("lib");
        if !dir.join("libi2pd_shim.a").exists() {
            panic!("Mancano le librerie di i2pd in {}: eseguire native/i2pd/build.sh in WSL.", dir.display());
        }
        // One group: the libraries of i2pd refer to one another in both directions.
        println!("cargo:rustc-link-arg=-Wl,--start-group");
        for lib in ["i2pd_shim", "i2pddaemon", "i2pdclient", "i2pd", "i2pdlang", "boost_program_options", "boost_filesystem", "boost_atomic", "ssl", "crypto"] {
            println!("cargo:rustc-link-arg={}", dir.join(format!("lib{lib}.a")).display());
        }
        println!("cargo:rustc-link-arg=-Wl,--end-group");
        println!("cargo:rustc-link-lib=c++_static");
        println!("cargo:rustc-link-lib=c++abi");
        // Pages of 16 KB, as on the newest phones and on the emulator.
        println!("cargo:rustc-link-arg=-Wl,-z,max-page-size=16384");
        for lib in ["z", "log", "dl", "m"] {
            println!("cargo:rustc-link-lib={lib}");
        }
        println!("cargo:rerun-if-changed={}", dir.display());
    }
    tauri_build::build()
}
