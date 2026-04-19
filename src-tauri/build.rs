fn main() {
    #[cfg(target_os = "macos")]
    {
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
