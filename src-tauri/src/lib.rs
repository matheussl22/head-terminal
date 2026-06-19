// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

mod git;

use std::sync::Mutex;

use git::{get_git_context, start_git_watch, stop_git_watch, GitWatcherState};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_pty::init())
        .plugin(tauri_plugin_os::init())
        .manage(Mutex::new(GitWatcherState::new()))
        .invoke_handler(tauri::generate_handler![
            get_git_context,
            start_git_watch,
            stop_git_watch,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
