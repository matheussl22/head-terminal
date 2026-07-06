import { beforeEach, describe, expect, it, vi } from "vitest";

import { type AgentSession } from "../types/session";
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
