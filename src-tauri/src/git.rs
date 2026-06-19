use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;

use notify::{Config, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitContextPayload {
    pub repo_root: Option<String>,
    pub branch: Option<String>,
    pub head_short: Option<String>,
    pub head_ref: String,
    pub is_dirty: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitContextChangedEvent {
    pub watch_id: String,
    pub context: GitContextPayload,
}

pub struct GitWatcherState {
    watchers: HashMap<String, RecommendedWatcher>,
}

impl GitWatcherState {
    pub fn new() -> Self {
        Self {
            watchers: HashMap::new(),
        }
    }
}

fn run_git(args: &[&str]) -> Option<String> {
    let output = Command::new("git").args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }

    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn resolve_git_dir(repo_root: &Path) -> Option<PathBuf> {
    let dot_git = repo_root.join(".git");
    if dot_git.is_dir() {
        return Some(dot_git);
    }

    if !dot_git.is_file() {
        return None;
    }

    let content = std::fs::read_to_string(&dot_git).ok()?;
    for line in content.lines() {
        if let Some(rest) = line.strip_prefix("gitdir: ") {
            let path = PathBuf::from(rest.trim());
            return Some(if path.is_absolute() {
                path
            } else {
                repo_root.join(path)
            });
        }
    }

    None
}

pub fn resolve_git_context(cwd: &str) -> GitContextPayload {
    let repo_root = run_git(&["-C", cwd, "rev-parse", "--show-toplevel"]);

    let Some(repo_root) = repo_root else {
        return GitContextPayload {
            repo_root: None,
            branch: None,
            head_short: None,
            head_ref: String::new(),
            is_dirty: false,
        };
    };

    let branch = run_git(&["-C", &repo_root, "symbolic-ref", "--short", "HEAD"]);
    let head_short = run_git(&["-C", &repo_root, "rev-parse", "--short", "HEAD"]);
    let head_ref = run_git(&["-C", &repo_root, "symbolic-ref", "HEAD"])
        .or_else(|| head_short.clone())
        .unwrap_or_default();

    let is_dirty = run_git(&["-C", &repo_root, "status", "--porcelain"])
        .map(|status| !status.is_empty())
        .unwrap_or(false);

    GitContextPayload {
        repo_root: Some(repo_root),
        branch,
        head_short,
        head_ref,
        is_dirty,
    }
}

fn emit_git_context(app: &AppHandle, watch_id: &str, cwd: &str) {
    let context = resolve_git_context(cwd);
    let _ = app.emit(
        "git-context://changed",
        GitContextChangedEvent {
            watch_id: watch_id.to_string(),
            context,
        },
    );
}

#[tauri::command]
pub fn get_git_context(cwd: String) -> GitContextPayload {
    resolve_git_context(&cwd)
}

#[tauri::command]
pub fn start_git_watch(
    app: AppHandle,
    state: State<'_, Mutex<GitWatcherState>>,
    watch_id: String,
    cwd: String,
) -> Result<(), String> {
    let context = resolve_git_context(&cwd);
    if context.repo_root.is_none() {
        let _ = app.emit(
            "git-context://changed",
            GitContextChangedEvent {
                watch_id: watch_id.clone(),
                context,
            },
        );
        return Ok(());
    }

    let repo_root = context.repo_root.clone().unwrap();
    let git_dir = resolve_git_dir(Path::new(&repo_root))
        .ok_or_else(|| "Não foi possível resolver o diretório .git".to_string())?;

    let head_path = git_dir.join("HEAD");
    let index_path = git_dir.join("index");

    let mut watchers = state
        .lock()
        .map_err(|_| "Falha ao acessar estado do watcher".to_string())?;

    if let Some(existing) = watchers.watchers.remove(&watch_id) {
        drop(existing);
    }

    let app_handle = app.clone();
    let watch_id_for_callback = watch_id.clone();
    let cwd_for_callback = cwd.clone();

    let mut watcher = RecommendedWatcher::new(
        move |result| {
            if let Ok(event) = result {
                let is_relevant = matches!(
                    event.kind,
                    EventKind::Modify(_) | EventKind::Create(_) | EventKind::Remove(_)
                );

                if is_relevant {
                    emit_git_context(&app_handle, &watch_id_for_callback, &cwd_for_callback);
                }
            }
        },
        Config::default().with_poll_interval(Duration::from_millis(500)),
    )
    .map_err(|error| error.to_string())?;

    if head_path.exists() {
        watcher
            .watch(&head_path, RecursiveMode::NonRecursive)
            .map_err(|error| error.to_string())?;
    }

    if index_path.exists() {
        watcher
            .watch(&index_path, RecursiveMode::NonRecursive)
            .map_err(|error| error.to_string())?;
    }

    watchers.watchers.insert(watch_id.clone(), watcher);

    let _ = app.emit(
        "git-context://changed",
        GitContextChangedEvent {
            watch_id,
            context,
        },
    );

    Ok(())
}

#[tauri::command]
pub fn stop_git_watch(
    state: State<'_, Mutex<GitWatcherState>>,
    watch_id: String,
) -> Result<(), String> {
    let mut watchers = state
        .lock()
        .map_err(|_| "Falha ao acessar estado do watcher".to_string())?;

    if let Some(existing) = watchers.watchers.remove(&watch_id) {
        drop(existing);
    }

    Ok(())
}
