use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;

use notify::{Config, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

#[tauri::command]
pub fn get_default_cwd() -> String {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    format!("{}/Documentos", home.trim_end_matches('/'))
}

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
    // Keyed by repo_root so multiple watch_ids pointing at the same repo
    // (e.g. a session and one of its panes) share a single fs watcher
    // instead of each spawning their own.
    watchers: HashMap<String, RecommendedWatcher>,
    subscribers: HashMap<String, HashSet<String>>,
    watch_id_repo: HashMap<String, String>,
}

impl GitWatcherState {
    pub fn new() -> Self {
        Self {
            watchers: HashMap::new(),
            subscribers: HashMap::new(),
            watch_id_repo: HashMap::new(),
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

fn emit_git_context_to(app: &AppHandle, watch_id: &str, context: GitContextPayload) {
    let _ = app.emit(
        "git-context://changed",
        GitContextChangedEvent {
            watch_id: watch_id.to_string(),
            context,
        },
    );
}

/// Re-resolves the git context for `repo_root` once and fans it out to every
/// watch_id currently subscribed to that repo, instead of each subscriber
/// triggering its own `git` subprocess calls.
fn emit_git_context_for_repo(app: &AppHandle, repo_root: &str) {
    let context = resolve_git_context(repo_root);

    let Some(state) = app.try_state::<Mutex<GitWatcherState>>() else {
        return;
    };
    let Ok(watchers) = state.lock() else {
        return;
    };

    let Some(watch_ids) = watchers.subscribers.get(repo_root) else {
        return;
    };

    for watch_id in watch_ids {
        emit_git_context_to(app, watch_id, context.clone());
    }
}

#[tauri::command]
pub fn get_git_context(cwd: String) -> GitContextPayload {
    resolve_git_context(&cwd)
}

/// Diff do trabalho do agent na sessão: mudanças vs HEAD + untracked.
#[tauri::command]
pub fn get_session_diff(cwd: String) -> Result<String, String> {
    let repo_root = run_git(&["-C", &cwd, "rev-parse", "--show-toplevel"])
        .ok_or_else(|| "O diretório não é um repositório git".to_string())?;

    let diff = run_git(&["-C", &repo_root, "diff", "HEAD"]).unwrap_or_default();
    let untracked = run_git(&[
        "-C",
        &repo_root,
        "ls-files",
        "--others",
        "--exclude-standard",
    ])
    .unwrap_or_default();

    let mut result = diff;
    if !untracked.is_empty() {
        if !result.is_empty() {
            result.push('\n');
        }
        for file in untracked.lines() {
            result.push_str(&format!("?? novo arquivo (untracked): {file}\n"));
        }
    }

    Ok(result)
}

/// Cria um git worktree irmão do repo (`<repo>-agent-N`, branch `agent-N`)
/// para rodar agents em paralelo sem conflito de working tree.
#[tauri::command]
pub fn create_session_worktree(cwd: String) -> Result<String, String> {
    let repo_root = run_git(&["-C", &cwd, "rev-parse", "--show-toplevel"])
        .ok_or_else(|| "O diretório não é um repositório git".to_string())?;

    for n in 1..100 {
        let branch = format!("agent-{n}");
        let path = format!("{repo_root}-{branch}");

        if Path::new(&path).exists()
            || run_git(&["-C", &repo_root, "rev-parse", "--verify", &branch]).is_some()
        {
            continue;
        }

        let output = Command::new("git")
            .args(["-C", &repo_root, "worktree", "add", &path, "-b", &branch])
            .output()
            .map_err(|error| error.to_string())?;

        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }

        return Ok(path);
    }

    Err("Limite de worktrees atingido".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cria_worktree_isolado_com_branch_numerada() {
        let base = std::env::temp_dir().join(format!("ht-wt-test-{}", std::process::id()));
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_str().unwrap();

        let git = |args: &[&str]| {
            assert!(Command::new("git").args(args).status().unwrap().success());
        };
        git(&["-C", repo_s, "init", "-q"]);
        git(&[
            "-C", repo_s, "-c", "user.email=t@t", "-c", "user.name=t",
            "commit", "--allow-empty", "-q", "-m", "init",
        ]);

        let path = create_session_worktree(repo_s.to_string()).unwrap();
        assert!(path.ends_with("-agent-1"));
        assert!(Path::new(&path).join(".git").exists());

        // Segunda chamada não colide: numera agent-2.
        let path2 = create_session_worktree(repo_s.to_string()).unwrap();
        assert!(path2.ends_with("-agent-2"));

        let _ = std::fs::remove_dir_all(&base);
    }
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
        emit_git_context_to(&app, &watch_id, context);
        return Ok(());
    }

    let repo_root = context.repo_root.clone().unwrap();

    let mut watchers = state
        .lock()
        .map_err(|_| "Falha ao acessar estado do watcher".to_string())?;

    // Detach watch_id from whatever repo it was previously subscribed to
    // (e.g. cwd changed) before attaching it to the new one.
    detach_watch_id(&mut watchers, &watch_id);

    watchers
        .subscribers
        .entry(repo_root.clone())
        .or_default()
        .insert(watch_id.clone());
    watchers.watch_id_repo.insert(watch_id.clone(), repo_root.clone());

    if !watchers.watchers.contains_key(&repo_root) {
        let git_dir = resolve_git_dir(Path::new(&repo_root))
            .ok_or_else(|| "Não foi possível resolver o diretório .git".to_string())?;

        let head_path = git_dir.join("HEAD");
        let index_path = git_dir.join("index");

        let app_handle = app.clone();
        let repo_root_for_callback = repo_root.clone();

        let mut watcher = RecommendedWatcher::new(
            move |result: Result<notify::Event, notify::Error>| {
                if let Ok(event) = result {
                    let is_relevant = matches!(
                        event.kind,
                        EventKind::Modify(_) | EventKind::Create(_) | EventKind::Remove(_)
                    );

                    if is_relevant {
                        emit_git_context_for_repo(&app_handle, &repo_root_for_callback);
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

        watchers.watchers.insert(repo_root, watcher);
    }

    drop(watchers);

    emit_git_context_to(&app, &watch_id, context);

    Ok(())
}

fn detach_watch_id(watchers: &mut GitWatcherState, watch_id: &str) {
    let Some(previous_repo) = watchers.watch_id_repo.remove(watch_id) else {
        return;
    };

    if let Some(subscribers) = watchers.subscribers.get_mut(&previous_repo) {
        subscribers.remove(watch_id);
        if subscribers.is_empty() {
            watchers.subscribers.remove(&previous_repo);
            if let Some(existing) = watchers.watchers.remove(&previous_repo) {
                drop(existing);
            }
        }
    }
}

#[tauri::command]
pub fn stop_git_watch(
    state: State<'_, Mutex<GitWatcherState>>,
    watch_id: String,
) -> Result<(), String> {
    let mut watchers = state
        .lock()
        .map_err(|_| "Falha ao acessar estado do watcher".to_string())?;

    detach_watch_id(&mut watchers, &watch_id);

    Ok(())
}
