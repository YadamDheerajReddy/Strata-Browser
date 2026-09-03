use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    // tauri_build::build() re-embeds icons/icon.ico into the .exe, but once
    // build_and_link_cef_bridge() below emits its own cargo:rerun-if-changed
    // directives, Cargo stops rerunning this script on ANY change by
    // default and only reruns for paths *something* explicitly declared —
    // and nothing declares the icons/ directory, so a plain icon swap
    // silently kept embedding the old one until the next unrelated
    // rebuild. Declaring it here closes that gap.
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build();
    build_and_link_cef_bridge();
}

/// Builds native/cef_bridge (see that directory's CMakeLists.txt) via
/// CMake, links strata against the resulting strata_cef_bridge.dll, and
/// copies it plus every CEF runtime file (libcef.dll, resource paks, ICU
/// data, locales/) next to the final Tauri binary — CEF resolves those
/// relative to the running executable, and strata_cef_bridge.dll itself
/// must be on the loader's search path for strata.exe to even start.
fn build_and_link_cef_bridge() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let bridge_dir = manifest_dir.join("..").join("native").join("cef_bridge");
    let build_dir = bridge_dir.join("build");
    let release_dir = build_dir.join("Release");

    // Only re-run CMake when the bridge itself changes, not on every Rust
    // edit — without this, Cargo's default is to re-run build.rs (and thus
    // re-invoke CMake) on ANY change anywhere in this crate.
    println!("cargo:rerun-if-changed={}", bridge_dir.join("src").display());
    println!(
        "cargo:rerun-if-changed={}",
        bridge_dir.join("include").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        bridge_dir.join("CMakeLists.txt").display()
    );

    if !build_dir.join("CMakeCache.txt").exists() {
        let status = Command::new("cmake")
            .args([
                "-G",
                "Visual Studio 17 2022",
                "-A",
                "x64",
                "-DUSE_SANDBOX=OFF",
                "-S",
                bridge_dir.to_str().unwrap(),
                "-B",
                build_dir.to_str().unwrap(),
            ])
            .status()
            .expect(
                "failed to run `cmake` for native/cef_bridge — is CMake installed and on PATH? \
                 See scripts/setup_cef.md.",
            );
        assert!(
            status.success(),
            "cmake configure failed for native/cef_bridge"
        );
    }

    let status = Command::new("cmake")
        .args([
            "--build",
            build_dir.to_str().unwrap(),
            "--config",
            "Release",
        ])
        .status()
        .expect("failed to run `cmake --build` for native/cef_bridge");
    assert!(status.success(), "cmake build failed for native/cef_bridge");

    println!("cargo:rustc-link-search=native={}", release_dir.display());
    println!("cargo:rustc-link-lib=dylib=strata_cef_bridge");

    // OUT_DIR is target/<profile>/build/strata-<hash>/out — three levels up
    // is target/<profile>, where the final strata.exe actually lands.
    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    let profile_dir = out_dir
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .expect("unexpected OUT_DIR layout");

    copy_dir_flat(&release_dir, profile_dir);
}

fn copy_dir_flat(src: &Path, dst: &Path) {
    for entry in std::fs::read_dir(src)
        .unwrap_or_else(|e| panic!("failed to read {}: {}", src.display(), e))
    {
        let entry = entry.unwrap();
        let path = entry.path();
        let dest_path = dst.join(entry.file_name());

        if path.is_dir() {
            std::fs::create_dir_all(&dest_path).ok();
            copy_dir_flat(&path, &dest_path);
            continue;
        }

        // Skip re-copying a file that's already up to date — avoids
        // re-copying the ~285MB libcef.dll on every incremental build when
        // nothing in the bridge actually changed. Size alone isn't enough
        // to prove that: a small source edit (e.g. one new field
        // assignment) can easily recompile to a byte-identical file size,
        // which silently left a stale strata_cef_bridge.dll in place here
        // across multiple rebuilds while every fix inside it appeared to
        // do nothing. Requiring the destination's mtime to be at least as
        // new as the source's closes that gap.
        let already_current = std::fs::metadata(&dest_path)
            .and_then(|dest_meta| {
                let src_meta = std::fs::metadata(&path)?;
                Ok(dest_meta.len() == src_meta.len()
                    && dest_meta.modified()? >= src_meta.modified()?)
            })
            .unwrap_or(false);

        if !already_current {
            std::fs::copy(&path, &dest_path).unwrap_or_else(|e| {
                panic!("failed to copy {} -> {}: {}", path.display(), dest_path.display(), e)
            });
        }
    }
}
