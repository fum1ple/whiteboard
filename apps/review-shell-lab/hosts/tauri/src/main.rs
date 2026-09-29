#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::webview::WebviewWindowBuilder;
use tauri::WebviewUrl;

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let target = std::env::var("WHITEBOARD_SHELL_LAB_URL")
                .expect("WHITEBOARD_SHELL_LAB_URL must name the local review shell");
            let profile = std::env::var("WHITEBOARD_SHELL_LAB_PROFILE_DIR")
                .expect("WHITEBOARD_SHELL_LAB_PROFILE_DIR must name an isolated profile");
            std::fs::create_dir_all(&profile)?;
            let url = target.parse().expect("shell-lab URL must be valid");
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("Whiteboard Review · Tauri shell")
                .inner_size(1440.0, 960.0)
                .min_inner_size(880.0, 640.0)
                .data_directory(profile.into())
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Tauri host failed");
}
