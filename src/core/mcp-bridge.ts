import { invoke } from "@tauri-apps/api/core";

export interface McpServerStatus {
  name: string;
  target: string;
  status: string;
}

interface McpServersPayload {
  servers: McpServerStatus[];
  error: string | null;
}

export async function fetchMcpServers(
  cwd: string,
  agent: string,
): Promise<McpServersPayload> {
  return invoke<McpServersPayload>("get_mcp_servers", { cwd, agent });
}
