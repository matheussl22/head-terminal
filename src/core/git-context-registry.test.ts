import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GitContext } from "../types/git-context";

const fetchGitContext = vi.fn();
const startGitWatch = vi.fn();
const stopGitWatch = vi.fn();
const subscribeGitContextChanges = vi.fn();

vi.mock("./git-watch-bridge", () => ({
  fetchGitContext: (...args: unknown[]) => fetchGitContext(...args),
  startGitWatch: (...args: unknown[]) => startGitWatch(...args),
  stopGitWatch: (...args: unknown[]) => stopGitWatch(...args),
  subscribeGitContextChanges: (...args: unknown[]) =>
    subscribeGitContextChanges(...args),
}));

function makeContext(branch: string): GitContext {
  return {
    repoRoot: "/repo",
    branch,
    headShort: "abc1234",
    headRef: "refs/heads/" + branch,
    isDirty: false,
    lastTouchedPath: null,
    lastTouchedAt: null,
    source: "initial",
  };
}

describe("git-context-registry", () => {
  let acquireGitContext: typeof import("./git-context-registry").acquireGitContext;
  let emitWatcherEvent:
    | ((watchId: string, context: GitContext) => void)
    | null = null;

  beforeEach(async () => {
    vi.resetModules();
    fetchGitContext.mockReset().mockResolvedValue(makeContext("main"));
    startGitWatch.mockReset().mockResolvedValue(undefined);
    stopGitWatch.mockReset().mockResolvedValue(undefined);
    emitWatcherEvent = null;
    subscribeGitContextChanges
      .mockReset()
      .mockImplementation(
        (onChange: (watchId: string, context: GitContext) => void) => {
          emitWatcherEvent = onChange;
          return Promise.resolve(() => undefined);
        },
      );

    ({ acquireGitContext } = await import("./git-context-registry"));
  });

  it("shares one watcher between subscribers of the same cwd", async () => {
    const first = vi.fn();
    const second = vi.fn();

    const releaseFirst = acquireGitContext("/repo", first);
    const releaseSecond = acquireGitContext("/repo", second);
    await Promise.resolve();

    expect(fetchGitContext).toHaveBeenCalledTimes(1);
    expect(startGitWatch).toHaveBeenCalledTimes(1);

    releaseFirst();
    expect(stopGitWatch).not.toHaveBeenCalled();

    releaseSecond();
    expect(stopGitWatch).toHaveBeenCalledTimes(1);
  });

  it("notifies all subscribers with the initial context", async () => {
    const first = vi.fn();
    const second = vi.fn();

    acquireGitContext("/repo", first);
    acquireGitContext("/repo", second);
    await vi.waitFor(() => {
      expect(first).toHaveBeenCalled();
    });

    expect(first.mock.calls[0][0].branch).toBe("main");
    expect(second).toHaveBeenCalled();
  });

  it("routes watcher events to the right entry", async () => {
    const onRepoA = vi.fn();
    const onRepoB = vi.fn();

    acquireGitContext("/repo-a", onRepoA);
    acquireGitContext("/repo-b", onRepoB);
    await vi.waitFor(() => expect(startGitWatch).toHaveBeenCalledTimes(2));

    const watchIdA = startGitWatch.mock.calls[0][0] as string;
    onRepoA.mockClear();
    onRepoB.mockClear();

    emitWatcherEvent?.(watchIdA, makeContext("feature"));

    expect(onRepoA).toHaveBeenCalledTimes(1);
    expect(onRepoA.mock.calls[0][0].branch).toBe("feature");
    expect(onRepoB).not.toHaveBeenCalled();
  });

  it("ignores blank cwd", () => {
    const subscriber = vi.fn();
    const release = acquireGitContext("  ", subscriber);
    release();

    expect(fetchGitContext).not.toHaveBeenCalled();
    expect(startGitWatch).not.toHaveBeenCalled();
  });
});
