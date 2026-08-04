// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod monitor;
mod fileio;

#[tauri::command]
fn get_platform() -> String {
    "windows".to_string()
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_log::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            get_platform,
            monitor::sample_foreground,
            fileio::read_file_base64,
            fileio::write_temp_file,
            fileio::open_file_with_default
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
