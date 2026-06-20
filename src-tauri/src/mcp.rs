use std::process::Command;

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerStatus {
    pub name: String,
    pub target: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServersPayload {
    pub servers: Vec<McpServerStatus>,
    pub error: Option<String>,
}

// `claude mcp list` has no --json flag; output is one line per server:
// "name: target - status". Parsed instead of re-implementing Claude's own
// .mcp.json merge/approval/health-check logic here.
fn parse_mcp_list(stdout: &str) -> Vec<McpServerStatus> {
    stdout
        .lines()
        .filter_map(|line| {
            let (name, rest) = line.split_once(": ")?;
            let (target, status) = rest.rsplit_once(" - ")?;
            Some(McpServerStatus {
                name: name.trim().to_string(),
                target: target.trim().to_string(),
                status: status.trim().to_string(),
            })
        })
        .collect()
}

#[tauri::command]
pub fn get_mcp_servers(cwd: String) -> McpServersPayload {
    let output = Command::new("claude")
        .args(["mcp", "list"])
        .current_dir(&cwd)
        .output();

    match output {
        Ok(output) if output.status.success() => McpServersPayload {
            servers: parse_mcp_list(&String::from_utf8_lossy(&output.stdout)),
            error: None,
        },
        Ok(output) => McpServersPayload {
            servers: Vec::new(),
            error: Some(String::from_utf8_lossy(&output.stderr).trim().to_string()),
        },
        Err(_) => McpServersPayload {
            servers: Vec::new(),
            error: Some("Claude CLI não encontrada".to_string()),
        },
    }
}
