// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetNotificationsForTests } from "../core/notifications";
import { collectPaneIds } from "../core/session-layout";
import { createEmptySession, useSessionStore } from "../core/session-manager";
import { useActivityNotifications } from "./useAppShortcuts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Probe() {
  useActivityNotifications();
  return null;
}

describe("useActivityNotifications", () => {
  let host: HTMLDivElement;
  let root: Root;
  let show: ReturnType<typeof vi.fn>;
  let windowFocused: boolean;
  let first: string;
  let second: string;
  let activate: ((target: { sessionId: string; paneId?: string }) => void) | null;

  beforeEach(() => {
    vi.useFakeTimers();
    show = vi.fn(() => Promise.resolve());
    activate = null;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });
    (window as unknown as { headTerminal: unknown }).headTerminal = {
      notifications: {
        show,
        onActivated: (callback: typeof activate) => {
          activate = callback;
          return () => undefined;
        },
      },
      workspace: { save: () => Promise.resolve(), load: () => Promise.resolve(null) },
      diagnostics: { appendEvent: () => undefined, appendCheckpoint: () => undefined },
    };
    windowFocused = true;
    vi.spyOn(document, "hasFocus").mockImplementation(() => windowFocused);
    resetNotificationsForTests();
    useSessionStore.setState(useSessionStore.getInitialState(), true);

    const created = createEmptySession({ id: "s", title: "api", cwd: "/tmp", agentProfileId: "claude" });
    useSessionStore.getState().addSession(created);
    [first] = collectPaneIds(created.layout);
    useSessionStore.getState().splitPane(first, "vertical");
    [, second] = collectPaneIds(useSessionStore.getState().sessions[0].layout);

    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(createElement(Probe)));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    delete (window as unknown as { headTerminal?: unknown }).headTerminal;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function finishTurn(paneId: string) {
    useSessionStore.getState().updatePaneActivity(paneId, "working");
    useSessionStore.getState().updatePaneActivity(paneId, "idle");
    expect(useSessionStore.getState().paneRuntime[paneId].doneAt).toBeTypeOf("number");
  }

  function flushNotifications() {
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
  }

  function comeBackToWindow() {
    windowFocused = true;
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
  }

  // Review store-ui-semantics#1: the focus listener read the "Concluído" of
  // whatever pane was active, even one sitting in the dock.
  it("reads the focused pane's finished turn when the window comes back, unless it is in the dock", () => {
    windowFocused = false;
    finishTurn(first);
    comeBackToWindow();
    flushNotifications();
    expect(useSessionStore.getState().paneRuntime[first].doneAt).toBeUndefined();

    useSessionStore.getState().minimizePane(second);
    useSessionStore.getState().minimizePane(first);
    expect(useSessionStore.getState().activePaneId).toBe(first);
    windowFocused = false;
    finishTurn(first);
    comeBackToWindow();
    flushNotifications();
    expect(useSessionStore.getState().paneRuntime[first].doneAt).toBeTypeOf("number");
  });

  // Review store-hooks-ui-fixes#1: a click on "api: cc2 concluiu" brings the
  // window back before it says which pane it is about (macOS always does, and
  // Windows did while main focused the window first). The focus listener then
  // read the "Concluído" of the pane that was active — in another session the
  // user never got to look at.
  it("leaves the old active pane's finished turn alone when a notification click brings the window back", () => {
    const other = createEmptySession({ id: "other", title: "web", cwd: "/tmp", agentProfileId: "claude" });
    useSessionStore.getState().addSession(other);
    const [otherPane] = collectPaneIds(other.layout);
    expect(useSessionStore.getState().activePaneId).toBe(otherPane);
    windowFocused = false;
    finishTurn(otherPane);
    finishTurn(second);

    comeBackToWindow();
    act(() => activate?.({ sessionId: "s", paneId: second }));
    flushNotifications();

    const state = useSessionStore.getState();
    expect(state.activeSessionId).toBe("s");
    expect(state.activePaneId).toBe(second);
    expect(state.paneRuntime[second].doneAt).toBeUndefined();
    expect(state.paneRuntime[otherPane].doneAt).toBeTypeOf("number");
  });

  it("still reads the revealed pane when the click arrives before the window comes back", () => {
    const other = createEmptySession({ id: "other", title: "web", cwd: "/tmp", agentProfileId: "claude" });
    useSessionStore.getState().addSession(other);
    const [otherPane] = collectPaneIds(other.layout);
    windowFocused = false;
    finishTurn(otherPane);
    finishTurn(second);

    // What main now does: say which pane first, then show the window.
    act(() => activate?.({ sessionId: "s", paneId: second }));
    comeBackToWindow();
    flushNotifications();

    const state = useSessionStore.getState();
    expect(state.activePaneId).toBe(second);
    expect(state.paneRuntime[second].doneAt).toBeUndefined();
    expect(state.paneRuntime[otherPane].doneAt).toBeTypeOf("number");
  });

  it("brings the terminal a clicked notification is about on screen, out of the dock", () => {
    useSessionStore.getState().addSession(
      createEmptySession({ id: "other", title: "web", cwd: "/tmp", agentProfileId: "claude" }),
    );
    useSessionStore.getState().minimizePane(second);
    expect(useSessionStore.getState().activeSessionId).toBe("other");

    act(() => activate?.({ sessionId: "s", paneId: second }));

    const state = useSessionStore.getState();
    expect(state.activeSessionId).toBe("s");
    expect(state.activePaneId).toBe(second);
    expect(state.minimizedPanes[second]).toBeUndefined();
  });

  it("falls back to the session when the notification names no pane of it", () => {
    useSessionStore.getState().addSession(
      createEmptySession({ id: "other", title: "web", cwd: "/tmp", agentProfileId: "claude" }),
    );
    act(() => activate?.({ sessionId: "s", paneId: "gone" }));
    expect(useSessionStore.getState().activeSessionId).toBe("s");
  });

  // Review store-ui-semantics#3, harness F1/F1b.
  it("tells each terminal's finished turn, whatever its sibling is doing", () => {
    windowFocused = false;
    useSessionStore.getState().updatePaneActivity(first, "working");
    finishTurn(second);
    flushNotifications();
    expect(show).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith({
      title: "Head Terminal",
      body: "api: cc2 concluiu",
      sessionId: "s",
      paneId: second,
    });

    // The sibling leaves Claude with /exit: not news, and no replay.
    useSessionStore.getState().updatePaneActivity(first, "agent_fallback", undefined, {
      agentExitCode: 0,
    });
    flushNotifications();
    expect(show).toHaveBeenCalledTimes(1);

    // The next turn of the same terminal is news again.
    finishTurn(second);
    flushNotifications();
    expect(show).toHaveBeenCalledTimes(2);
  });

  it("leaves a finished turn to the app while its window is in front", () => {
    useSessionStore.getState().addSession(
      createEmptySession({ id: "other", title: "other", cwd: "/tmp", agentProfileId: "shell" }),
    );
    finishTurn(second);
    flushNotifications();
    expect(show).not.toHaveBeenCalled();
  });
});
