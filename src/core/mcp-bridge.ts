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

// `get_mcp_servers` spawns an external CLI (`claude mcp list` / `cursor-agent
// mcp list`) synchronously on the Rust side, which is slow. Cache results per
// cwd+agent for a few minutes so re-opening the Settings dialog doesn't pay
// that cost every time.
const MCP_SERVERS_CACHE_TTL_MS = 5 * 60 * 1000;
const mcpServersCache = new Map<
  string,
  { payload: McpServersPayload; expiresAt: number }
>();

export function invalidateMcpServersCache(): void {
  mcpServersCache.clear();
}

export async function fetchMcpServers(
  cwd: string,
  agent: string,
): Promise<McpServersPayload> {
  const key = `${agent}:${cwd}`;
  const cached = mcpServersCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.payload;
  }

  const payload = await invoke<McpServersPayload>("get_mcp_servers", {
    cwd,
    agent,
  });
  mcpServersCache.set(key, {
    payload,
    expiresAt: Date.now() + MCP_SERVERS_CACHE_TTL_MS,
  });
  return payload;
}
