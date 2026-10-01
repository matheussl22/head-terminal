import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentSession } from "../types/session";
import {
  checkSessionHibernation,
  findHibernationCandidates,
  noteSessionUsed,
  notePaneInput,
  paneKind,
  processBlocker,
  resetHibernationTracking,
  type HibernationView,
} from "./session-hibernation";
import { collectPaneIds } from "./session-layout";
import { createEmptySession, createPaneRuntime, useSessionStore, type PaneRuntime } from "./session-manager";

const MINUTE = 60_000;
const NOW = 10 * 60 * MINUTE;
const IDLE = 30 * MINUTE;

function session(id: string, agentProfileId = "claude", extra: Partial<AgentSession> = {}): AgentSession {
  return { ...createEmptySession({ id, title: id, cwd: "/repo", agentProfileId }), ...extra };
}

function idleRuntime(since = NOW - 2 * IDLE, extra: Partial<PaneRuntime> = {}): PaneRuntime {
  return { ...createPaneRuntime(), status: "running", activity: "idle", activitySince: since, ...extra };
}

function view(sessions: AgentSession[], overrides: Partial<HibernationView> = {}): HibernationView {
  const paneRuntime: Record<string, PaneRuntime> = {};
  const paneResumeAnchors: Record<string, string> = {};
  for (const item of sessions) {
    for (const paneId of collectPaneIds(item.layout)) {
      paneRuntime[paneId] = idleRuntime();
      paneResumeAnchors[paneId] = `conversation-${paneId}`;
    }
  }
  return {
    sessions,
    activeSessionId: "other",
    spawnedSessionIds: Object.fromEntries(sessions.map((item) => [item.id, true])),
    paneRuntime,
    paneResumeAnchors,
    ...overrides,
  };
}

const options = { now: NOW, idleMs: IDLE };

beforeEach(() => {
  resetHibernationTracking();
});

describe("checkSessionHibernation", () => {
  it("lets an idle, unused agent session sleep", () => {
    const target = session("a");
    const result = checkSessionHibernation(view([target]), "a", options);
    expect(result).toEqual({
      sessionId: "a",
      panes: [{ paneId: collectPaneIds(target.layout)[0], kind: "agent" }],
    });
  });

  it("keeps the session on screen awake unless forced", () => {
    const target = session("a");
    const state = view([target], { activeSessionId: "a" });
    expect(checkSessionHibernation(state, "a", options)).toEqual({ blocker: "active" });
    expect(checkSessionHibernation(state, "a", { ...options, force: true })).toHaveProperty("panes");
  });

  it("has nothing to do for a session that is not running", () => {
    const state = view([session("a")], { spawnedSessionIds: {} });
    expect(checkSessionHibernation(state, "a", options)).toEqual({ blocker: "not_spawned" });
  });

  it("waits until the session has been left alone long enough", () => {
    const target = session("a");
    noteSessionUsed("a", NOW - IDLE + MINUTE);
    expect(checkSessionHibernation(view([target]), "a", options)).toEqual({ blocker: "recent" });
    noteSessionUsed("a", NOW - IDLE - MINUTE);
    expect(checkSessionHibernation(view([target]), "a", options)).toHaveProperty("panes");
  });

  it("counts a turn that ended recently as use", () => {
    const target = session("a");
    const paneId = collectPaneIds(target.layout)[0];
    const state = view([target]);
    state.paneRuntime[paneId] = idleRuntime(NOW - MINUTE);
    expect(checkSessionHibernation(state, "a", options)).toEqual({ blocker: "recent", paneId });
  });

  it("counts typing into a pane as use", () => {
    const target = session("a");
    const paneId = collectPaneIds(target.layout)[0];
    notePaneInput(paneId, NOW - MINUTE);
    expect(checkSessionHibernation(view([target]), "a", options)).toEqual({ blocker: "recent", paneId });
  });

  it.each(["working", "starting", "waiting_input"] as const)(
    "never stops a pane that is %s, not even when forced",
    (activity) => {
      const target = session("a");
      const paneId = collectPaneIds(target.layout)[0];
      const state = view([target]);
      state.paneRuntime[paneId] = idleRuntime(NOW - 2 * IDLE, { activity });
      const forced = { ...options, force: true };
      expect(checkSessionHibernation(state, "a", forced)).toEqual({ blocker: "busy", paneId });
    },
  );

  it("refuses a conversation that was typed into but never identified", () => {
    const target = session("a");
    const paneId = collectPaneIds(target.layout)[0];
    const state = view([target], { paneResumeAnchors: {} });
    notePaneInput(paneId, NOW - 2 * IDLE);
    expect(checkSessionHibernation(state, "a", options)).toEqual({ blocker: "unanchored", paneId });
  });

  it("lets an agent pane nobody typed into sleep without a conversation", () => {
    const state = view([session("a")], { paneResumeAnchors: {} });
    expect(checkSessionHibernation(state, "a", options)).toHaveProperty("panes");
  });

  it.each([
    ["a local model", session("a", "ollama")],
    ["a WSL shell", session("a", "shell", { wslDistro: "Ubuntu" })],
  ])("keeps %s awake: it would not come back where it was", (_label, target) => {
    const paneId = collectPaneIds(target.layout)[0];
    expect(checkSessionHibernation(view([target]), "a", options)).toEqual({ blocker: "profile", paneId });
  });

  it("keeps a pane a phone is looking at awake", () => {
    const target = session("a");
    const paneId = collectPaneIds(target.layout)[0];
    const result = checkSessionHibernation(view([target]), "a", {
      ...options,
      watchedPaneIds: new Set([paneId]),
    });
    expect(result).toEqual({ blocker: "watched", paneId });
  });

  it("keeps a pane the voice records into awake", () => {
    const target = session("a");
    const paneId = collectPaneIds(target.layout)[0];
    const state = view([target], { voiceRecordingPaneId: paneId });
    expect(checkSessionHibernation(state, "a", options)).toEqual({ blocker: "watched", paneId });
  });
});

describe("paneKind", () => {
  it("checks an agent that fell back to its shell as a shell", () => {
    expect(paneKind(session("a"), { activity: "agent_fallback" })).toBe("shell");
    expect(paneKind(session("a"), { activity: "idle" })).toBe("agent");
    expect(paneKind(session("a", "shell"), { activity: "idle" })).toBe("shell");
    expect(paneKind(session("a", "qwen27"), { activity: "idle" })).toBeNull();
  });
});

describe("findHibernationCandidates", () => {
  it("lists only the sessions that may sleep", () => {
    const sleepy = session("sleepy");
    const shown = session("shown");
    const busy = session("busy");
    const state = view([sleepy, shown, busy], { activeSessionId: "shown" });
    state.paneRuntime[collectPaneIds(busy.layout)[0]] = idleRuntime(NOW - 2 * IDLE, {
      activity: "working",
    });
    expect(findHibernationCandidates(state, options).map((item) => item.sessionId)).toEqual([
      "sleepy",
    ]);
  });
});

describe("processBlocker", () => {
  const base = { alive: true, memoryBytes: 1, children: [], detachedShells: [] };

  it("lets a shell with nothing under it sleep", () => {
    expect(processBlocker("shell", base)).toBe(false);
  });

  it("keeps a shell running a program awake", () => {
    expect(processBlocker("shell", { ...base, children: ["node.exe"] })).toBe(true);
  });

  it("lets an agent keep its MCP servers, but not a background command", () => {
    expect(processBlocker("agent", { ...base, children: ["claude.exe", "node.exe"] })).toBe(false);
    expect(processBlocker("agent", { ...base, detachedShells: ["bash.exe"] })).toBe(true);
  });

  it("has nothing to protect in a pane whose process is gone", () => {
    expect(processBlocker("shell", undefined)).toBe(false);
    expect(processBlocker("shell", { ...base, alive: false, children: ["x"] })).toBe(false);
  });
});

describe("hibernateSession / wakeSession", () => {
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

  it("stops the session and sets each pane to resume its own conversation", () => {
    const shown = session("shown");
    const target = session("target");
    const paneId = collectPaneIds(target.layout)[0];
    const store = useSessionStore.getState();
    store.hydrateWorkspace([shown, target], shown.id, null, { [paneId]: "conv-1" });
    store.setActiveSessionId(target.id);
    store.setActiveSessionId(shown.id);
    // Restarted fresh meanwhile: the anchor the next spawn needs is the one
    // the pane landed on since.
    useSessionStore.getState().restartPane(paneId, { continueConversation: false });
    useSessionStore.getState().notePaneResumeAnchor(paneId, "conv-2");

    expect(useSessionStore.getState().hibernateSession(target.id)).toBe(true);
    const state = useSessionStore.getState();
    expect(state.spawnedSessionIds[target.id]).toBeUndefined();
    expect(state.hibernatedSessions[target.id]).toEqual(expect.any(Number));
    expect(state.restoredPaneIds[paneId]).toBe(true);
    expect(state.paneResumeSessionIds[paneId]).toBe("conv-2");
  });

  it("does nothing for a session that is not running", () => {
    const shown = session("shown");
    const target = session("target");
    useSessionStore.getState().hydrateWorkspace([shown, target], shown.id, null);
    expect(useSessionStore.getState().hibernateSession(target.id)).toBe(false);
    expect(useSessionStore.getState().hibernatedSessions).toEqual({});
  });

  it("wakes in the background, or when picked", () => {
    const shown = session("shown");
    const target = session("target");
    const store = useSessionStore.getState();
    store.hydrateWorkspace([shown, target], shown.id, null);
    store.setActiveSessionId(target.id);
    store.setActiveSessionId(shown.id);

    useSessionStore.getState().hibernateSession(target.id);
    useSessionStore.getState().wakeSession(target.id);
    let state = useSessionStore.getState();
    expect(state.spawnedSessionIds[target.id]).toBe(true);
    expect(state.activeSessionId).toBe(shown.id);
    expect(state.hibernatedSessions[target.id]).toBeUndefined();

    useSessionStore.getState().hibernateSession(target.id);
    useSessionStore.getState().setActiveSessionId(target.id);
    state = useSessionStore.getState();
    expect(state.spawnedSessionIds[target.id]).toBe(true);
    expect(state.hibernatedSessions[target.id]).toBeUndefined();
  });

  it("forgets a closed session's sleep", () => {
    const shown = session("shown");
    const target = session("target");
    const store = useSessionStore.getState();
    store.hydrateWorkspace([shown, target], shown.id, null);
    store.setActiveSessionId(target.id);
    store.setActiveSessionId(shown.id);
    useSessionStore.getState().hibernateSession(target.id);
    useSessionStore.getState().removeSession(target.id);
    expect(useSessionStore.getState().hibernatedSessions).toEqual({});
  });
});
