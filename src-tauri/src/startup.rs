use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

pub struct InstanceLock {
    path: PathBuf,
}

impl Drop for InstanceLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

pub fn log_dir() -> PathBuf {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    if let Some(mut path) = home {
        path.push(".local/share/head-terminal/logs");
        return path;
    }
    PathBuf::from("/tmp/head-terminal/logs")
}

fn run_id() -> &'static str {
    static RUN_ID: OnceLock<String> = OnceLock::new();
    RUN_ID.get_or_init(|| {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        let pid = std::process::id();
        format!("{:x}", nanos ^ ((pid as u128) << 40))
    })
}

pub fn channel_name() -> &'static str {
    if cfg!(debug_assertions) {
        "dev"
    } else {
        "prod"
    }
}

fn timestamp() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    format!("{secs}")
}

pub fn startup_log(message: &str) {
    let dir = log_dir();
    let _ = fs::create_dir_all(&dir);
    let mut path = dir;
    path.push("startup.log");

    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = writeln!(
            file,
            "{} run={} channel={} pid={} {}",
            timestamp(),
            run_id(),
            channel_name(),
            std::process::id(),
            message
        );
    }
}

pub fn append_jsonl(filename: &str, line: &str) {
    let dir = log_dir();
    let _ = fs::create_dir_all(&dir);
    let mut path = dir;
    path.push(filename);

    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = writeln!(file, "{line}");
    }
}

pub fn append_checkpoint(stage: &str, elapsed_ms: u64, meta: Option<serde_json::Value>) {
    let payload = serde_json::json!({
        "ts": timestamp(),
        "runId": run_id(),
        "channel": channel_name(),
        "stage": stage,
        "elapsedMs": elapsed_ms,
        "meta": meta,
    });
    if let Ok(line) = serde_json::to_string(&payload) {
        append_jsonl("checkpoints.jsonl", &line);
    }
}

fn instance_lock_path() -> PathBuf {
    let mut path = log_dir();
    path.pop();
    path.push("instance.lock");
    path
}

#[cfg(target_os = "linux")]
fn process_exists(pid: u32) -> bool {
    Path::new(&format!("/proc/{pid}")).exists()
}

#[cfg(not(target_os = "linux"))]
fn process_exists(pid: u32) -> bool {
    let _ = pid;
    true
}

pub fn acquire_instance_lock() -> Result<InstanceLock, String> {
    let path = instance_lock_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    for _ in 0..2 {
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(mut file) => {
                let _ = writeln!(file, "{}", std::process::id());
                startup_log("app.instance_lock.acquired");
                return Ok(InstanceLock { path });
            }
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                if let Ok(contents) = fs::read_to_string(&path) {
                    if let Ok(pid) = contents.trim().parse::<u32>() {
                        if process_exists(pid) {
                            startup_log("app.second_instance_blocked");
                            return Err("already_running".into());
                        }
                    }
                }
                let _ = fs::remove_file(&path);
            }
            Err(error) => {
                return Err(error.to_string());
            }
        }
    }

    Err("instance_lock_failed".into())
}

pub fn install_panic_hook() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        startup_log(&format!("panic: {info}"));
        let dir = log_dir();
        let _ = fs::create_dir_all(&dir);
        let mut path = dir;
        path.push("panic.log");
        if let Ok(mut file) = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
        {
            let _ = writeln!(file, "{info}");
        }
        default_hook(info);
    }));
}

pub fn log_graphics_env() {
    let dmabuf = std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER").unwrap_or_default();
    let display = std::env::var("DISPLAY").unwrap_or_default();
    let session = std::env::var("XDG_SESSION_TYPE").unwrap_or_default();
    startup_log(&format!(
        "env.graphics dmabuf={dmabuf} display={display} session={session}"
    ));
}

#[tauri::command]
pub fn get_startup_context() -> serde_json::Value {
    serde_json::json!({
        "runId": run_id(),
        "channel": channel_name(),
        "pid": std::process::id(),
    })
}

#[tauri::command]
pub fn append_log(line: String) {
    append_jsonl("events.jsonl", &line);
}

#[tauri::command]
pub fn append_checkpoint_cmd(
    stage: String,
    elapsed_ms: u64,
    meta: Option<serde_json::Value>,
) {
    append_checkpoint(&stage, elapsed_ms, meta);
}

#[tauri::command]
pub fn frontend_log(message: String) {
    append_jsonl("frontend.log", &message);
}

#[tauri::command]
pub fn export_diagnostic_bundle(frontend: serde_json::Value) -> Result<String, String> {
    let dir = log_dir();
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;

    let stamp = timestamp();
    let bundle_name = format!("head-terminal-diag-{}-{}.json", run_id(), stamp);
    let mut bundle_path = dir.clone();
    bundle_path.push(&bundle_name);

    let mut files: Vec<serde_json::Value> = Vec::new();
    for name in [
        "startup.log",
        "events.jsonl",
        "checkpoints.jsonl",
        "frontend.log",
        "panic.log",
    ] {
        let mut path = dir.clone();
        path.push(name);
        if let Ok(content) = fs::read_to_string(&path) {
            files.push(serde_json::json!({
                "name": name,
                "content": content,
            }));
        }
    }

    let payload = serde_json::json!({
        "runId": run_id(),
        "channel": channel_name(),
        "exportedAt": stamp,
        "frontend": frontend,
        "files": files,
    });

    let serialized = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;
    fs::write(&bundle_path, serialized).map_err(|error| error.to_string())?;
    startup_log(&format!("diagnostic.exported path={}", bundle_path.display()));
    Ok(bundle_path.to_string_lossy().into_owned())
}