use std::path::Path;
use std::process::Command;

#[tauri::command]
pub fn path_exists(path: String) -> bool {
    Path::new(&path).is_dir()
}

#[derive(serde::Serialize)]
pub struct AgentCliStatus {
    pub cursor: bool,
    pub claude: bool,
    pub codex: bool,
}

#[tauri::command]
pub fn check_agent_clis() -> AgentCliStatus {
    let output = Command::new("zsh")
        .args([
            "-lc",
            "command -v cursor >/dev/null && echo cursor; command -v claude >/dev/null && echo claude; command -v codex >/dev/null && echo codex",
        ])
        .output();

    let mut found = std::collections::HashSet::new();
    if let Ok(output) = output {
        if let Ok(text) = String::from_utf8(output.stdout) {
            for line in text.lines() {
                found.insert(line.trim().to_string());
            }
        }
    }

    AgentCliStatus {
        cursor: found.contains("cursor"),
        claude: found.contains("claude"),
        codex: found.contains("codex"),
    }
}

#[tauri::command]
pub fn secret_get(key: String) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new("head-terminal", &key).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
pub fn secret_set(key: String, value: String) -> Result<(), String> {
    let entry = keyring::Entry::new("head-terminal", &key).map_err(|e| e.to_string())?;
    entry
        .set_password(&value)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn secret_delete(key: String) -> Result<(), String> {
    let entry = keyring::Entry::new("head-terminal", &key).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}
