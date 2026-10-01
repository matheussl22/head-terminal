import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentSession } from "../types/session";
import { buildRemoteSnapshot, runRemoteCommand } from "./remote-bridge";
import { collectPaneIds } from "./session-layout";
import { createEmptySession, useSessionStore } from "./session-manager";

function session(id: string, agentProfileId = "claude"): AgentSession {
  return createEmptySession({ id, title: `Sessão ${id}`, cwd: `/repo/${id}`, agentProfileId });
}

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

function setup() {
  const shown = session("shown");
  const asleep = session("asleep", "shell");
  const shownPane = collectPaneIds(shown.layout)[0];
  const asleepPane = collectPaneIds(asleep.layout)[0];
  useSessionStore
    .getState()
    .hydrateWorkspace([shown, asleep], shown.id, shownPane, { [shownPane]: "conv-1" }, {
      "conv-1": "Refatorar o login",
    });
  const write = vi.fn();
  useSessionStore.getState().registerPtyWriter(shownPane, write);
  return { shown, asleep, shownPane, asleepPane, write };
}

describe("buildRemoteSnapshot", () => {
  it("lists every session with its state and its panes' status", () => {
    const { shownPane, asleepPane } = setup();
    useSessionStore.getState().updatePaneActivity(shownPane, "waiting_input", {
      reason: "approval",
      detail: "Bash",
    });

    const snapshot = buildRemoteSnapshot(useSessionStore.getState(), 7);
    expect(snapshot.updatedAt).toBe(7);
    expect(snapshot.sessions).toEqual([
      expect.objectContaining({
        sessionId: "shown",
        title: "Sessão shown",
        cwd: "/repo/shown",
        agentLabel: "Claude Code",
        active: true,
        state: "live",
        panes: [
          expect.objectContaining({
            paneId: shownPane,
            index: 1,
            title: "Refatorar o login",
            activity: "waiting_input",
            blockedReason: "approval",
            blockedDetail: "Bash",
            done: false,
          }),
        ],
      }),
      expect.objectContaining({
        sessionId: "asleep",
        active: false,
        state: "not_started",
        panes: [expect.objectContaining({ paneId: asleepPane, title: "Terminal 1" })],
      }),
    ]);
  });

  it("tells a hibernated session from one never opened", () => {
    const { asleep, shown } = setup();
    const store = useSessionStore.getState();
    store.setActiveSessionId(asleep.id);
    store.setActiveSessionId(shown.id);
    useSessionStore.getState().hibernateSession(asleep.id);
    const summary = buildRemoteSnapshot(useSessionStore.getState()).sessions[1];
    expect(summary.state).toBe("hibernated");
    expect(summary.hibernatedAt).toEqual(expect.any(Number));
  });
});

describe("runRemoteCommand", () => {
  it.each([
    ["enter", "\r"],
    ["escape", "\x1b"],
    ["up", "\x1b[A"],
    ["shift-tab", "\x1b[Z"],
    ["ctrl-c", "\x03"],
    ["2", "2"],
  ] as const)("sends %s as the key it is", async (key, sequence) => {
    const { shownPane, write } = setup();
    await expect(runRemoteCommand({ type: "send-key", paneId: shownPane, key })).resolves.toEqual({
      ok: true,
    });
    expect(write).toHaveBeenCalledWith(sequence);
  });

  it("pastes text and presses Enter after it when asked to submit", async () => {
    vi.useFakeTimers();
    const { shownPane, write } = setup();
    const result = runRemoteCommand({
      type: "send-text",
      paneId: shownPane,
      text: "rode os testes",
      submit: true,
    });
    await vi.runAllTimersAsync();
    await expect(result).resolves.toEqual({ ok: true });
    expect(write.mock.calls).toEqual([["rode os testes"], ["\r"]]);
  });

  it("refuses to type into a session that is not running", async () => {
    const { asleepPane } = setup();
    const result = await runRemoteCommand({ type: "send-key", paneId: asleepPane, key: "enter" });
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/hibernada/u) });
  });

  it("refuses a pane that no longer exists", async () => {
    setup();
    const result = await runRemoteCommand({ type: "send-key", paneId: "gone", key: "enter" });
    expect(result.ok).toBe(false);
  });

  it("wakes a session without putting it on screen", async () => {
    const { asleep, shown } = setup();
    await expect(runRemoteCommand({ type: "wake-session", sessionId: asleep.id })).resolves.toEqual({
      ok: true,
    });
    const state = useSessionStore.getState();
    expect(state.spawnedSessionIds[asleep.id]).toBe(true);
    expect(state.activeSessionId).toBe(shown.id);
  });

  it("brings a session up on the desktop", async () => {
    const { asleep, asleepPane } = setup();
    await runRemoteCommand({ type: "focus-session", sessionId: asleep.id, paneId: asleepPane });
    const state = useSessionStore.getState();
    expect(state.activeSessionId).toBe(asleep.id);
    expect(state.activePaneId).toBe(asleepPane);
  });
});
