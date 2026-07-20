import { describe, expect, it, vi } from "vitest";

import {
  McpService,
  parseClaudeMcpList,
  parseCursorMcpList,
} from "./mcp-service";

describe("mcp-service", () => {
  it("preserves Claude's name, target and final status parser", () => {
    expect(parseClaudeMcpList([
      "github: https://mcp.example.test/path - connected",
      "local: npx -y server --flag - failed: exit 1",
      "header without separators",
    ].join("\n"))).toEqual([
      { name: "github", target: "https://mcp.example.test/path", status: "connected" },
      { name: "local", target: "npx -y server --flag", status: "failed: exit 1" },
    ]);
  });

  it("preserves Cursor statuses containing colons", () => {
    expect(parseCursorMcpList("atlassian: not loaded (needs approval)\napi: failed: 401"))
      .toEqual([
        { name: "atlassian", target: "", status: "not loaded (needs approval)" },
        { name: "api", target: "", status: "failed: 401" },
      ]);
  });

  it("caches payloads per cwd and agent for five-minute semantics", async () => {
    let now = 1_000;
    const runner = vi.fn().mockResolvedValue({
      stdout: "docs: https://example.test - connected",
      stderr: "",
    });
    const service = new McpService({ runner, now: () => now, cacheTtlMs: 300_000 });

    await service.list("/repo", "claude");
    await service.list("/repo", "claude");
    expect(runner).toHaveBeenCalledTimes(1);

    now += 300_001;
    await service.list("/repo", "claude");
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("maps missing CLI and timeout failures to stable payload errors", async () => {
    const missing = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    const timeout = Object.assign(new Error("timeout"), { killed: true });
    const runner = vi.fn().mockRejectedValueOnce(missing).mockRejectedValueOnce(timeout);
    const service = new McpService({ runner, cacheTtlMs: 0 });

    await expect(service.list("/repo", "claude")).resolves.toEqual({
      servers: [], error: "CLI 'claude' não encontrada",
    });
    await expect(service.list("/repo", "cursor")).resolves.toEqual({
      servers: [], error: "Tempo limite excedido ao consultar 'cursor-agent'",
    });
  });
});
