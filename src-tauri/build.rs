fn main() {
    #[cfg(target_os = "macos")]
    {
        add_clang_runtime_link_search_path();

        // ScreenCaptureKit's Swift bridge links libswift_Concurrency.dylib via @rpath.
        println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");

        // Embed Info.plist into the binary so TCC permissions work in dev builds
        // (camera, microphone, screen recording usage descriptions).
        let plist_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("Info.plist");
        if plist_path.exists() {
            println!(
                "cargo:rustc-link-arg=-Wl,-sectcreate,__TEXT,__info_plist,{}",
                plist_path.display()
            );
        }
    }
    tauri_build::build()
}

#[cfg(target_os = "macos")]
fn add_clang_runtime_link_search_path() {
    println!("cargo:rerun-if-env-changed=CC");
    println!("cargo:rerun-if-env-changed=DEVELOPER_DIR");
    println!("cargo:rerun-if-env-changed=SDKROOT");

    let resource_dir = std::env::var("CC")
        .ok()
        .filter(|cc| !cc.trim().is_empty())
        .and_then(|cc| clang_resource_dir(&cc, &["-print-resource-dir"]))
        .or_else(|| clang_resource_dir("cc", &["-print-resource-dir"]))
        .or_else(|| clang_resource_dir("xcrun", &["clang", "-print-resource-dir"]));

    let Some(resource_dir) = resource_dir else {
        return;
    };

    let darwin_dir = resource_dir.join("lib").join("darwin");
    if darwin_dir.join("libclang_rt.osx.a").exists() {
        // Rust can retain a stale Xcode/CLT Clang runtime path after macOS toolchain
        // updates. Add the active Clang runtime path so dev builds link reliably.
        println!("cargo:rustc-link-search=native={}", darwin_dir.display());
    }
}

#[cfg(target_os = "macos")]
fn clang_resource_dir(program: &str, args: &[&str]) -> Option<std::path::PathBuf> {
    let output = std::process::Command::new(program)
        .args(args)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8(output.stdout).ok()?;
    let path = stdout.trim();
    if path.is_empty() {
        None
    } else {
        Some(std::path::PathBuf::from(path))
    }
}
