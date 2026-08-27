import { beforeEach, describe, expect, it, vi } from "vitest";

import { type AgentSession } from "../types/session";
import { EMPTY_GIT_CONTEXT } from "../types/git-context";
import { collectPaneIds } from "./session-layout";
import { createEmptySession, useSessionStore } from "./session-manager";

function session(id: string, pinned = false): AgentSession {
  return createEmptySession({
    id,
    title: id,
    cwd: "/tmp",
    agentProfileId: "shell",
    pinned,
  });
}

describe("useSessionStore session order", () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    useSessionStore.setState(useSessionStore.getInitialState(), true);
  });

  it("does not reorder sessions while hydrating, adding, or pinning", () => {
    const first = session("first");
    const second = session("second", true);
    const third = session("third");

    useSessionStore.getState().hydrateWorkspace([first, second], first.id, null);
    expect(useSessionStore.getState().sessions.map((item) => item.id)).toEqual([
      "first",
      "second",
    ]);

    useSessionStore.getState().addSession(third);
    expect(useSessionStore.getState().sessions.map((item) => item.id)).toEqual([
      "first",
      "second",
      "third",
    ]);

    useSessionStore.getState().togglePinSession(third.id);
    expect(useSessionStore.getState().sessions.map((item) => item.id)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });
});

describe("useSessionStore restartPane continue flag", () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    useSessionStore.setState(useSessionStore.getInitialState(), true);
  });

  it("clears restoredPaneIds when restarting for a fresh conversation", () => {
    const first = session("first");
    const paneId = collectPaneIds(first.layout)[0];
    useSessionStore.getState().hydrateWorkspace([first], first.id, paneId);
    expect(useSessionStore.getState().restoredPaneIds[paneId]).toBe(true);

    useSessionStore.getState().restartPane(paneId, {
      continueConversation: false,
    });

    expect(useSessionStore.getState().restoredPaneIds[paneId]).toBeUndefined();
    expect(useSessionStore.getState().paneRestartKeys[paneId]).toBe(1);
  });

  it("keeps restoredPaneIds when restarting to continue the conversation", () => {
    const first = session("first");
    const paneId = collectPaneIds(first.layout)[0];
    useSessionStore.getState().hydrateWorkspace([first], first.id, paneId);

    useSessionStore.getState().restartPane(paneId, {
      continueConversation: true,
    });

    expect(useSessionStore.getState().restoredPaneIds[paneId]).toBe(true);
    expect(useSessionStore.getState().paneRestartKeys[paneId]).toBe(1);
  });

  it("leaves restoredPaneIds alone when options are omitted", () => {
    const first = session("first");
    const paneId = collectPaneIds(first.layout)[0];
    useSessionStore.getState().hydrateWorkspace([first], first.id, paneId);

    useSessionStore.getState().restartPane(paneId);

    expect(useSessionStore.getState().restoredPaneIds[paneId]).toBe(true);
  });
});

describe("useSessionStore hydrateWorkspace pane resume anchors", () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    useSessionStore.setState(useSessionStore.getInitialState(), true);
  });

  it("resumes an anchored pane precisely, even when it isn't the active pane", () => {
    const first = session("first");
    const paneId = collectPaneIds(first.layout)[0];
    const otherPaneId = "some-other-pane";

    useSessionStore
      .getState()
      .hydrateWorkspace([first], first.id, otherPaneId, { [paneId]: "anchor-abc" });

    expect(useSessionStore.getState().paneResumeSessionIds[paneId]).toBe("anchor-abc");
    expect(useSessionStore.getState().restoredPaneIds[paneId]).toBe(true);
  });

  it("only blanket-continues the active pane, and leaves other anchor-less panes fresh — the fix for panes colliding onto the same conversation on restart", () => {
    const first = session("first");
    useSessionStore.getState().addSession(first);
    // Both splits target the still-active original pane, so this ends up
    // with 3 panes total in one session (a common "3 terminals" layout).
    useSessionStore.getState().splitActivePane("vertical");
    useSessionStore.getState().splitActivePane("horizontal");
    const sessionWithPanes = useSessionStore.getState().sessions[0];
    const allPaneIds = collectPaneIds(sessionWithPanes.layout);
    expect(new Set(allPaneIds).size).toBe(3);
    const [paneA, paneB, paneC] = allPaneIds;

    // Simulate an app restart: only paneB (the active one) has no anchor
    // yet; paneA has a real anchor from a previous run; paneC has neither
    // an anchor nor focus.
    useSessionStore.setState(useSessionStore.getInitialState(), true);
    useSessionStore
      .getState()
      .hydrateWorkspace([sessionWithPanes], sessionWithPanes.id, paneB, {
        [paneA]: "anchor-a",
      });

    const state = useSessionStore.getState();
    expect(state.paneResumeSessionIds[paneA]).toBe("anchor-a");
    expect(state.restoredPaneIds[paneA]).toBe(true);

    expect(state.paneResumeSessionIds[paneB]).toBeUndefined();
    expect(state.restoredPaneIds[paneB]).toBe(true);

    expect(state.paneResumeSessionIds[paneC]).toBeUndefined();
    expect(state.restoredPaneIds[paneC]).toBeUndefined();
  });
});

describe("useSessionStore notePaneResumeAnchor", () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    useSessionStore.setState(useSessionStore.getInitialState(), true);
  });

  it("records the auto-detected session id without forcing a restart", () => {
    const first = session("first");
    const paneId = collectPaneIds(first.layout)[0];
    useSessionStore.getState().addSession(first);
    const restartKeyBefore = useSessionStore.getState().paneRestartKeys[paneId] ?? 0;

    useSessionStore.getState().notePaneResumeAnchor(paneId, "detected-xyz");

    expect(useSessionStore.getState().paneResumeAnchors[paneId]).toBe("detected-xyz");
    expect(useSessionStore.getState().paneRestartKeys[paneId] ?? 0).toBe(restartKeyBefore);
  });

  it("is a no-op for a pane that does not belong to any session", () => {
    const before = useSessionStore.getState();
    useSessionStore.getState().notePaneResumeAnchor("missing-pane", "detected-xyz");
    expect(useSessionStore.getState()).toBe(before);
  });

  it("clears the anchor when the CLI refuses to resume it, without restarting the pane", () => {
    const first = session("first");
    const paneId = collectPaneIds(first.layout)[0];
    useSessionStore.getState().addSession(first);
    useSessionStore.getState().notePaneResumeAnchor(paneId, "detected-xyz");
    const restartKeyBefore = useSessionStore.getState().paneRestartKeys[paneId] ?? 0;

    useSessionStore.getState().clearPaneResumeAnchor(paneId);

    expect(useSessionStore.getState().paneResumeAnchors[paneId]).toBeUndefined();
    expect(useSessionStore.getState().paneRestartKeys[paneId] ?? 0).toBe(restartKeyBefore);
  });

  it("drops the anchor when the pane is closed", () => {
    const first = session("first");
    const [firstPaneId] = collectPaneIds(first.layout);
    useSessionStore.getState().addSession(first);
    useSessionStore.getState().splitActivePane("vertical");
    const paneId = collectPaneIds(
      useSessionStore.getState().sessions[0].layout,
    ).find((id) => id !== firstPaneId)!;
    useSessionStore.getState().notePaneResumeAnchor(paneId, "detected-xyz");

    useSessionStore.getState().closePane(paneId);

    expect(useSessionStore.getState().paneResumeAnchors[paneId]).toBeUndefined();
  });
});

describe("useSessionStore resumePane", () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    useSessionStore.setState(useSessionStore.getInitialState(), true);
  });

  it("records the picked session id, marks restored, and bumps the restart key", () => {
    const first = session("first");
    const paneId = collectPaneIds(first.layout)[0];
    useSessionStore.getState().addSession(first);

    useSessionStore.getState().resumePane(paneId, "abc-123");

    expect(useSessionStore.getState().paneResumeSessionIds[paneId]).toBe("abc-123");
    expect(useSessionStore.getState().restoredPaneIds[paneId]).toBe(true);
    expect(useSessionStore.getState().paneRestartKeys[paneId]).toBe(1);
  });

  it("is a no-op for a pane that does not belong to any session", () => {
    const before = useSessionStore.getState();
    useSessionStore.getState().resumePane("missing-pane", "abc-123");
    expect(useSessionStore.getState()).toBe(before);
  });

  it("clears a picked resume id on the next plain restart", () => {
    const first = session("first");
    const paneId = collectPaneIds(first.layout)[0];
    useSessionStore.getState().addSession(first);
    useSessionStore.getState().resumePane(paneId, "abc-123");

    useSessionStore.getState().restartPane(paneId, { continueConversation: true });

    expect(useSessionStore.getState().paneResumeSessionIds[paneId]).toBeUndefined();
  });

  it("drops the pane's resume id when the pane is closed", () => {
    const first = session("first");
    const [firstPaneId] = collectPaneIds(first.layout);
    useSessionStore.getState().addSession(first);
    useSessionStore.getState().splitActivePane("vertical");
    const paneId = collectPaneIds(
      useSessionStore.getState().sessions[0].layout,
    ).find((id) => id !== firstPaneId)!;
    useSessionStore.getState().resumePane(paneId, "abc-123");

    useSessionStore.getState().closePane(paneId);

    expect(useSessionStore.getState().paneResumeSessionIds[paneId]).toBeUndefined();
  });
});

describe("useSessionStore conversation labels", () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    useSessionStore.setState(useSessionStore.getInitialState(), true);
  });

  it("names a conversation by its CLI session id and clears it with an empty name", () => {
    useSessionStore.getState().setConversationLabel("abc-123", "  Refactor   do PDF  ");
    expect(useSessionStore.getState().conversationLabels["abc-123"]).toBe(
      "Refactor do PDF",
    );

    useSessionStore.getState().setConversationLabel("abc-123", "   ");
    expect(useSessionStore.getState().conversationLabels["abc-123"]).toBeUndefined();
  });

  it("renames the conversation a pane is already on", () => {
    const first = session("first");
    const paneId = collectPaneIds(first.layout)[0];
    useSessionStore.getState().addSession(first);
    useSessionStore.getState().notePaneResumeAnchor(paneId, "abc-123");

    useSessionStore.getState().setPaneConversationLabel(paneId, "Faturamento");

    expect(useSessionStore.getState().conversationLabels["abc-123"]).toBe(
      "Faturamento",
    );
    expect(useSessionStore.getState().pendingConversationLabels[paneId]).toBeUndefined();
  });

  it("parks a name typed before the CLI session id is known and applies it on anchor", () => {
    const first = session("first");
    const paneId = collectPaneIds(first.layout)[0];
    useSessionStore.getState().addSession(first);

    useSessionStore.getState().setPaneConversationLabel(paneId, "Faturamento");
    expect(useSessionStore.getState().pendingConversationLabels[paneId]).toBe(
      "Faturamento",
    );

    useSessionStore.getState().notePaneResumeAnchor(paneId, "abc-123");

    expect(useSessionStore.getState().conversationLabels["abc-123"]).toBe(
      "Faturamento",
    );
    expect(useSessionStore.getState().pendingConversationLabels[paneId]).toBeUndefined();
  });

  it("does not carry a parked name onto a conversation picked from the dropdown", () => {
    const first = session("first");
    const paneId = collectPaneIds(first.layout)[0];
    useSessionStore.getState().addSession(first);
    useSessionStore.getState().setPaneConversationLabel(paneId, "Faturamento");

    useSessionStore.getState().resumePane(paneId, "other-999");

    expect(useSessionStore.getState().conversationLabels["other-999"]).toBeUndefined();
    expect(useSessionStore.getState().pendingConversationLabels[paneId]).toBeUndefined();
  });

  it("drops a parked name when the pane restarts into a fresh conversation", () => {
    const first = session("first");
    const paneId = collectPaneIds(first.layout)[0];
    useSessionStore.getState().addSession(first);
    useSessionStore.getState().setPaneConversationLabel(paneId, "Faturamento");

    useSessionStore.getState().restartPane(paneId, { continueConversation: false });

    expect(useSessionStore.getState().pendingConversationLabels[paneId]).toBeUndefined();
  });

  it("keeps names of conversations whose panes are gone, since ids outlive panes", () => {
    const first = session("first");
    const [firstPaneId] = collectPaneIds(first.layout);
    useSessionStore.getState().addSession(first);
    useSessionStore.getState().splitActivePane("vertical");
    const paneId = collectPaneIds(
      useSessionStore.getState().sessions[0].layout,
    ).find((id) => id !== firstPaneId)!;
    useSessionStore.getState().notePaneResumeAnchor(paneId, "abc-123");
    useSessionStore.getState().setPaneConversationLabel(paneId, "Faturamento");

    useSessionStore.getState().closePane(paneId);

    expect(useSessionStore.getState().conversationLabels["abc-123"]).toBe(
      "Faturamento",
    );
  });

  it("caches transcript titles without touching the user's names", () => {
    useSessionStore.getState().setConversationLabel("abc-123", "Faturamento");
    useSessionStore.getState().noteConversationTitles([
      { id: "abc-123", title: "primeira mensagem" },
      { id: "def-456", title: "outra conversa" },
    ]);

    expect(useSessionStore.getState().conversationTitles["abc-123"]).toBe(
      "primeira mensagem",
    );
    expect(useSessionStore.getState().conversationTitles["def-456"]).toBe(
      "outra conversa",
    );
    expect(useSessionStore.getState().conversationLabels["abc-123"]).toBe(
      "Faturamento",
    );
  });
});

describe("useSessionStore git context merge", () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    useSessionStore.setState(useSessionStore.getInitialState(), true);
  });

  it("does not replace pane git context when only lastTouchedAt or source change", () => {
    const first = session("first");
    const paneId = collectPaneIds(first.layout)[0];
    useSessionStore.getState().addSession(first);
    useSessionStore.getState().mergePaneGitContext(paneId, {
      ...EMPTY_GIT_CONTEXT,
      repoRoot: "/repo",
      branch: "main",
      lastTouchedPath: "src/a.ts",
      lastTouchedAt: 10,
      source: "initial",
    });
    const before = useSessionStore.getState().paneGitContext[paneId];

    useSessionStore.getState().mergePaneGitContext(paneId, {
      ...before,
      lastTouchedAt: 99,
      source: "poll",
    });

    expect(useSessionStore.getState().paneGitContext[paneId]).toBe(before);
  });

  it("updates lastTouchedPath without a git IPC payload", () => {
    const first = session("first");
    const paneId = collectPaneIds(first.layout)[0];
    useSessionStore.getState().addSession(first);
    useSessionStore.getState().mergePaneGitContext(paneId, {
      ...EMPTY_GIT_CONTEXT,
      repoRoot: "/repo",
      branch: "main",
    });

    useSessionStore.getState().mergePaneGitContext(paneId, {
      lastTouchedPath: "src/b.ts",
      lastTouchedAt: 50,
    });

    expect(useSessionStore.getState().paneGitContext[paneId]).toMatchObject({
      repoRoot: "/repo",
      branch: "main",
      lastTouchedPath: "src/b.ts",
    });
  });
});
