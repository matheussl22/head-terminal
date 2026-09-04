import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listResumable = vi.fn();
const notePaneResumeAnchor = vi.fn();
const noteConversationTitles = vi.fn();

let paneRuntime: Record<string, { status: string }> = {};
let paneResumeAnchors: Record<string, string> = {};

vi.mock("./session-manager", () => ({
  useSessionStore: {
    getState: () => ({
      notePaneResumeAnchor,
      noteConversationTitles,
      paneRuntime,
      paneResumeAnchors,
    }),
  },
}));

import { anchorPaneResumeSession, hasTranscriptTitle } from "./pane-resume-anchor";
import { setCachedPlatformInfoForTests } from "./platform-info";

describe("anchorPaneResumeSession", () => {
  beforeEach(() => {
    listResumable.mockReset();
    notePaneResumeAnchor.mockReset();
    noteConversationTitles.mockReset();
    paneRuntime = { "pane-1": { status: "running" } };
    paneResumeAnchors = {};
    vi.stubGlobal("window", {
      headTerminal: { sessions: { listResumable } },
    });
    // A Claude lookup needs the home to resolve the pane's profile dir.
    setCachedPlatformInfoForTests({
      platform: "linux",
      homeDir: "/home/test",
    } as unknown as Parameters<typeof setCachedPlatformInfoForTests>[0]);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    setCachedPlatformInfoForTests(null);
  });

  it("skips non-resumable agents entirely", async () => {
    await anchorPaneResumeSession({
      paneId: "pane-1",
      cwd: "/repo",
      agentProfileId: "shell",
      spawnStartMs: 0,
      startsNewConversation: false,
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
      startsNewConversation: false,
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
      startsNewConversation: false,
      isDisposed: () => true,
    });

    await vi.advanceTimersByTimeAsync(1_500);
    await promise;

    expect(listResumable).not.toHaveBeenCalled();
    expect(notePaneResumeAnchor).not.toHaveBeenCalled();
  });

  it("keeps polling long after the initial retries, since the CLI only writes the transcript on the first message", async () => {
    listResumable.mockResolvedValue([]);

    const promise = anchorPaneResumeSession({
      paneId: "pane-1",
      cwd: "/repo",
      agentProfileId: "claude",
      spawnStartMs: 0,
      startsNewConversation: false,
      isDisposed: () => false,
    });

    // The three staggered attempts are spent by 10.5s and used to be the end
    // of it — the pane stayed nameless no matter how long the user typed for.
    await vi.advanceTimersByTimeAsync(10_500);
    expect(listResumable).toHaveBeenCalledTimes(3);

    listResumable.mockResolvedValue([
      { id: "late", title: "primeira pergunta", updatedAt: new Date(60_000).toISOString() },
    ]);
    await vi.advanceTimersByTimeAsync(60_000);
    await promise;

    expect(notePaneResumeAnchor).toHaveBeenCalledExactlyOnceWith("pane-1", "late");
  });

  it("gives up once the pane's process is gone", async () => {
    listResumable.mockResolvedValue([]);

    const promise = anchorPaneResumeSession({
      paneId: "pane-1",
      cwd: "/repo",
      agentProfileId: "cursor",
      spawnStartMs: 0,
      startsNewConversation: false,
      isDisposed: () => false,
    });

    await vi.advanceTimersByTimeAsync(10_500);
    expect(listResumable).toHaveBeenCalledTimes(3);

    paneRuntime = { "pane-1": { status: "exited" } };
    await vi.advanceTimersByTimeAsync(60_000);
    await promise;

    expect(listResumable).toHaveBeenCalledTimes(3);
    expect(notePaneResumeAnchor).not.toHaveBeenCalled();
  });

  it("skips a transcript another pane already anchored on", async () => {
    paneResumeAnchors = { "pane-2": "shared" };
    listResumable
      .mockResolvedValueOnce([
        { id: "shared", title: "x", updatedAt: new Date(5_000).toISOString() },
      ])
      .mockResolvedValueOnce([
        { id: "shared", title: "x", updatedAt: new Date(5_000).toISOString() },
        { id: "mine", title: "y", updatedAt: new Date(6_000).toISOString() },
      ]);

    const promise = anchorPaneResumeSession({
      paneId: "pane-1",
      cwd: "/repo",
      agentProfileId: "claude",
      spawnStartMs: 0,
      startsNewConversation: false,
      isDisposed: () => false,
    });

    await vi.advanceTimersByTimeAsync(1_500);
    await vi.advanceTimersByTimeAsync(3_000);
    await promise;

    expect(notePaneResumeAnchor).toHaveBeenCalledExactlyOnceWith("pane-1", "mine");
  });

  it("never adopts a transcript that already existed when the pane spawned", async () => {
    // Splitting a pane: the sibling is mid-answer, so its transcript is the
    // freshest thing in the cwd and passes the mtime threshold every time.
    const sibling = {
      id: "sibling",
      title: "conversa do vizinho",
      updatedAt: new Date(50_000).toISOString(),
    };
    listResumable
      // snapshot taken before the CLI finishes booting
      .mockResolvedValueOnce([sibling])
      .mockResolvedValueOnce([{ ...sibling, updatedAt: new Date(60_000).toISOString() }])
      .mockResolvedValueOnce([
        { id: "own", title: "minha pergunta", updatedAt: new Date(70_000).toISOString() },
        { ...sibling, updatedAt: new Date(65_000).toISOString() },
      ]);

    const promise = anchorPaneResumeSession({
      paneId: "pane-1",
      cwd: "/repo",
      agentProfileId: "claude",
      spawnStartMs: 0,
      startsNewConversation: true,
      isDisposed: () => false,
    });

    await vi.advanceTimersByTimeAsync(1_500);
    await vi.advanceTimersByTimeAsync(3_000);
    await promise;

    expect(notePaneResumeAnchor).toHaveBeenCalledExactlyOnceWith("pane-1", "own");
  });

  it("follows the copy a --resume forks into, once the resumed id stops being listed", async () => {
    const spawnStartMs = 10_000;
    const ancestor = {
      id: "ancestor",
      title: "auditoria",
      updatedAt: new Date(spawnStartMs - 60_000).toISOString(),
    };
    listResumable
      // snapshot: the conversation the pane asked to resume
      .mockResolvedValueOnce([ancestor])
      .mockResolvedValueOnce([ancestor])
      // the CLI replayed the history into a new transcript, which supersedes
      // the ancestor in the list
      .mockResolvedValueOnce([
        { id: "fork", title: "auditoria", updatedAt: new Date(spawnStartMs + 300).toISOString() },
      ]);

    const promise = anchorPaneResumeSession({
      paneId: "pane-1",
      cwd: "/repo",
      agentProfileId: "claude",
      spawnStartMs,
      startsNewConversation: true,
      resumedSessionId: "ancestor",
      isDisposed: () => false,
    });

    await vi.advanceTimersByTimeAsync(1_500);
    await vi.advanceTimersByTimeAsync(3_000);
    await promise;

    expect(notePaneResumeAnchor).toHaveBeenCalledExactlyOnceWith("pane-1", "fork");
  });

  it("keeps a resumed pane on its own id while that transcript is still the live one", async () => {
    const spawnStartMs = 10_000;
    const ancestor = {
      id: "ancestor",
      title: "auditoria",
      updatedAt: new Date(spawnStartMs - 60_000).toISOString(),
    };
    // A sibling pane opens a brand new conversation in the same cwd while we
    // watch: fresh id, fresh mtime, nobody anchored on it yet.
    listResumable.mockResolvedValue([
      { id: "sibling-nova", title: "outra", updatedAt: new Date(spawnStartMs + 400).toISOString() },
      ancestor,
    ]);

    const promise = anchorPaneResumeSession({
      paneId: "pane-1",
      cwd: "/repo",
      agentProfileId: "claude",
      spawnStartMs,
      startsNewConversation: true,
      resumedSessionId: "ancestor",
      isDisposed: () => false,
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(notePaneResumeAnchor).not.toHaveBeenCalled();

    // ...and the watch is bounded: no copy in 90s means the CLI is appending
    // to the resumed transcript, so the poll stops instead of running for the
    // life of the pane.
    await vi.advanceTimersByTimeAsync(120_000);
    await promise;
    const calls = listResumable.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(listResumable.mock.calls.length).toBe(calls);
    expect(notePaneResumeAnchor).not.toHaveBeenCalled();
  });

  it("still anchors on a pre-existing transcript when the spawn is a --continue", async () => {
    listResumable.mockResolvedValue([
      { id: "retomada", title: "de ontem", updatedAt: new Date(50_000).toISOString() },
    ]);

    const promise = anchorPaneResumeSession({
      paneId: "pane-1",
      cwd: "/repo",
      agentProfileId: "claude",
      spawnStartMs: 0,
      startsNewConversation: false,
      isDisposed: () => false,
    });

    await vi.advanceTimersByTimeAsync(1_500);
    await promise;

    // No snapshot lookup: a --continue is supposed to land on an old id.
    expect(listResumable).toHaveBeenCalledTimes(1);
    expect(notePaneResumeAnchor).toHaveBeenCalledExactlyOnceWith("pane-1", "retomada");
  });

  it("never throws when the lookup itself rejects", async () => {
    listResumable.mockRejectedValue(new Error("boom"));

    const promise = anchorPaneResumeSession({
      paneId: "pane-1",
      cwd: "/repo",
      agentProfileId: "claude",
      spawnStartMs: 0,
      startsNewConversation: false,
      isDisposed: () => false,
    });

    await vi.advanceTimersByTimeAsync(10_500);
    expect(listResumable).toHaveBeenCalledTimes(3);
    expect(notePaneResumeAnchor).not.toHaveBeenCalled();

    paneRuntime = { "pane-1": { status: "exited" } };
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(promise).resolves.toBeUndefined();
  });

  it("anchors a transcript that appeared after the pre-spawn snapshot, then upgrades a fallback title", async () => {
    listResumable
      .mockResolvedValueOnce([
        {
          id: "boot",
          title: "Sessão de 26/08/2026, 09:00:00",
          fromTranscript: false,
          updatedAt: new Date(5_000).toISOString(),
        },
      ])
      .mockResolvedValue([
        {
          id: "boot",
          title: "como salvar a conversa",
          fromTranscript: true,
          updatedAt: new Date(8_000).toISOString(),
        },
      ]);

    const promise = anchorPaneResumeSession({
      paneId: "pane-1",
      cwd: "/repo",
      agentProfileId: "claude",
      spawnStartMs: 4_000,
      startsNewConversation: true,
      existingSessionIds: [],
      isDisposed: () => false,
    });

    await vi.advanceTimersByTimeAsync(1_500);
    expect(notePaneResumeAnchor).toHaveBeenCalledExactlyOnceWith("pane-1", "boot");

    await vi.advanceTimersByTimeAsync(2_500);
    await promise;

    const lastTitles = noteConversationTitles.mock.calls.at(-1)?.[0] as Array<{
      title: string;
    }>;
    expect(lastTitles[0].title).toBe("como salvar a conversa");
  });

  it("does not steal a sibling that was already on disk before spawn", async () => {
    listResumable.mockResolvedValue([
      {
        id: "sibling",
        title: "outra conversa",
        updatedAt: new Date(6_000).toISOString(),
      },
    ]);

    const promise = anchorPaneResumeSession({
      paneId: "pane-1",
      cwd: "/repo",
      agentProfileId: "claude",
      spawnStartMs: 5_000,
      startsNewConversation: true,
      existingSessionIds: ["sibling"],
      isDisposed: () => false,
    });

    await vi.advanceTimersByTimeAsync(10_500);
    expect(notePaneResumeAnchor).not.toHaveBeenCalled();

    paneRuntime = { "pane-1": { status: "exited" } };
    await vi.advanceTimersByTimeAsync(10_000);
    await promise;
  });
});

describe("hasTranscriptTitle", () => {
  it("rejects timestamp fallbacks so the header keeps refreshing", () => {
    expect(
      hasTranscriptTitle({
        title: "Sessão de 26/08/2026, 09:28:00",
        fromTranscript: false,
      }),
    ).toBe(false);
  });

  it("accepts the first user message once it is on disk", () => {
    expect(
      hasTranscriptTitle({ title: "test", fromTranscript: true }),
    ).toBe(true);
  });
});
