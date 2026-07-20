import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GitContext } from "../types/git-context";
import {
  fetchGitContext,
  fetchGitContextForPath,
  startGitWatch,
  stopGitWatch,
  subscribeGitContextChanges,
} from "./git-watch-bridge";

type GitApi = Window["headTerminal"]["git"];
type ChangedCallback = Parameters<GitApi["onChanged"]>[0];

const payload = {
  repoRoot: "/repo",
  branch: "main",
  headShort: "abc1234",
  headRef: "refs/heads/main",
  isDirty: true,
};

function installGitMock(): {
  api: GitApi;
  getContext: ReturnType<typeof vi.fn>;
  watch: ReturnType<typeof vi.fn>;
  unwatch: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
  emit: (event: Parameters<ChangedCallback>[0]) => void;
} {
  let changed: ChangedCallback | undefined;
  const getContext = vi.fn<GitApi["getContext"]>().mockResolvedValue(payload);
  const getDiff = vi.fn<GitApi["getDiff"]>().mockResolvedValue("");
  const createWorktree = vi.fn<GitApi["createWorktree"]>();
  const watch = vi.fn<GitApi["watch"]>().mockResolvedValue(undefined);
  const unwatch = vi.fn<GitApi["unwatch"]>().mockResolvedValue(undefined);
  const unsubscribe = vi.fn();
  const onChanged = vi.fn<GitApi["onChanged"]>((callback) => {
    changed = callback;
    return unsubscribe;
  });
  const api: GitApi = {
    getContext,
    getDiff,
    createWorktree,
    watch,
    unwatch,
    onChanged,
  };
  vi.stubGlobal("window", { headTerminal: { git: api } });
  return {
    api,
    getContext,
    watch,
    unwatch,
    unsubscribe,
    emit: (event) => changed?.(event),
  };
}

describe("git-watch-bridge", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("maps initial context and forwards watch lifecycle calls", async () => {
    const git = installGitMock();
    await expect(fetchGitContext("/repo")).resolves.toEqual({
      ...payload,
      lastTouchedPath: null,
      lastTouchedAt: null,
      source: "initial",
    });
    await startGitWatch("pane:1", "/repo");
    await stopGitWatch("pane:1");
    expect(git.watch).toHaveBeenCalledWith({ watchId: "pane:1", cwd: "/repo" });
    expect(git.unwatch).toHaveBeenCalledWith("pane:1");
  });

  it("routes changed events and exposes the preload unsubscribe", async () => {
    const git = installGitMock();
    const onChange = vi.fn();
    const unsubscribe = await subscribeGitContextChanges(onChange);
    git.emit({ watchId: "pane:2", context: payload });
    expect(onChange).toHaveBeenCalledWith("pane:2", {
      ...payload,
      lastTouchedPath: null,
      lastTouchedAt: null,
      source: "watcher",
    });
    unsubscribe();
    expect(git.unsubscribe).toHaveBeenCalledOnce();
  });

  it("marks PTY-discovered paths while preserving previous touch metadata", async () => {
    const git = installGitMock();
    vi.setSystemTime(new Date("2026-07-19T12:00:00Z"));
    const previous: GitContext = {
      ...payload,
      source: "watcher",
      lastTouchedPath: "/old",
      lastTouchedAt: 10,
    };
    const context = await fetchGitContextForPath("/repo/subdir", previous);
    expect(git.getContext).toHaveBeenCalledWith("/repo/subdir");
    expect(context).toEqual({
      ...payload,
      source: "pty",
      lastTouchedPath: "/repo/subdir",
      lastTouchedAt: Date.now(),
    });
  });
});
