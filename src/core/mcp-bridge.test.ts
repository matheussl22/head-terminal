import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { fetchMcpServers, invalidateMcpServersCache } from "./mcp-bridge";

describe("fetchMcpServers cache", () => {
  beforeEach(() => {
    invalidateMcpServersCache();
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({ servers: [], error: null });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("invokes the backend on the first call", async () => {
    await fetchMcpServers("/repo", "claude");
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("does not re-invoke for a repeated call within the TTL", async () => {
    await fetchMcpServers("/repo", "claude");
    vi.advanceTimersByTime(60_000);
    await fetchMcpServers("/repo", "claude");
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("re-invokes once the TTL has expired", async () => {
    await fetchMcpServers("/repo", "claude");
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    await fetchMcpServers("/repo", "claude");
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("caches independently per agent+cwd key", async () => {
    await fetchMcpServers("/repo", "claude");
    await fetchMcpServers("/repo", "cursor");
    await fetchMcpServers("/other-repo", "claude");
    expect(invokeMock).toHaveBeenCalledTimes(3);
  });
});
