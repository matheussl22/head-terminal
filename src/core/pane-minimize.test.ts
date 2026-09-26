// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { findFirstPaneInTone } from "../components/ui/StatusDot";
import {
  landPaneMotion,
  minimizePaneWithMotion,
  restorePaneWithMotion,
  revealPane,
  toggleActivePaneMinimized,
} from "./pane-minimize";
import { collectPaneIds } from "./session-layout";
import { createEmptySession, useSessionStore } from "./session-manager";
import { registerTerminal, unregisterTerminal, type TerminalHandle } from "./terminal-registry";

function placeAt(element: HTMLElement, left: number, top: number, width: number, height: number) {
  element.getBoundingClientRect = () =>
    ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top }) as DOMRect;
  return element;
}

interface FakeAnimation {
  onfinish: (() => void) | null;
  oncancel: (() => void) | null;
}

describe("pane minimize motion", () => {
  let animations: Array<{ element: Element; animation: FakeAnimation }>;
  let paneId: string;

  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    useSessionStore.setState(useSessionStore.getInitialState(), true);
    const session = createEmptySession({
      id: "s",
      title: "s",
      cwd: "/tmp",
      agentProfileId: "shell",
    });
    useSessionStore.getState().addSession(session);
    [paneId] = collectPaneIds(session.layout);

    animations = [];
    Element.prototype.animate = function animate(this: Element) {
      const animation: FakeAnimation = { onfinish: null, oncancel: null };
      animations.push({ element: this, animation });
      return animation as unknown as Animation;
    };
  });

  afterEach(() => {
    document.body.innerHTML = "";
    delete (Element.prototype as Partial<Element>).animate;
    vi.restoreAllMocks();
  });

  it("flies a ghost from the pane to its card, then clears it", () => {
    const shell = placeAt(document.createElement("div"), 300, 60, 800, 600);
    shell.dataset.paneShell = paneId;
    document.body.append(shell);

    minimizePaneWithMotion(paneId);
    expect(useSessionStore.getState().minimizedPanes[paneId]).toBeDefined();

    const card = placeAt(document.createElement("button"), 300, 700, 260, 34);
    document.body.append(card);
    landPaneMotion(paneId, "minimize", card);

    const ghost = document.querySelector(".pane-motion-ghost");
    expect(ghost).not.toBeNull();
    expect(animations.map((entry) => entry.element)).toEqual([ghost, card]);

    animations[0].animation.onfinish?.();
    expect(document.querySelector(".pane-motion-ghost")).toBeNull();
  });

  it("lands each motion once, and only the kind it started as", () => {
    const shell = placeAt(document.createElement("div"), 300, 60, 800, 600);
    shell.dataset.paneShell = paneId;
    document.body.append(shell);
    minimizePaneWithMotion(paneId);

    const card = placeAt(document.createElement("button"), 300, 700, 260, 34);
    landPaneMotion(paneId, "restore", card);
    expect(animations).toHaveLength(0);

    landPaneMotion(paneId, "minimize", card);
    landPaneMotion(paneId, "minimize", card);
    expect(animations).toHaveLength(2);
  });

  it("does not fly from a stale origin or from off-screen", () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(1_000);
    const card = placeAt(document.createElement("button"), 300, 700, 260, 34);
    card.dataset.minimizedPane = paneId;
    document.body.append(card);
    useSessionStore.getState().minimizePane(paneId);

    restorePaneWithMotion(paneId);
    now.mockReturnValue(5_000);
    landPaneMotion(paneId, "restore", placeAt(document.createElement("div"), 0, 0, 800, 600));
    expect(animations).toHaveLength(0);

    // A card in a hidden session sits far off to the left.
    useSessionStore.getState().minimizePane(paneId);
    placeAt(card, -3000, 700, 260, 34);
    restorePaneWithMotion(paneId);
    landPaneMotion(paneId, "restore", placeAt(document.createElement("div"), 0, 0, 800, 600));
    expect(animations).toHaveLength(0);
  });

  it("toggles the active terminal in and out of the dock", () => {
    toggleActivePaneMinimized();
    expect(useSessionStore.getState().minimizedPanes[paneId]).toBeDefined();

    toggleActivePaneMinimized();
    expect(useSessionStore.getState().minimizedPanes[paneId]).toBeUndefined();
    expect(useSessionStore.getState().activePaneId).toBe(paneId);
  });
});

describe("revealPane", () => {
  let focused: string[];
  let frames: FrameRequestCallback[];

  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    focused = [];
    useSessionStore.setState(useSessionStore.getInitialState(), true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Session "s" split in two, plus an "other" session holding the screen. */
  function twoPanesBehindOtherSession() {
    const created = createEmptySession({ id: "s", title: "s", cwd: "/tmp", agentProfileId: "claude" });
    useSessionStore.getState().addSession(created);
    const [first] = collectPaneIds(created.layout);
    useSessionStore.getState().splitPane(first, "vertical");
    const [, second] = collectPaneIds(useSessionStore.getState().sessions[0].layout);
    for (const paneId of [first, second]) {
      registerTerminal(paneId, {
        terminal: { focus: () => focused.push(paneId) },
      } as unknown as TerminalHandle);
    }
    return { first, second };
  }

  function finishUnseen(paneId: string) {
    useSessionStore.getState().updatePaneActivity(paneId, "working");
    useSessionStore.getState().updatePaneActivity(paneId, "idle");
    expect(useSessionStore.getState().paneRuntime[paneId].doneAt).toBeTypeOf("number");
  }

  function flushFrames() {
    for (const callback of frames.splice(0)) {
      callback(0);
    }
  }

  // Review store-ui-semantics#2 / ui-a11y-react#1 (harness J1): the chip left
  // the pane parked behind the zoomed sibling and read its "Concluído" anyway.
  it("brings a pane out from behind a zoomed sibling, from another session", () => {
    const { first, second } = twoPanesBehindOtherSession();
    useSessionStore.getState().setActivePaneId(first);
    useSessionStore.getState().toggleMaximizedPane(first);
    useSessionStore.getState().addSession(
      createEmptySession({ id: "other", title: "other", cwd: "/tmp", agentProfileId: "shell" }),
    );
    finishUnseen(second);

    // What the "1 concluído" chip does.
    revealPane(findFirstPaneInTone("done")!.paneId);

    const state = useSessionStore.getState();
    expect(state.activeSessionId).toBe("s");
    expect(state.activePaneId).toBe(second);
    expect(state.maximizedPaneIds.s).toBeUndefined();
    expect(state.paneRuntime[second].doneAt).toBeUndefined();
    flushFrames();
    expect(focused).toEqual([second]);
    unregisterTerminal(first);
    unregisterTerminal(second);
  });

  it("reads nothing on the way: the zoomed sibling keeps its own \"Concluído\"", () => {
    const { first, second } = twoPanesBehindOtherSession();
    useSessionStore.getState().setActivePaneId(first);
    useSessionStore.getState().toggleMaximizedPane(first);
    useSessionStore.getState().addSession(
      createEmptySession({ id: "other", title: "other", cwd: "/tmp", agentProfileId: "shell" }),
    );
    finishUnseen(first);
    finishUnseen(second);

    // A sidebar dot on the second terminal: activating the session first
    // would have handed the keyboard (and the read) to the zoomed one.
    revealPane(second);

    const state = useSessionStore.getState();
    expect(state.activePaneId).toBe(second);
    expect(state.paneRuntime[second].doneAt).toBeUndefined();
    expect(state.paneRuntime[first].doneAt).toBeTypeOf("number");
    unregisterTerminal(first);
    unregisterTerminal(second);
  });

  it("restores a minimized pane", () => {
    const { first, second } = twoPanesBehindOtherSession();
    useSessionStore.getState().minimizePane(second);
    finishUnseen(second);

    revealPane(second);

    const state = useSessionStore.getState();
    expect(state.minimizedPanes[second]).toBeUndefined();
    expect(state.activePaneId).toBe(second);
    expect(state.paneRuntime[second].doneAt).toBeUndefined();
    flushFrames();
    expect(focused).toEqual([second]);
    unregisterTerminal(first);
    unregisterTerminal(second);
  });

  it("takes the keyboard off the chip even when the pane already was the active one", () => {
    const { first, second } = twoPanesBehindOtherSession();
    useSessionStore.getState().setActivePaneId(second);
    useSessionStore.getState().updatePaneActivity(second, "waiting_input", { reason: "approval" });

    revealPane(findFirstPaneInTone("waiting")!.paneId);
    flushFrames();

    expect(useSessionStore.getState().activePaneId).toBe(second);
    expect(focused).toEqual([second]);
    unregisterTerminal(first);
    unregisterTerminal(second);
  });
});
