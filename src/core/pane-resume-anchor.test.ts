import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listResumable = vi.fn();
const notePaneResumeAnchor = vi.fn();
const noteConversationTitles = vi.fn();

vi.mock("./session-manager", () => ({
  useSessionStore: {
    getState: () => ({ notePaneResumeAnchor, noteConversationTitles }),
  },
}));

import { anchorPaneResumeSession } from "./pane-resume-anchor";

describe("anchorPaneResumeSession", () => {
  beforeEach(() => {
    listResumable.mockReset();
    notePaneResumeAnchor.mockReset();
    noteConversationTitles.mockReset();
    vi.stubGlobal("window", {
      headTerminal: { sessions: { listResumable } },
    });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("skips non-resumable agents entirely", async () => {
    await anchorPaneResumeSession({
      paneId: "pane-1",
      cwd: "/repo",
      agentProfileId: "shell",
      spawnStartMs: 0,
      isDisposed: () => false,
    });

    expect(listResumable).not.toHaveBeenCalled();
    expect(notePaneResumeAnchor).not.toHaveBeenCalled();
  });

  it("ignores an older transcript from before the spawn and anchors the first one at/after it", async () => {
    const spawnStartMs = 10_000;
    listResumable
      .mockResolvedValueOnce([
        { id: "stale", title: "x", updatedAt: new Date(spawnStartMs - 5_000).toISOString() },
      ])
      .mockResolvedValueOnce([
        { id: "fresh", title: "y", updatedAt: new Date(spawnStartMs + 200).toISOString() },
      ]);

    const promise = anchorPaneResumeSession({
      paneId: "pane-1",
      cwd: "/repo",
      agentProfileId: "claude",
      spawnStartMs,
      isDisposed: () => false,
    });

    await vi.advanceTimersByTimeAsync(1_500);
    await vi.advanceTimersByTimeAsync(3_000);
    await promise;

    expect(listResumable).toHaveBeenCalledTimes(2);
    expect(notePaneResumeAnchor).toHaveBeenCalledExactlyOnceWith("pane-1", "fresh");
    // Every lookup feeds the title cache the pane header reads, including the
    // one whose entries were all too old to anchor on.
    expect(noteConversationTitles).toHaveBeenCalledTimes(2);
  });

  it("stops before the next fetch once the pane is disposed", async () => {
    const promise = anchorPaneResumeSession({
      paneId: "pane-1",
      cwd: "/repo",
      agentProfileId: "claude",
      spawnStartMs: 0,
      isDisposed: () => true,
    });

    await vi.advanceTimersByTimeAsync(1_500);
    await promise;

    expect(listResumable).not.toHaveBeenCalled();
    expect(notePaneResumeAnchor).not.toHaveBeenCalled();
  });

  it("gives up quietly after exhausting every retry with no fresh transcript", async () => {
    listResumable.mockResolvedValue([]);

    const promise = anchorPaneResumeSession({
      paneId: "pane-1",
      cwd: "/repo",
      agentProfileId: "cursor",
      spawnStartMs: 0,
      isDisposed: () => false,
    });

    await vi.advanceTimersByTimeAsync(1_500);
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.advanceTimersByTimeAsync(6_000);
    await promise;

    expect(listResumable).toHaveBeenCalledTimes(3);
    expect(notePaneResumeAnchor).not.toHaveBeenCalled();
  });

  it("never throws when the lookup itself rejects", async () => {
    listResumable.mockRejectedValue(new Error("boom"));

    const promise = anchorPaneResumeSession({
      paneId: "pane-1",
      cwd: "/repo",
      agentProfileId: "claude",
      spawnStartMs: 0,
      isDisposed: () => false,
    });

    await vi.advanceTimersByTimeAsync(1_500);
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.advanceTimersByTimeAsync(6_000);
    await expect(promise).resolves.toBeUndefined();
    expect(notePaneResumeAnchor).not.toHaveBeenCalled();
  });
});
