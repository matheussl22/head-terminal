import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type McpApi = Window["headTerminal"]["mcp"];

const listMock = vi.fn<McpApi["list"]>();

import { fetchMcpServers, invalidateMcpServersCache } from "./mcp-bridge";

describe("fetchMcpServers cache", () => {
  beforeEach(() => {
    invalidateMcpServersCache();
    listMock.mockReset();
    listMock.mockResolvedValue({ servers: [], error: null });
    vi.stubGlobal("window", {
      headTerminal: { mcp: { list: listMock } satisfies McpApi },
    });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("invokes the backend on the first call", async () => {
    await fetchMcpServers("/repo", "claude");
    expect(listMock).toHaveBeenCalledTimes(1);
  });

  it("does not re-invoke for a repeated call within the TTL", async () => {
    await fetchMcpServers("/repo", "claude");
    vi.advanceTimersByTime(60_000);
    await fetchMcpServers("/repo", "claude");
    expect(listMock).toHaveBeenCalledTimes(1);
  });

  it("re-invokes once the TTL has expired", async () => {
    await fetchMcpServers("/repo", "claude");
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    await fetchMcpServers("/repo", "claude");
    expect(listMock).toHaveBeenCalledTimes(2);
  });

  it("caches independently per agent+cwd key", async () => {
    await fetchMcpServers("/repo", "claude");
    await fetchMcpServers("/repo", "cursor");
    await fetchMcpServers("/other-repo", "claude");
    expect(listMock).toHaveBeenCalledTimes(3);
  });

  it("rejects unsupported agents without crossing the preload boundary", async () => {
    await expect(fetchMcpServers("/repo", "codex")).resolves.toEqual({
      servers: [],
      error: "Agent não suportado",
    });
    expect(listMock).not.toHaveBeenCalled();
  });
});
