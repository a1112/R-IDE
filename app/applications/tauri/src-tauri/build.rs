fn main() {
    if is_windows_msvc_target() {
        embed_windows_manifest();
        let attributes = tauri_build::Attributes::new()
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
        tauri_build::try_build(attributes).expect("failed to build Tauri application resources");
    } else {
        tauri_build::build();
    }
}

fn is_windows_msvc_target() -> bool {
    std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
}

fn embed_windows_manifest() {
    let manifest = std::path::PathBuf::from(
        std::env::var("CARGO_MANIFEST_DIR").expect("Cargo manifest directory is unavailable"),
    )
    .join("windows-app-manifest.xml");
    println!("cargo:rerun-if-changed={}", manifest.display());
    // The manifest must cover the library unit-test harness as well as the
    // application binary. Tauri's resource archive is therefore generated
    // without its duplicate default manifest on MSVC targets.
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
}
