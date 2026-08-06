import { beforeEach, describe, expect, it, vi } from "vitest";

import { type AgentSession } from "../types/session";
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
