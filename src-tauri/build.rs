fn main() {
    #[cfg(target_os = "macos")]
    {
        println!("cargo:rerun-if-changed=src/macos_notifications.m");
        cc::Build::new()
            .file("src/macos_notifications.m")
            .flag("-fobjc-arc")
            .flag("-mmacosx-version-min=11.0")
            .compile("doberman_notifications");
        println!("cargo:rustc-link-lib=objc");
        println!("cargo:rustc-link-lib=framework=Foundation");
        println!("cargo:rustc-link-lib=framework=UserNotifications");
    }

    tauri_build::build()
}
