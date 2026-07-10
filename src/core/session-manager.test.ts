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
