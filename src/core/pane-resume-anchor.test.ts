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

import type { AgentHookEvent } from "../types/agent-hooks";
import {
  anchorPaneResumeSession,
  anchorPaneToHookSession,
  hasTranscriptTitle,
  PaneForegroundSession,
  resetHookSessionClaimsForTests,
} from "./pane-resume-anchor";
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

function hookEvent(event: string, sessionId?: string): AgentHookEvent {
  return { paneId: "pane-1", source: "claude", event, sessionId, receivedAt: 0 };
}

describe("PaneForegroundSession", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("adopts the conversation of the prompt the pane just submitted, and speaks only for it", () => {
    const adopted: string[] = [];
    const pane = new PaneForegroundSession((id) => adopted.push(id));

    // A background session dispatched earlier from this pane reports through
    // the same settings file: before the pane's own prompt, none of it counts.
    expect(pane.accepts(hookEvent("PermissionRequest", "bg-1"))).toBe(false);
    expect(pane.accepts(hookEvent("UserPromptSubmit", "bg-1"))).toBe(false);
    // Events that carry no id at all still pass.
    expect(pane.accepts(hookEvent("Notification"))).toBe(true);

    pane.noteUserInput("oi");
    pane.noteUserInput("\r");
    vi.advanceTimersByTime(120);
    expect(pane.accepts(hookEvent("UserPromptSubmit", "fg-1"))).toBe(true);
    expect(adopted).toEqual(["fg-1"]);
    expect(pane.id).toBe("fg-1");

    expect(pane.accepts(hookEvent("PermissionRequest", "fg-1"))).toBe(true);
    expect(pane.accepts(hookEvent("Stop", "fg-1"))).toBe(true);
    // Once known, the background session stays out.
    expect(pane.accepts(hookEvent("PermissionRequest", "bg-1"))).toBe(false);
    expect(pane.accepts(hookEvent("UserPromptSubmit", "bg-1"))).toBe(false);
  });

  it("learns the new conversation after /clear (and the app's own Clear)", () => {
    // scratchpad/verif5/clear-probe.cjs: /clear fires no hook of its own; the
    // next prompt arrives with a brand new session_id.
    const adopted: string[] = [];
    const pane = new PaneForegroundSession((id) => adopted.push(id));
    pane.noteUserInput("primeira pergunta\r");
    pane.accepts(hookEvent("UserPromptSubmit", "before-clear"));

    pane.noteUserInput("/clear\r");
    vi.advanceTimersByTime(3000);
    pane.noteUserInput("segunda pergunta\r");
    vi.advanceTimersByTime(80);
    expect(pane.accepts(hookEvent("UserPromptSubmit", "after-clear"))).toBe(true);
    expect(adopted).toEqual(["before-clear", "after-clear"]);

    expect(pane.accepts(hookEvent("PermissionRequest", "after-clear"))).toBe(true);
    // The old conversation, still on disk, no longer speaks for the pane.
    expect(pane.accepts(hookEvent("Stop", "before-clear"))).toBe(false);
  });

  it("adopts nothing without an Enter of its own close behind", () => {
    const adopted: string[] = [];
    const pane = new PaneForegroundSession((id) => adopted.push(id));
    pane.noteUserInput("\r");
    vi.advanceTimersByTime(10_001);
    expect(pane.accepts(hookEvent("UserPromptSubmit", "late"))).toBe(false);

    // A line break inside a bracketed paste submits nothing.
    pane.noteUserInput("\x1b[200~a\rb\x1b[201~");
    expect(pane.accepts(hookEvent("UserPromptSubmit", "pasted"))).toBe(false);

    // One Enter, one prompt: a second session's prompt in the same window is
    // not the pane's.
    pane.noteUserInput("\r");
    expect(pane.accepts(hookEvent("UserPromptSubmit", "mine"))).toBe(true);
    expect(pane.accepts(hookEvent("UserPromptSubmit", "someone-else"))).toBe(false);
    expect(adopted).toEqual(["mine"]);
  });
});

describe("anchorPaneToHookSession", () => {
  beforeEach(() => {
    listResumable.mockReset();
    notePaneResumeAnchor.mockReset();
    noteConversationTitles.mockReset();
    resetHookSessionClaimsForTests();
    paneRuntime = { "pane-1": { status: "running" }, "pane-2": { status: "running" } };
    paneResumeAnchors = {};
    notePaneResumeAnchor.mockImplementation((paneId: string, sessionId: string) => {
      paneResumeAnchors = { ...paneResumeAnchors, [paneId]: sessionId };
    });
    vi.stubGlobal("window", {
      headTerminal: { sessions: { listResumable } },
    });
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

  const lookup = (paneId: string) => ({
    paneId,
    cwd: "/repo",
    agentProfileId: "claude",
    isDisposed: () => false,
  });

  it("anchors the pane on the conversation its hooks proved, and names it", async () => {
    listResumable.mockResolvedValue([
      { id: "fg-1", title: "minha pergunta", updatedAt: new Date(6_000).toISOString() },
    ]);
    const done = anchorPaneToHookSession({ ...lookup("pane-1"), sessionId: "fg-1" });
    expect(notePaneResumeAnchor).toHaveBeenCalledExactlyOnceWith("pane-1", "fg-1");
    await vi.advanceTimersByTimeAsync(2_500);
    await done;
    expect(noteConversationTitles).toHaveBeenCalledWith([
      expect.objectContaining({ id: "fg-1", title: "minha pergunta" }),
    ]);
  });

  it("keeps two fresh panes in one folder from swapping conversations", async () => {
    // e2e ANCHOR-swap: the idle pane's poll adopted the transcript of the
    // sibling where the user typed first, then the sibling adopted its own —
    // headers and restarts swapped, and every hook got filtered out.
    const y = { id: "conv-y", title: "pergunta do Y", updatedAt: new Date(6_000).toISOString() };
    const x = { id: "conv-x", title: "pergunta do X", updatedAt: new Date(9_000).toISOString() };
    listResumable.mockResolvedValue([]);
    const pollX = anchorPaneResumeSession({
      ...lookup("pane-1"),
      spawnStartMs: 0,
      startsNewConversation: true,
      existingSessionIds: [],
    });
    const pollY = anchorPaneResumeSession({
      ...lookup("pane-2"),
      spawnStartMs: 0,
      startsNewConversation: true,
      existingSessionIds: [],
    });

    // The user types in Y: its prompt hook claims conv-y right away.
    const paneY = new PaneForegroundSession((id) => {
      void anchorPaneToHookSession({ ...lookup("pane-2"), sessionId: id });
    });
    paneY.noteUserInput("pergunta do Y\r");
    paneY.accepts({ ...hookEvent("UserPromptSubmit", "conv-y"), paneId: "pane-2" });
    listResumable.mockResolvedValue([y]);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(paneResumeAnchors).toEqual({ "pane-2": "conv-y" });

    // Y clears and asks again: conv-y is no longer its anchor, but it is
    // still Y's conversation, not one for X's poll to pick up.
    const y2 = { id: "conv-y2", title: "depois do clear", updatedAt: new Date(8_000).toISOString() };
    paneY.noteUserInput("/clear\r");
    paneY.noteUserInput("depois do clear\r");
    paneY.accepts({ ...hookEvent("UserPromptSubmit", "conv-y2"), paneId: "pane-2" });
    listResumable.mockResolvedValue([y2, y]);
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(paneResumeAnchors).toEqual({ "pane-2": "conv-y2" });

    // Later the user types in X.
    const paneX = new PaneForegroundSession((id) => {
      void anchorPaneToHookSession({ ...lookup("pane-1"), sessionId: id });
    });
    paneX.noteUserInput("pergunta do X\r");
    paneX.accepts(hookEvent("UserPromptSubmit", "conv-x"));
    listResumable.mockResolvedValue([x, y2, y]);
    await vi.advanceTimersByTimeAsync(20_000);
    await Promise.all([pollX, pollY]);

    expect(paneResumeAnchors).toEqual({ "pane-1": "conv-x", "pane-2": "conv-y2" });
    expect(notePaneResumeAnchor).not.toHaveBeenCalledWith("pane-1", "conv-y");
    expect(notePaneResumeAnchor).not.toHaveBeenCalledWith("pane-1", "conv-y2");
    expect(notePaneResumeAnchor).not.toHaveBeenCalledWith("pane-2", "conv-x");
  });

  it("stops polling once the pane's hooks anchored it", async () => {
    listResumable.mockResolvedValue([]);
    const poll = anchorPaneResumeSession({
      ...lookup("pane-1"),
      spawnStartMs: 0,
      startsNewConversation: false,
    });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(listResumable).toHaveBeenCalledTimes(1);

    listResumable.mockResolvedValue([
      { id: "fg-1", title: "minha pergunta", updatedAt: new Date(6_000).toISOString() },
    ]);
    const adoption = anchorPaneToHookSession({ ...lookup("pane-1"), sessionId: "fg-1" });
    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.all([poll, adoption]);
    // The poll's first lookup, then only the adoption's own title lookup
    // (named on the first try): the poll is over.
    expect(listResumable).toHaveBeenCalledTimes(2);
    expect(notePaneResumeAnchor).toHaveBeenCalledExactlyOnceWith("pane-1", "fg-1");
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
