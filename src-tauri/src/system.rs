use std::fs;
use std::path::Path;
use std::process::Command;

use rusqlite::{Connection, OpenFlags};

const OPENAI_STORAGE_KEY: &str = "head-terminal.openai-api-key";
const WEBKIT_LOCALSTORAGE_REL: &str = "localstorage/tauri_localhost_0.localstorage";
const PROFILE_IDENTIFIERS: &[&str] = &[
    "com.matheus.head-terminal.dev",
    "com.matheus.head-terminal",
];

fn decode_webkit_localstorage_text(bytes: &[u8]) -> Option<String> {
    if bytes.is_empty() {
        return None;
    }

    let mut utf16 = Vec::with_capacity(bytes.len() / 2);
    for chunk in bytes.chunks_exact(2) {
        let unit = u16::from_le_bytes([chunk[0], chunk[1]]);
        if unit == 0 {
            break;
        }
        utf16.push(unit);
    }

    let text = String::from_utf16(&utf16).ok()?;
    let trimmed = text.trim().to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

fn read_openai_key_from_profile(identifier: &str) -> Option<String> {
    let home = std::env::var_os("HOME")?;
    let path = Path::new(&home)
        .join(".local/share")
        .join(identifier)
        .join(WEBKIT_LOCALSTORAGE_REL);

    if !path.exists() {
        return None;
    }

    let conn = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    let mut stmt = conn
        .prepare("SELECT value FROM ItemTable WHERE key = ?1")
        .ok()?;
    let value: Vec<u8> = stmt
        .query_row([OPENAI_STORAGE_KEY], |row| row.get(0))
        .ok()?;

    decode_webkit_localstorage_text(&value)
}

#[tauri::command]
pub fn legacy_openai_api_key() -> Result<Option<String>, String> {
    for identifier in PROFILE_IDENTIFIERS {
        if let Some(key) = read_openai_key_from_profile(identifier) {
            return Ok(Some(key));
        }
    }
    Ok(None)
}

#[tauri::command]
pub fn path_exists(path: String) -> bool {
    Path::new(&path).is_dir()
}

fn is_valid_claude_profile_dir(home: &Path, target: &Path) -> bool {
    let root = home.join(".head-terminal/claude-profiles");
    let Some(name) = target.file_name().and_then(|value| value.to_str()) else {
        return false;
    };
    let uuid_like = name.len() == 36
        && name.chars().enumerate().all(|(index, ch)| {
            if [8, 13, 18, 23].contains(&index) {
                ch == '-'
            } else {
                ch.is_ascii_hexdigit()
            }
        });
    uuid_like && target == root.join(name)
}

#[tauri::command]
pub fn delete_claude_profile_dir(path: String) -> Result<(), String> {
    let home = std::env::var_os("HOME").ok_or("HOME não encontrado")?;
    let target = Path::new(&path);
    if !is_valid_claude_profile_dir(Path::new(&home), target) {
        return Err("Caminho de perfil inválido".to_string());
    }
    if target.exists() {
        fs::remove_dir_all(target).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod claude_profile_tests {
    use super::is_valid_claude_profile_dir;
    use std::path::Path;

    #[test]
    fn only_accepts_direct_uuid_children_of_the_profile_root() {
        let home = Path::new("/home/test");
        assert!(is_valid_claude_profile_dir(
            home,
            Path::new(
                "/home/test/.head-terminal/claude-profiles/123e4567-e89b-12d3-a456-426614174000"
            ),
        ));
        assert!(!is_valid_claude_profile_dir(
            home,
            Path::new("/home/test/.head-terminal/claude-profiles/../.claude"),
        ));
        assert!(!is_valid_claude_profile_dir(
            home,
            Path::new("/tmp/123e4567-e89b-12d3-a456-426614174000"),
        ));
    }
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
