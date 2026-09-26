import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PaneStatusRuntime } from "./activity-display";
import {
  notifyPaneDone,
  notifySessionStatus,
  paneDoneNotifications,
  pruneSessionNotifications,
  resetNotificationsForTests,
  sessionNotification,
} from "./notifications";

vi.mock("./logger", () => ({ logError: vi.fn() }));

function pane(
  activity: PaneStatusRuntime["activity"],
  extra: Partial<PaneStatusRuntime> = {},
): PaneStatusRuntime {
  return { activity, activitySince: 0, ...extra };
}

describe("sessionNotification", () => {
  it("says what a blocked session waits for", () => {
    expect(
      sessionNotification("api", ["a", "b"], {
        a: pane("working"),
        b: pane("waiting_input", { blockedReason: "approval", blockedDetail: "Bash" }),
      }),
    ).toEqual({ tone: "waiting", body: "api: pede aprovação (Bash)", paneId: "b" });
    expect(
      sessionNotification("api", ["a"], { a: pane("waiting_input", { blockedReason: "question" }) }),
    ).toEqual({ tone: "waiting", body: "api: fez uma pergunta", paneId: "a" });
    expect(
      sessionNotification("api", ["a"], { a: pane("waiting_input", { blockedReason: "dialog" }) }),
    ).toEqual({ tone: "waiting", body: "api: espera uma confirmação", paneId: "a" });
  });

  it("announces errors, and leaves finished turns to the per-terminal notice", () => {
    expect(sessionNotification("api", ["a"], { a: pane("idle", { doneAt: 1 }) })).toBeNull();
    expect(sessionNotification("api", ["a"], { a: pane("error") })).toEqual({
      tone: "error",
      body: "api encontrou um erro",
      paneId: "a",
    });
  });

  // Review store-hooks-ui-fixes#3: the error notice named no pane, so a click
  // only switched sessions and left the failed terminal (and its Reiniciar)
  // in the dock or behind a zoomed sibling.
  it("names the terminal that failed, so a click can bring it on screen", () => {
    expect(
      sessionNotification("api", ["a", "b", "c"], {
        a: pane("working"),
        b: pane("error"),
        c: pane("idle"),
      }),
    ).toEqual({ tone: "error", body: "api encontrou um erro", paneId: "b" });
  });

  it("only calls a fallback a crash when the agent did not leave on purpose", () => {
    expect(
      sessionNotification("api", ["a"], { a: pane("agent_fallback", { agentExitCode: 1 }) }),
    ).toEqual({ tone: "fallback", body: "api: o agent caiu — shell ativo", paneId: "a" });
    expect(
      sessionNotification("api", ["a"], { a: pane("agent_fallback", { agentExitCode: 0 }) }),
    ).toBeNull();
  });

  it("stays silent about work, idleness and sessions that never started", () => {
    expect(sessionNotification("api", ["a"], { a: pane("working") })).toBeNull();
    expect(sessionNotification("api", ["a"], { a: pane("idle") })).toBeNull();
    expect(sessionNotification("api", ["a"], { a: pane("starting") }, { spawned: false })).toBeNull();
  });
});

describe("notifySessionStatus", () => {
  const show = vi.fn(() => Promise.resolve());
  const waiting = { tone: "waiting" as const, body: "api: pede aprovação (Bash)" };
  const background = { sessionActive: false, windowFocused: false };

  beforeEach(() => {
    resetNotificationsForTests();
    show.mockClear();
    vi.stubGlobal("window", { headTerminal: { notifications: { show } } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("notifies once per stretch of a tone and re-arms when the session leaves it", () => {
    notifySessionStatus("s", waiting, background);
    notifySessionStatus("s", waiting, background);
    expect(show).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith({ title: "Head Terminal", body: waiting.body, sessionId: "s" });

    // Back to work, then blocked again: that is a new request.
    notifySessionStatus("s", null, background);
    notifySessionStatus("s", waiting, background);
    expect(show).toHaveBeenCalledTimes(2);
  });

  it("stays quiet about the session the user is looking at, and does not replay it later", () => {
    notifySessionStatus("s", waiting, { sessionActive: true, windowFocused: true });
    notifySessionStatus("s", waiting, background);
    expect(show).not.toHaveBeenCalled();
  });

  it("tells a background session's approval even with the app in front", () => {
    notifySessionStatus("s", waiting, { sessionActive: false, windowFocused: true });
    expect(show).toHaveBeenCalledTimes(1);
  });

});

describe("paneDoneNotifications", () => {
  const session = { title: "api", agentProfileId: "claude" };

  it("names the terminal that finished, as its header does", () => {
    expect(
      paneDoneNotifications(session, ["a", "b", "c"], {
        a: pane("working"),
        b: pane("idle"),
        c: pane("idle", { doneAt: 7 }),
      }),
    ).toEqual([{ paneId: "c", doneAt: 7, body: "api: cc3 concluiu" }]);
    // A lone terminal is the session itself.
    expect(paneDoneNotifications(session, ["a"], { a: pane("idle", { doneAt: 7 }) })).toEqual([
      { paneId: "a", doneAt: 7, body: "api concluiu" },
    ]);
    expect(
      paneDoneNotifications(session, ["a"], { a: pane("idle", { doneAt: 7 }) }, { spawned: false }),
    ).toEqual([]);
  });

  // Review store-ui-semantics#3 (harness F1/F1b): the session's winning tone
  // used to decide, so a sibling in the shell after /exit, or still working,
  // swallowed the "concluiu" for good.
  it("is not swallowed by a sibling in the shell after /exit, working or waiting", () => {
    for (const sibling of [
      pane("agent_fallback", { agentExitCode: 0 }),
      pane("working"),
      pane("waiting_input", { blockedReason: "approval" }),
    ]) {
      const runtime = { a: sibling, b: pane("idle", { doneAt: 9 }) };
      expect(paneDoneNotifications(session, ["a", "b"], runtime)).toEqual([
        { paneId: "b", doneAt: 9, body: "api: cc2 concluiu" },
      ]);
    }
    // The /exit shell itself stays quiet at the session level.
    expect(
      sessionNotification("api", ["a", "b"], {
        a: pane("agent_fallback", { agentExitCode: 0 }),
        b: pane("idle", { doneAt: 9 }),
      }),
    ).toBeNull();
  });
});

describe("notifyPaneDone", () => {
  const show = vi.fn(() => Promise.resolve());

  beforeEach(() => {
    resetNotificationsForTests();
    show.mockClear();
    vi.stubGlobal("window", { headTerminal: { notifications: { show } } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("tells each finished turn once, per terminal, while the window is in the background", () => {
    const first = { paneId: "b", doneAt: 9, body: "api: cc2 concluiu" };
    notifyPaneDone("s", first, { windowFocused: false });
    notifyPaneDone("s", first, { windowFocused: false });
    expect(show).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith({
      title: "Head Terminal",
      body: first.body,
      sessionId: "s",
      paneId: "b",
    });

    // A sibling finishing is news of its own, not a repeat of the session's.
    notifyPaneDone("s", { paneId: "c", doneAt: 9, body: "api: cc3 concluiu" }, { windowFocused: false });
    expect(show).toHaveBeenCalledTimes(2);

    // The next turn of the same terminal is news again.
    notifyPaneDone("s", { ...first, doneAt: 20 }, { windowFocused: false });
    expect(show).toHaveBeenCalledTimes(3);
  });

  it("leaves a finished turn to the app while it is in front, and does not replay it later", () => {
    const done = { paneId: "b", doneAt: 9, body: "api: cc2 concluiu" };
    notifyPaneDone("s", done, { windowFocused: true });
    notifyPaneDone("s", done, { windowFocused: false });
    expect(show).not.toHaveBeenCalled();
  });

  it("forgets a turn once it is no longer pending", () => {
    const done = { paneId: "b", doneAt: 9, body: "api: cc2 concluiu" };
    notifyPaneDone("s", done, { windowFocused: false });
    pruneSessionNotifications(new Set(["s"]), new Set(["b"]));
    notifyPaneDone("s", done, { windowFocused: false });
    expect(show).toHaveBeenCalledTimes(1);

    pruneSessionNotifications(new Set(["s"]), new Set());
    notifyPaneDone("s", done, { windowFocused: false });
    expect(show).toHaveBeenCalledTimes(2);
  });
});
