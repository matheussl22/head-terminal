import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type AgentSession } from "../types/session";
import { EMPTY_GIT_CONTEXT } from "../types/git-context";
import {
  collectPaneIds,
  findPaneNode,
  resolvePaneCwd,
} from "./session-layout";
import { createEmptySession, isPaneOnScreen, useSessionStore } from "./session-manager";

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

describe("useSessionStore pane folders", () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    useSessionStore.setState(useSessionStore.getInitialState(), true);
  });

  function withSplitSession() {
    const store = useSessionStore.getState();
    const created = createEmptySession({
      id: "s",
      title: "s",
      cwd: "C:\\Users\\m\\default",
      agentProfileId: "claude",
    });
    store.addSession(created);
    const [first] = collectPaneIds(created.layout);
    useSessionStore.getState().setActivePaneId(first);
    useSessionStore.getState().splitActivePane("vertical");
    const session = useSessionStore.getState().sessions[0];
    const [, second] = collectPaneIds(session.layout);
    return { first, second };
  }

  it("moves one terminal to its own folder and restarts only that terminal", () => {
    const { first, second } = withSplitSession();
    const before = useSessionStore.getState().paneRestartKeys;

    useSessionStore.getState().updatePaneCwd(second, "D:\\repo");

    const state = useSessionStore.getState();
    const session = state.sessions[0];
    expect(resolvePaneCwd(session, second)).toBe("D:\\repo");
    expect(resolvePaneCwd(session, first)).toBe("C:\\Users\\m\\default");
    expect(session.cwd).toBe("C:\\Users\\m\\default");
    expect(state.paneRestartKeys[second] ?? 0).toBe((before[second] ?? 0) + 1);
    expect(state.paneRestartKeys[first] ?? 0).toBe(before[first] ?? 0);
  });

  it("does nothing when the folder is already the pane's", () => {
    const { second } = withSplitSession();
    const before = useSessionStore.getState().paneRestartKeys[second] ?? 0;

    useSessionStore.getState().updatePaneCwd(second, "C:\\Users\\m\\default");
    useSessionStore.getState().updatePaneCwd(second, "   ");

    expect(useSessionStore.getState().paneRestartKeys[second] ?? 0).toBe(before);
  });

  it("puts a pane back on the session default instead of pinning a copy of it", () => {
    const { second } = withSplitSession();
    useSessionStore.getState().updatePaneCwd(second, "D:\\repo");
    useSessionStore.getState().updatePaneCwd(second, "C:\\Users\\m\\default");

    const session = useSessionStore.getState().sessions[0];
    expect(findPaneNode(session.layout, second)?.cwd).toBeUndefined();
  });

  it("splits inherit a pinned folder, and follow the session otherwise", () => {
    const { first, second } = withSplitSession();
    useSessionStore.getState().updatePaneCwd(second, "D:\\repo");

    useSessionStore.getState().setActivePaneId(second);
    useSessionStore.getState().splitActivePane("horizontal");
    let session = useSessionStore.getState().sessions[0];
    const pinnedChild = collectPaneIds(session.layout).find(
      (id) => id !== first && id !== second,
    )!;
    expect(resolvePaneCwd(session, pinnedChild)).toBe("D:\\repo");

    useSessionStore.getState().setActivePaneId(first);
    useSessionStore.getState().splitActivePane("horizontal");
    session = useSessionStore.getState().sessions[0];
    const plainChild = collectPaneIds(session.layout).find(
      (id) => ![first, second, pinnedChild].includes(id),
    )!;
    expect(findPaneNode(session.layout, plainChild)?.cwd).toBeUndefined();
    expect(resolvePaneCwd(session, plainChild)).toBe("C:\\Users\\m\\default");
  });

  it("moving the session takes every pane along, pinned ones included", () => {
    const { first, second } = withSplitSession();
    useSessionStore.getState().updatePaneCwd(second, "D:\\repo");

    useSessionStore.getState().updateSessionCwd("s", "E:\\moved");

    const session = useSessionStore.getState().sessions[0];
    expect(resolvePaneCwd(session, first)).toBe("E:\\moved");
    expect(resolvePaneCwd(session, second)).toBe("E:\\moved");
    expect(findPaneNode(session.layout, second)?.cwd).toBeUndefined();
  });

  const worktree = {
    path: "D:\\repo-agent-1",
    branch: "agent-1",
    mainRepoRoot: "D:\\repo",
  };

  it("moves one terminal into its own worktree and restarts only it", () => {
    const { first, second } = withSplitSession();
    const before = useSessionStore.getState().paneRestartKeys;

    useSessionStore.getState().adoptPaneWorktree(second, worktree);

    const state = useSessionStore.getState();
    const session = state.sessions[0];
    expect(resolvePaneCwd(session, second)).toBe(worktree.path);
    expect(findPaneNode(session.layout, second)?.worktree).toEqual(worktree);
    expect(resolvePaneCwd(session, first)).toBe("C:\\Users\\m\\default");
    expect(state.paneRestartKeys[second] ?? 0).toBe((before[second] ?? 0) + 1);
    expect(state.paneRestartKeys[first] ?? 0).toBe(before[first] ?? 0);
  });

  it("takes the whole session into a worktree and brings every pane along", () => {
    const { first, second } = withSplitSession();
    useSessionStore.getState().updatePaneCwd(second, "D:\\elsewhere");

    useSessionStore.getState().adoptSessionWorktree("s", worktree);

    const session = useSessionStore.getState().sessions[0];
    expect(session.cwd).toBe(worktree.path);
    expect(session.worktree).toEqual(worktree);
    expect(resolvePaneCwd(session, first)).toBe(worktree.path);
    expect(resolvePaneCwd(session, second)).toBe(worktree.path);
  });

  it("drops the worktree mark once the folder is moved by hand", () => {
    const { second } = withSplitSession();
    useSessionStore.getState().adoptSessionWorktree("s", worktree);
    useSessionStore.getState().adoptPaneWorktree(second, worktree);

    // Sair da árvore isolada na mão: a sessão não responde mais por ela.
    useSessionStore.getState().updateSessionCwd("s", "E:\\moved");
    let session = useSessionStore.getState().sessions[0];
    expect(session.worktree).toBeUndefined();
    expect(findPaneNode(session.layout, second)?.worktree).toBeUndefined();

    useSessionStore.getState().adoptPaneWorktree(second, worktree);
    useSessionStore.getState().updatePaneCwd(second, "E:\\somewhere-else");
    session = useSessionStore.getState().sessions[0];
    expect(findPaneNode(session.layout, second)?.worktree).toBeUndefined();
  });

  /** Both panes on a conversation of their own, as after an app restart:
   * --resume ids picked, anchors known. */
  function anchorBoth(first: string, second: string) {
    useSessionStore.setState({
      restoredPaneIds: { [first]: true, [second]: true },
      paneResumeSessionIds: { [first]: "conv-1", [second]: "conv-2" },
      paneResumeAnchors: { [first]: "conv-1", [second]: "conv-2" },
    });
  }

  function expectNewConversation(paneId: string) {
    const state = useSessionStore.getState();
    expect(state.paneResumeAnchors[paneId]).toBeUndefined();
    expect(state.paneResumeSessionIds[paneId]).toBeUndefined();
    expect(state.restoredPaneIds[paneId]).toBeUndefined();
  }

  function expectKeptConversation(paneId: string, conversation: string) {
    const state = useSessionStore.getState();
    expect(state.paneResumeAnchors[paneId]).toBe(conversation);
    expect(state.paneResumeSessionIds[paneId]).toBe(conversation);
    expect(state.restoredPaneIds[paneId]).toBe(true);
  }

  // Review store-hooks-ui-fixes#0: a pane moved to another folder restarted
  // still anchored on the old folder's conversation — the header kept its
  // name, the hook filter dropped the new conversation's events, and the
  // restart (or the next app start) asked the CLI to --resume it where it
  // does not exist.
  it("starts a new conversation in a terminal's new folder, leaving the neighbour's alone", () => {
    const { first, second } = withSplitSession();
    anchorBoth(first, second);

    // Same folder: nothing restarts, nothing is forgotten.
    useSessionStore.getState().updatePaneCwd(second, "C:\\Users\\m\\default");
    expectKeptConversation(second, "conv-2");

    useSessionStore.getState().updatePaneCwd(second, "D:\\repo");
    expectNewConversation(second);
    expectKeptConversation(first, "conv-1");
  });

  it("starts a new conversation in the worktree a terminal moves into", () => {
    const { first, second } = withSplitSession();
    anchorBoth(first, second);

    useSessionStore.getState().adoptPaneWorktree(second, worktree);

    expectNewConversation(second);
    expectKeptConversation(first, "conv-1");
  });

  it("starts new conversations only in the terminals the session's worktree moves", () => {
    const { first, second } = withSplitSession();
    useSessionStore.getState().adoptPaneWorktree(second, {
      ...worktree,
      path: "D:\\repo-agent-2",
      branch: "agent-2",
    });
    anchorBoth(first, second);

    useSessionStore.getState().adoptSessionWorktree("s", worktree);

    expectNewConversation(first);
    // It already had a tree of its own and stays there, conversation included.
    expectKeptConversation(second, "conv-2");
  });

  it("keeps the mark when the session is pointed back at its own worktree", () => {
    withSplitSession();
    useSessionStore.getState().adoptSessionWorktree("s", worktree);

    useSessionStore.getState().updateSessionCwd("s", worktree.path);

    expect(useSessionStore.getState().sessions[0].worktree).toEqual(worktree);
  });
});

describe("useSessionStore maximized pane", () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    useSessionStore.setState(useSessionStore.getInitialState(), true);
  });

  function withSplitSession(sessionId = "s") {
    const created = session(sessionId);
    useSessionStore.getState().addSession(created);
    const [first] = collectPaneIds(created.layout);
    useSessionStore.getState().setActivePaneId(first);
    useSessionStore.getState().splitActivePane("vertical");
    const stored = useSessionStore
      .getState()
      .sessions.find((item) => item.id === sessionId)!;
    const [, second] = collectPaneIds(stored.layout);
    return { sessionId, first, second };
  }

  it("toggles the zoom on the pane's own session", () => {
    const { sessionId, first, second } = withSplitSession();

    useSessionStore.getState().toggleMaximizedPane(second);
    expect(useSessionStore.getState().maximizedPaneIds[sessionId]).toBe(second);

    // Maximizing another pane moves the zoom instead of stacking one.
    useSessionStore.getState().toggleMaximizedPane(first);
    expect(useSessionStore.getState().maximizedPaneIds[sessionId]).toBe(first);

    useSessionStore.getState().toggleMaximizedPane(first);
    expect(useSessionStore.getState().maximizedPaneIds[sessionId]).toBeUndefined();
  });

  it("ignores a session with a single terminal", () => {
    const created = session("solo");
    useSessionStore.getState().addSession(created);
    const [only] = collectPaneIds(created.layout);

    useSessionStore.getState().toggleMaximizedPane(only);

    expect(useSessionStore.getState().maximizedPaneIds.solo).toBeUndefined();
  });

  it("drops the zoom when the maximized pane or its last sibling closes", () => {
    const { sessionId, second } = withSplitSession();

    useSessionStore.getState().toggleMaximizedPane(second);
    useSessionStore.getState().closePane(second);
    expect(useSessionStore.getState().maximizedPaneIds[sessionId]).toBeUndefined();

    // Closing the sibling leaves a lone terminal: the zoom would hide nothing.
    const split = withSplitSession("t");
    useSessionStore.getState().toggleMaximizedPane(split.second);
    useSessionStore.getState().closePane(split.first);
    expect(useSessionStore.getState().maximizedPaneIds.t).toBeUndefined();
  });

  it("drops the zoom when a new pane is split off", () => {
    const { sessionId, second } = withSplitSession();

    useSessionStore.getState().toggleMaximizedPane(second);
    useSessionStore.getState().setActivePaneId(second);
    useSessionStore.getState().splitActivePane("horizontal");

    expect(useSessionStore.getState().maximizedPaneIds[sessionId]).toBeUndefined();
  });

  it("forgets the zoom of a removed session", () => {
    const { sessionId, second } = withSplitSession();

    useSessionStore.getState().toggleMaximizedPane(second);
    useSessionStore.getState().removeSession(sessionId);

    expect(useSessionStore.getState().maximizedPaneIds[sessionId]).toBeUndefined();
  });
});

describe("useSessionStore minimized panes", () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    useSessionStore.setState(useSessionStore.getInitialState(), true);
  });

  function withSplitSession(sessionId = "s") {
    const created = session(sessionId);
    useSessionStore.getState().addSession(created);
    const [first] = collectPaneIds(created.layout);
    useSessionStore.getState().setActivePaneId(first);
    useSessionStore.getState().splitActivePane("vertical");
    const stored = useSessionStore
      .getState()
      .sessions.find((item) => item.id === sessionId)!;
    const [, second] = collectPaneIds(stored.layout);
    return { sessionId, first, second };
  }

  it("minimizes a pane and hands the keyboard to one still on screen", () => {
    const { first, second } = withSplitSession();
    useSessionStore.getState().setActivePaneId(second);

    useSessionStore.getState().minimizePane(second);

    const state = useSessionStore.getState();
    expect(state.minimizedPanes[second]).toBeDefined();
    expect(state.activePaneId).toBe(first);
  });

  it("keeps the last pane active when every pane is minimized", () => {
    const created = session("solo");
    useSessionStore.getState().addSession(created);
    const [only] = collectPaneIds(created.layout);

    useSessionStore.getState().minimizePane(only);

    expect(useSessionStore.getState().minimizedPanes[only]).toBeDefined();
    expect(useSessionStore.getState().activePaneId).toBe(only);
  });

  it("restores a pane into its session and makes it the active one", () => {
    const { sessionId, first, second } = withSplitSession();
    useSessionStore.getState().minimizePane(second);
    useSessionStore.getState().addSession(session("other"));

    useSessionStore.getState().restorePane(second);

    const state = useSessionStore.getState();
    expect(state.minimizedPanes[second]).toBeUndefined();
    expect(state.activeSessionId).toBe(sessionId);
    expect(state.activePaneId).toBe(second);
    expect(state.minimizedPanes[first]).toBeUndefined();
  });

  it("ignores minimizing a pane twice or one that does not exist", () => {
    const { second } = withSplitSession();
    useSessionStore.getState().minimizePane(second);
    const minimized = useSessionStore.getState().minimizedPanes;

    useSessionStore.getState().minimizePane(second);
    useSessionStore.getState().minimizePane("missing");

    expect(useSessionStore.getState().minimizedPanes).toBe(minimized);
  });

  it("remembers when a minimized agent finishes a turn, until it works again or comes back", () => {
    const { second } = withSplitSession();
    const { updatePaneActivity } = useSessionStore.getState();
    useSessionStore.getState().setActivePaneId(second);
    updatePaneActivity(second, "working");
    useSessionStore.getState().minimizePane(second);
    expect(useSessionStore.getState().paneRuntime[second].doneAt).toBeUndefined();

    updatePaneActivity(second, "idle");
    const doneAt = useSessionStore.getState().paneRuntime[second].doneAt;
    expect(doneAt).toBeTypeOf("number");

    updatePaneActivity(second, "working");
    expect(useSessionStore.getState().paneRuntime[second].doneAt).toBeUndefined();

    updatePaneActivity(second, "idle");
    expect(useSessionStore.getState().paneRuntime[second].doneAt).toBeTypeOf("number");
    useSessionStore.getState().restorePane(second);
    expect(useSessionStore.getState().paneRuntime[second].doneAt).toBeUndefined();
  });

  it("does not call a blocked agent finished", () => {
    const { second } = withSplitSession();
    useSessionStore.getState().minimizePane(second);
    useSessionStore.getState().updatePaneActivity(second, "working");
    useSessionStore.getState().updatePaneActivity(second, "waiting_input", { reason: "approval" });

    expect(useSessionStore.getState().paneRuntime[second].doneAt).toBeUndefined();
  });

  it("does not track anything for panes on screen", () => {
    const { second } = withSplitSession();
    useSessionStore.getState().updatePaneActivity(second, "working");
    useSessionStore.getState().updatePaneActivity(second, "idle");

    expect(useSessionStore.getState().minimizedPanes[second]).toBeUndefined();
  });

  it("drops the minimized state of a closed pane or removed session", () => {
    const { sessionId, first, second } = withSplitSession();
    useSessionStore.getState().minimizePane(second);
    useSessionStore.getState().closePane(second);
    expect(useSessionStore.getState().minimizedPanes[second]).toBeUndefined();

    useSessionStore.getState().minimizePane(first);
    useSessionStore.getState().removeSession(sessionId);
    expect(useSessionStore.getState().minimizedPanes[first]).toBeUndefined();
  });

  it("puts the keyboard on a pane on screen when a session is picked", () => {
    const { sessionId, first, second } = withSplitSession();
    useSessionStore.getState().minimizePane(first);
    useSessionStore.getState().addSession(session("other"));

    useSessionStore.getState().setActiveSessionId(sessionId);

    expect(useSessionStore.getState().activePaneId).toBe(second);
  });

  it("drops the zoom when the zoomed pane or the last pane left beside it is minimized", () => {
    const { sessionId, first, second } = withSplitSession();
    useSessionStore.getState().toggleMaximizedPane(second);
    useSessionStore.getState().minimizePane(second);
    expect(useSessionStore.getState().maximizedPaneIds[sessionId]).toBeUndefined();

    useSessionStore.getState().restorePane(second);
    useSessionStore.getState().toggleMaximizedPane(first);
    useSessionStore.getState().minimizePane(second);
    expect(useSessionStore.getState().maximizedPaneIds[sessionId]).toBeUndefined();
  });

  it("does not zoom while only one pane is on screen", () => {
    const { sessionId, first, second } = withSplitSession();
    useSessionStore.getState().minimizePane(second);

    useSessionStore.getState().toggleMaximizedPane(first);
    useSessionStore.getState().toggleMaximizedPane(second);

    expect(useSessionStore.getState().maximizedPaneIds[sessionId]).toBeUndefined();
  });

  it("restoring a pane drops a zoom that would keep it hidden", () => {
    const created = session("three");
    useSessionStore.getState().addSession(created);
    const [a] = collectPaneIds(created.layout);
    useSessionStore.getState().setActivePaneId(a);
    useSessionStore.getState().splitActivePane("vertical");
    useSessionStore.getState().splitActivePane("horizontal");
    const [, zoomed, minimized] = collectPaneIds(
      useSessionStore.getState().sessions.find((item) => item.id === "three")!.layout,
    );
    useSessionStore.getState().minimizePane(minimized);
    useSessionStore.getState().toggleMaximizedPane(zoomed);
    expect(useSessionStore.getState().maximizedPaneIds.three).toBe(zoomed);

    useSessionStore.getState().restorePane(minimized);

    expect(useSessionStore.getState().maximizedPaneIds.three).toBeUndefined();
  });

  it("splitting a minimized active pane moves the keyboard to the new one", () => {
    const created = session("solo");
    useSessionStore.getState().addSession(created);
    const [only] = collectPaneIds(created.layout);
    useSessionStore.getState().minimizePane(only);

    useSessionStore.getState().splitActivePane("vertical");

    const layout = useSessionStore.getState().sessions[0].layout;
    const [, added] = collectPaneIds(layout);
    expect(useSessionStore.getState().activePaneId).toBe(added);
    expect(useSessionStore.getState().minimizedPanes[only]).toBeDefined();
  });

  it("tracks what a pane is blocked on and clears it on restart", () => {
    const { second } = withSplitSession();
    useSessionStore
      .getState()
      .updatePaneActivity(second, "waiting_input", { reason: "approval", detail: "Bash" });
    expect(useSessionStore.getState().paneRuntime[second]).toMatchObject({
      activity: "waiting_input",
      blockedReason: "approval",
      blockedDetail: "Bash",
    });

    useSessionStore.getState().restartPane(second);

    const runtime = useSessionStore.getState().paneRuntime[second];
    expect(runtime.activity).toBe("starting");
    expect(runtime.blockedReason).toBeUndefined();
    expect(runtime.blockedDetail).toBeUndefined();
  });
});

describe("useSessionStore pane status", () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    useSessionStore.setState(useSessionStore.getInitialState(), true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function withSplitSession(sessionId = "s") {
    const created = session(sessionId);
    useSessionStore.getState().addSession(created);
    const [first] = collectPaneIds(created.layout);
    useSessionStore.getState().setActivePaneId(first);
    useSessionStore.getState().splitActivePane("vertical");
    const stored = useSessionStore
      .getState()
      .sessions.find((item) => item.id === sessionId)!;
    const [, second] = collectPaneIds(stored.layout);
    return { sessionId, first, second };
  }

  function finishTurn(paneId: string) {
    useSessionStore.getState().updatePaneActivity(paneId, "working");
    useSessionStore.getState().updatePaneActivity(paneId, "idle");
    return useSessionStore.getState().paneRuntime[paneId];
  }

  it("marks a turn that ended in a pane nobody looks at as done, until it is focused", () => {
    const { second } = withSplitSession();

    expect(finishTurn(second).doneAt).toBeTypeOf("number");

    useSessionStore.getState().setActivePaneId(second);
    expect(useSessionStore.getState().paneRuntime[second].doneAt).toBeUndefined();
  });

  it("does not mark a turn the user watched end", () => {
    const { first } = withSplitSession();
    expect(finishTurn(first).doneAt).toBeUndefined();
  });

  it("counts a window in the background as nobody watching", () => {
    const { first } = withSplitSession();
    vi.stubGlobal("document", { visibilityState: "visible", hasFocus: () => false });

    expect(finishTurn(first).doneAt).toBeTypeOf("number");

    // Typing into the pane is looking at it.
    useSessionStore.getState().markPaneSeen(first);
    expect(useSessionStore.getState().paneRuntime[first].doneAt).toBeUndefined();
  });

  it("counts a pane hidden by a zoomed sibling as unwatched", () => {
    const { first, second } = withSplitSession();
    useSessionStore.getState().toggleMaximizedPane(second);
    expect(finishTurn(first).doneAt).toBeTypeOf("number");
  });

  it("marks the pane that gets the keyboard as seen when switching sessions", () => {
    const { sessionId, first } = withSplitSession();
    useSessionStore.getState().addSession(session("other"));
    expect(finishTurn(first).doneAt).toBeTypeOf("number");

    useSessionStore.getState().setActiveSessionId(sessionId);

    expect(useSessionStore.getState().activePaneId).toBe(first);
    expect(useSessionStore.getState().paneRuntime[first].doneAt).toBeUndefined();
  });

  it("drops done as soon as the pane does anything else", () => {
    const { second } = withSplitSession();
    finishTurn(second);
    useSessionStore
      .getState()
      .updatePaneActivity(second, "waiting_input", { reason: "question" });
    expect(useSessionStore.getState().paneRuntime[second].doneAt).toBeUndefined();
  });

  it("refines a block without restarting its clock, and forgets it when it ends", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { second } = withSplitSession();
    const { updatePaneActivity } = useSessionStore.getState();

    updatePaneActivity(second, "waiting_input", { reason: "approval" });
    vi.setSystemTime(1_200);
    updatePaneActivity(second, "waiting_input", { reason: "question" });
    expect(useSessionStore.getState().paneRuntime[second]).toMatchObject({
      blockedReason: "question",
      activitySince: 1_000,
    });

    updatePaneActivity(second, "working");
    expect(useSessionStore.getState().paneRuntime[second].blockedReason).toBeUndefined();
  });

  it("keeps the agent's exit code with the fallback shell only", () => {
    const { second } = withSplitSession();
    const { updatePaneActivity } = useSessionStore.getState();
    updatePaneActivity(second, "agent_fallback", undefined, { agentExitCode: 0 });
    expect(useSessionStore.getState().paneRuntime[second].agentExitCode).toBe(0);

    updatePaneActivity(second, "idle");
    expect(useSessionStore.getState().paneRuntime[second].agentExitCode).toBeUndefined();
  });

  it("clears everything the old process left when the pane restarts", () => {
    const { second } = withSplitSession();
    finishTurn(second);
    useSessionStore.getState().restartPane(second);

    const runtime = useSessionStore.getState().paneRuntime[second];
    expect(runtime.activity).toBe("starting");
    expect(runtime.doneAt).toBeUndefined();
  });

  it("does not touch the store for a pane seen with nothing to clear", () => {
    const { first } = withSplitSession();
    const before = useSessionStore.getState().paneRuntime;
    useSessionStore.getState().markPaneSeen(first);
    expect(useSessionStore.getState().paneRuntime).toBe(before);
  });
});

describe("useSessionStore reads \"Concluído\" only off a pane on screen", () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    useSessionStore.setState(useSessionStore.getInitialState(), true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function withSplitSession(sessionId = "s") {
    const created = session(sessionId);
    useSessionStore.getState().addSession(created);
    const [first] = collectPaneIds(created.layout);
    useSessionStore.getState().setActivePaneId(first);
    useSessionStore.getState().splitActivePane("vertical");
    const stored = useSessionStore
      .getState()
      .sessions.find((item) => item.id === sessionId)!;
    const [, second] = collectPaneIds(stored.layout);
    return { sessionId, first, second };
  }

  function withThreePanes(sessionId = "three") {
    const created = session(sessionId);
    useSessionStore.getState().addSession(created);
    const [a] = collectPaneIds(created.layout);
    useSessionStore.getState().setActivePaneId(a);
    useSessionStore.getState().splitActivePane("vertical");
    useSessionStore.getState().splitActivePane("horizontal");
    const [, b, c] = collectPaneIds(
      useSessionStore.getState().sessions.find((item) => item.id === sessionId)!.layout,
    );
    return { a, b, c };
  }

  function finishTurn(paneId: string) {
    useSessionStore.getState().updatePaneActivity(paneId, "working");
    useSessionStore.getState().updatePaneActivity(paneId, "idle");
    return useSessionStore.getState().paneRuntime[paneId];
  }

  function doneAt(paneId: string) {
    return useSessionStore.getState().paneRuntime[paneId]?.doneAt;
  }

  it("tells a pane on the canvas from one in the dock or parked behind a zoom", () => {
    const { first, second } = withSplitSession();
    expect(isPaneOnScreen(useSessionStore.getState(), first)).toBe(true);

    useSessionStore.getState().toggleMaximizedPane(second);
    expect(isPaneOnScreen(useSessionStore.getState(), first)).toBe(false);
    expect(isPaneOnScreen(useSessionStore.getState(), second)).toBe(true);

    useSessionStore.getState().toggleMaximizedPane(second);
    useSessionStore.getState().minimizePane(first);
    expect(isPaneOnScreen(useSessionStore.getState(), first)).toBe(false);
    expect(isPaneOnScreen(useSessionStore.getState(), "missing")).toBe(false);
  });

  // Review store-ui-semantics#1, harness F2.
  it("keeps it on a minimized pane when its session is picked with every pane in the dock", () => {
    const { sessionId, first, second } = withSplitSession();
    useSessionStore.getState().minimizePane(first);
    useSessionStore.getState().minimizePane(second);
    useSessionStore.getState().addSession(session("other"));
    expect(finishTurn(first).doneAt).toBeTypeOf("number");

    useSessionStore.getState().setActiveSessionId(sessionId);

    expect(useSessionStore.getState().activePaneId).toBe(first);
    expect(doneAt(first)).toBeTypeOf("number");
  });

  // Review store-ui-semantics#1, harness F2b.
  it("hands the keyboard to the zoomed pane and keeps it on the one parked behind", () => {
    const { sessionId, first, second } = withSplitSession();
    useSessionStore.getState().toggleMaximizedPane(second);
    useSessionStore.getState().addSession(session("other"));
    expect(finishTurn(first).doneAt).toBeTypeOf("number");

    useSessionStore.getState().setActiveSessionId(sessionId);

    expect(useSessionStore.getState().activePaneId).toBe(second);
    expect(useSessionStore.getState().maximizedPaneIds[sessionId]).toBe(second);
    expect(doneAt(first)).toBeTypeOf("number");
  });

  it("moves the keyboard off a pane a zoomed sibling hides when its session is picked again", () => {
    const { sessionId, first, second } = withSplitSession();
    useSessionStore.getState().setActivePaneId(second);
    useSessionStore.getState().toggleMaximizedPane(first);

    useSessionStore.getState().setActiveSessionId(sessionId);

    expect(useSessionStore.getState().activePaneId).toBe(first);
    expect(useSessionStore.getState().maximizedPaneIds[sessionId]).toBe(first);
  });

  // Review store-ui-semantics#1: coming back to the window.
  it("reads it off the focused pane when the window comes back, only if the pane is on screen", () => {
    const { first, second } = withSplitSession();
    vi.stubGlobal("document", { visibilityState: "visible", hasFocus: () => false });
    expect(finishTurn(first).doneAt).toBeTypeOf("number");

    // Still in the background: nothing read.
    useSessionStore.getState().markActivePaneSeen();
    expect(doneAt(first)).toBeTypeOf("number");

    vi.stubGlobal("document", { visibilityState: "visible", hasFocus: () => true });
    useSessionStore.getState().markActivePaneSeen();
    expect(doneAt(first)).toBeUndefined();

    // Every pane in the dock: the last one minimized stays the active one,
    // out of sight, and keeps its "Terminou" when the window comes back.
    useSessionStore.getState().minimizePane(second);
    useSessionStore.getState().minimizePane(first);
    expect(useSessionStore.getState().activePaneId).toBe(first);
    vi.stubGlobal("document", { visibilityState: "visible", hasFocus: () => false });
    expect(finishTurn(first).doneAt).toBeTypeOf("number");
    vi.stubGlobal("document", { visibilityState: "visible", hasFocus: () => true });
    useSessionStore.getState().markActivePaneSeen();
    expect(doneAt(first)).toBeTypeOf("number");
  });

  it("keeps it on the focused pane when a zoomed sibling hides it from the returning window", () => {
    const { first, second } = withSplitSession();
    useSessionStore.getState().toggleMaximizedPane(second);
    expect(useSessionStore.getState().activePaneId).toBe(first);
    expect(finishTurn(first).doneAt).toBeTypeOf("number");

    useSessionStore.getState().markActivePaneSeen();

    expect(doneAt(first)).toBeTypeOf("number");
  });

  it("still reads it on user input and on restore, wherever the pane is", () => {
    const { first, second } = withSplitSession();
    useSessionStore.getState().minimizePane(second);
    expect(finishTurn(second).doneAt).toBeTypeOf("number");
    useSessionStore.getState().markPaneSeen(second);
    expect(doneAt(second)).toBeUndefined();

    expect(finishTurn(second).doneAt).toBeTypeOf("number");
    useSessionStore.getState().restorePane(second);
    expect(doneAt(second)).toBeUndefined();
    expect(doneAt(first)).toBeUndefined();
  });

  // Review store-ui-semantics#2, harness J1.
  it("drops a sibling's zoom when a parked pane is activated, and reads it once shown", () => {
    const { sessionId, first, second } = withSplitSession();
    useSessionStore.getState().toggleMaximizedPane(first);
    expect(finishTurn(second).doneAt).toBeTypeOf("number");

    useSessionStore.getState().setActivePaneId(second);

    const state = useSessionStore.getState();
    expect(state.activePaneId).toBe(second);
    expect(state.maximizedPaneIds[sessionId]).toBeUndefined();
    expect(doneAt(second)).toBeUndefined();
  });

  it("keeps the zoom, and the news, when a minimized pane is merely activated", () => {
    const { b: zoomed, c: minimized } = withThreePanes();
    useSessionStore.getState().minimizePane(minimized);
    useSessionStore.getState().toggleMaximizedPane(zoomed);
    expect(finishTurn(minimized).doneAt).toBeTypeOf("number");

    useSessionStore.getState().setActivePaneId(minimized);

    expect(useSessionStore.getState().maximizedPaneIds.three).toBe(zoomed);
    expect(doneAt(minimized)).toBeTypeOf("number");
  });

  // Review store-ui-semantics#5, harness F4.
  it("reads it off the pane that inherits the keyboard from a minimized one", () => {
    const { first, second } = withSplitSession();
    expect(finishTurn(second).doneAt).toBeTypeOf("number");

    useSessionStore.getState().minimizePane(first);

    expect(useSessionStore.getState().activePaneId).toBe(second);
    expect(doneAt(second)).toBeUndefined();
  });

  it("hands the keyboard to the zoomed pane when the focused one is minimized", () => {
    const { a, b: zoomed } = withThreePanes();
    useSessionStore.getState().toggleMaximizedPane(zoomed);
    expect(useSessionStore.getState().activePaneId).toBe(a);

    useSessionStore.getState().minimizePane(a);

    expect(useSessionStore.getState().activePaneId).toBe(zoomed);
    expect(useSessionStore.getState().maximizedPaneIds.three).toBe(zoomed);
  });

  it("reads it off the pane that inherits the keyboard from a closed one", () => {
    const { first, second } = withSplitSession();
    expect(finishTurn(second).doneAt).toBeTypeOf("number");

    useSessionStore.getState().closePane(first);

    expect(useSessionStore.getState().activePaneId).toBe(second);
    expect(doneAt(second)).toBeUndefined();
  });

  it("leaves a sibling's news alone when the closed pane did not have the keyboard", () => {
    const { a, b, c } = withThreePanes();
    expect(finishTurn(b).doneAt).toBeTypeOf("number");

    useSessionStore.getState().closePane(c);

    expect(useSessionStore.getState().activePaneId).toBe(a);
    expect(doneAt(b)).toBeTypeOf("number");
  });

  it("reads it off the pane of the session that takes the screen when one is closed", () => {
    const { first: other } = withSplitSession("next");
    const { sessionId } = withSplitSession("closing");
    expect(finishTurn(other).doneAt).toBeTypeOf("number");

    useSessionStore.getState().removeSession(sessionId);

    expect(useSessionStore.getState().activeSessionId).toBe("next");
    expect(useSessionStore.getState().activePaneId).toBe(other);
    expect(doneAt(other)).toBeUndefined();
  });
});

describe("useSessionStore closing the active session", () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    useSessionStore.setState(useSessionStore.getInitialState(), true);
  });

  // Review store-ui-semantics#8, harness R1: after an app restart only the
  // active session had spawned, and the next one came up as an empty canvas
  // labelled "Não iniciada".
  it("starts the session that takes the screen", () => {
    const a = session("A");
    const b = session("B");
    useSessionStore.getState().hydrateWorkspace([a, b], "A", collectPaneIds(a.layout)[0]);
    expect(useSessionStore.getState().spawnedSessionIds.B).toBeUndefined();

    useSessionStore.getState().removeSession("A");

    const state = useSessionStore.getState();
    expect(state.activeSessionId).toBe("B");
    expect(state.activePaneId).toBe(collectPaneIds(b.layout)[0]);
    expect(state.spawnedSessionIds).toEqual({ B: true });
  });

  it("does not start anything when a background session is closed", () => {
    const a = session("A");
    const b = session("B");
    const c = session("C");
    useSessionStore.getState().hydrateWorkspace([a, b, c], "A", collectPaneIds(a.layout)[0]);

    useSessionStore.getState().removeSession("B");

    expect(useSessionStore.getState().activeSessionId).toBe("A");
    expect(useSessionStore.getState().spawnedSessionIds).toEqual({ A: true });
  });
});
