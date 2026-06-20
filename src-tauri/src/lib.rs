// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

mod git;
mod startup;

use startup::{
    acquire_instance_lock, append_checkpoint_cmd, append_log, export_diagnostic_bundle,
    frontend_log, get_startup_context, install_panic_hook, log_graphics_env, startup_log,
};
use tauri::{Manager, WindowEvent};

use git::GitWatcherState;
use std::sync::Mutex;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    install_panic_hook();
    startup_log("app.start");

    // WebKitGTK's DMABUF renderer paints a black screen on several Linux GPU
    // drivers (notably NVIDIA). Disable it before the webview initializes,
    // unless the user already set an explicit value.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        startup_log("app.dmabuf_disabled");
    }

    log_graphics_env();

    let _instance_lock = match acquire_instance_lock() {
        Ok(lock) => Some(lock),
        Err(code) if code == "already_running" => {
            eprintln!("Head Terminal já está em execução.");
            std::process::exit(0);
        }
        Err(error) => {
            startup_log(&format!("app.instance_lock.warn {error}"));
            None
        }
    };

    run_tauri();
}

fn run_tauri() {
    startup_log("app.tauri.setup_begin");

    tauri::Builder::default()
        .plugin(tauri_plugin_pty::init())
        .plugin(tauri_plugin_os::init())
        .manage(Mutex::new(GitWatcherState::new()))
        .invoke_handler(tauri::generate_handler![
            frontend_log,
            append_log,
            append_checkpoint_cmd,
            get_startup_context,
            export_diagnostic_bundle,
            git::get_default_cwd,
            git::get_git_context,
            git::start_git_watch,
            git::stop_git_watch,
        ])
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                startup_log("app.window.created");
                let _ = window.show();

                window.on_window_event(|event| match event {
                    WindowEvent::Focused(focused) => {
                        startup_log(&format!("app.window.focused={focused}"));
                    }
                    WindowEvent::CloseRequested { .. } => {
                        startup_log("app.window.close_requested");
                    }
                    WindowEvent::Destroyed => {
                        startup_log("app.window.destroyed");
                    }
                    _ => {}
                });
            }

            startup_log("app.tauri.setup_done");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
