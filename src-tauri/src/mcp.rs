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
fn parse_claude_mcp_list(stdout: &str) -> Vec<McpServerStatus> {
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

// `cursor-agent mcp list` has no target/URL column, just "name: status"
// (e.g. "atlassian: not loaded (needs approval)").
fn parse_cursor_mcp_list(stdout: &str) -> Vec<McpServerStatus> {
    stdout
        .lines()
        .filter_map(|line| {
            let (name, status) = line.split_once(": ")?;
            Some(McpServerStatus {
                name: name.trim().to_string(),
                target: String::new(),
                status: status.trim().to_string(),
            })
        })
        .collect()
}

#[tauri::command]
pub fn get_mcp_servers(cwd: String, agent: String) -> McpServersPayload {
    let (binary, parser): (&str, fn(&str) -> Vec<McpServerStatus>) = match agent.as_str() {
        "claude" => ("claude", parse_claude_mcp_list),
        "cursor" => ("cursor-agent", parse_cursor_mcp_list),
        _ => {
            return McpServersPayload {
                servers: Vec::new(),
                error: Some("Agent não suportado".to_string()),
            }
        }
    };

    let output = Command::new(binary)
        .args(["mcp", "list"])
        .current_dir(&cwd)
        .output();

    match output {
        Ok(output) if output.status.success() => McpServersPayload {
            servers: parser(&String::from_utf8_lossy(&output.stdout)),
            error: None,
        },
        Ok(output) => McpServersPayload {
            servers: Vec::new(),
            error: Some(String::from_utf8_lossy(&output.stderr).trim().to_string()),
        },
        Err(_) => McpServersPayload {
            servers: Vec::new(),
            error: Some(format!("CLI '{binary}' não encontrada")),
        },
    }
}
