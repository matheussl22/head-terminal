// @vitest-environment jsdom
import { act, createElement, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ResumableSessionEntry } from "../../core/agent-sessions-bridge";
import { collectPaneIds } from "../../core/session-layout";
import { createEmptySession, useSessionStore } from "../../core/session-manager";
import { ResumeSessionMenu, type ResumeSessionMenuHandle } from "./ResumeSessionMenu";
import { TerminalPaneHeader } from "./TerminalPaneChrome";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sessions = vi.hoisted(() => ({ entries: [] as ResumableSessionEntry[] }));

vi.mock("../../core/agent-sessions-bridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../core/agent-sessions-bridge")>()),
  fetchResumableSessions: vi.fn(async () => sessions.entries),
}));

function stubLocalStorage() {
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
}

function escape(): KeyboardEvent {
  return new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
}

/** A field that records the keys reaching it: an xterm textarea, the
 * palette's input. */
function keyRecorder<Tag extends "textarea" | "input" = "textarea">(
  parent: HTMLElement,
  tag: Tag = "textarea" as Tag,
): { element: HTMLElementTagNameMap[Tag]; keys: string[] } {
  const element = document.createElement(tag);
  parent.appendChild(element);
  const keys: string[] = [];
  (element as HTMLElement).addEventListener("keydown", (event) => keys.push(event.key));
  return { element, keys };
}

describe("ResumeSessionMenu opened from the pane's ⋯", () => {
  let shell: HTMLDivElement;
  let host: HTMLDivElement;
  let root: Root;
  let onHeaderClick: ReturnType<typeof vi.fn>;
  let handleRef: ReturnType<typeof createRef<ResumeSessionMenuHandle>>;
  /** Stands in for the pane's xterm textarea, where the keyboard still is. */
  let xterm: HTMLTextAreaElement;
  let xtermKeys: string[];

  async function render(onScreen = true) {
    await act(async () => {
      root.render(
        // The pane header: its click activates the pane and focuses its
        // terminal.
        createElement(
          "div",
          { onClick: onHeaderClick },
          createElement(ResumeSessionMenu, {
            paneId: "B",
            agentProfileId: "claude",
            cwd: "C:/repo",
            handleRef,
            onScreen,
          }),
        ),
      );
    });
  }

  beforeEach(async () => {
    stubLocalStorage();
    useSessionStore.setState(useSessionStore.getInitialState(), true);
    sessions.entries = [];

    onHeaderClick = vi.fn();
    handleRef = createRef<ResumeSessionMenuHandle>();
    // The pane: its header, where the list lives, and its terminal.
    shell = document.createElement("div");
    shell.className = "terminal-pane-shell";
    document.body.appendChild(shell);
    host = document.createElement("div");
    shell.appendChild(host);
    ({ element: xterm, keys: xtermKeys } = keyRecorder(shell));
    root = createRoot(host);
    await render();
  });

  afterEach(() => {
    act(() => root.unmount());
    shell.remove();
    vi.unstubAllGlobals();
  });

  function listOpen(): boolean {
    return host.querySelector(".resume-session-menu") !== null;
  }

  async function openList() {
    await act(async () => handleRef.current!.openAt({ right: 600, bottom: 40, top: 10 }));
    expect(listOpen()).toBe(true);
  }

  it("keeps a click on the list's empty area from activating the pane", async () => {
    // Clicking "Nenhuma sessão anterior encontrada" reached the header's
    // onClick: the pane became active and AppShell put the keyboard in its
    // terminal, with the list still open over it.
    await openList();
    const empty = host.querySelector<HTMLElement>(".resume-session-menu__empty")!;

    await act(async () => {
      empty.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      empty.click();
    });

    expect(onHeaderClick).not.toHaveBeenCalled();
    expect(listOpen()).toBe(true);
  });

  it("takes Esc before the terminal does, so it never reaches the agent", async () => {
    // xterm sends Esc to the PTY — interrupting Claude's turn or declining
    // its question — and swallows it before a bubbling window listener runs.
    await openList();
    xterm.focus();
    const esc = escape();

    await act(async () => {
      xterm.dispatchEvent(esc);
    });

    expect(xtermKeys).toEqual([]);
    expect(esc.defaultPrevented).toBe(true);
    expect(listOpen()).toBe(false);

    // Closed, it no longer stands in the terminal's way.
    await act(async () => {
      xterm.dispatchEvent(escape());
    });
    expect(xtermKeys).toEqual(["Escape"]);
  });

  it("closes on Esc with the keyboard nowhere, as right after opening it from ⋯", async () => {
    // Picking "Histórico" in ⋯ unmounts the item that had the focus.
    await openList();
    const esc = escape();

    await act(async () => {
      document.body.dispatchEvent(esc);
    });

    expect(esc.defaultPrevented).toBe(true);
    expect(listOpen()).toBe(false);
  });

  // Review store-hooks-ui-fixes#2 (scratch rev5/esc.test.ts): the list's
  // window-capture Esc ate the first Esc anywhere in the app.
  it("lets an Esc meant for something else through: the palette, a rename, another pane", async () => {
    await openList();
    const palette = keyRecorder(document.body, "input");
    const otherPane = document.createElement("div");
    otherPane.className = "terminal-pane-shell";
    document.body.appendChild(otherPane);
    const otherXterm = keyRecorder(otherPane);

    for (const target of [palette, otherXterm]) {
      const esc = escape();
      await act(async () => {
        target.element.dispatchEvent(esc);
      });
      expect(target.keys).toEqual(["Escape"]);
      expect(esc.defaultPrevented).toBe(false);
    }
    expect(listOpen()).toBe(true);

    palette.element.remove();
    otherPane.remove();
  });

  it("closes once its pane leaves the screen, so no hidden list is left holding Esc", async () => {
    // Ctrl+Tab to another session, Ctrl+Shift+M, a notification revealing a
    // pane elsewhere: none of them is a click outside the list.
    await openList();

    await render(false);
    expect(listOpen()).toBe(false);

    await act(async () => {
      xterm.dispatchEvent(escape());
    });
    expect(xtermKeys).toEqual(["Escape"]);

    // Back on screen, it stays closed until asked for again.
    await render(true);
    expect(listOpen()).toBe(false);
  });

  it("lets Esc in the rename field cancel only the rename", async () => {
    sessions.entries = [
      {
        id: "conv-1",
        title: "Refatorar o login",
        createdAt: "2026-09-25T10:00:00.000Z",
        updatedAt: "2026-09-25T10:05:00.000Z",
      },
    ];
    await openList();
    const pencil = host.querySelector<HTMLButtonElement>(".resume-session-menu__rename")!;
    await act(async () => pencil.click());
    const input = host.querySelector<HTMLInputElement>(".resume-session-menu__rename-input")!;
    expect(input).toBeTruthy();

    // A click in the field doesn't activate the pane either.
    await act(async () => input.click());
    expect(onHeaderClick).not.toHaveBeenCalled();

    await act(async () => {
      input.dispatchEvent(escape());
    });

    expect(host.querySelector(".resume-session-menu__rename-input")).toBeNull();
    expect(listOpen()).toBe(true);
  });

  it("still activates the pane when a conversation is picked", async () => {
    sessions.entries = [
      {
        id: "conv-1",
        title: "Refatorar o login",
        createdAt: "2026-09-25T10:00:00.000Z",
        updatedAt: "2026-09-25T10:05:00.000Z",
      },
    ];
    const resumePane = vi.fn();
    useSessionStore.setState({ resumePane });
    await openList();
    const row = host.querySelector<HTMLButtonElement>(".resume-session-menu__item")!;

    await act(async () => row.click());

    expect(resumePane).toHaveBeenCalledWith("B", "conv-1");
    expect(onHeaderClick).toHaveBeenCalledTimes(1);
    expect(listOpen()).toBe(false);
  });
});

describe("TerminalPaneHeader's history list", () => {
  let host: HTMLDivElement;
  let root: Root;
  let paneId: string;

  beforeEach(() => {
    stubLocalStorage();
    useSessionStore.setState(useSessionStore.getInitialState(), true);
    sessions.entries = [];
    const session = createEmptySession({ id: "s", title: "s", cwd: "C:/repo", agentProfileId: "claude" });
    useSessionStore.getState().addSession(session);
    [paneId] = collectPaneIds(session.layout);
    host = document.createElement("div");
    host.className = "terminal-pane-shell";
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  async function render(onScreen: boolean) {
    await act(async () => {
      root.render(
        createElement(TerminalPaneHeader, {
          paneId,
          sessionId: "s",
          cwd: "C:/repo",
          agentProfileId: "claude",
          paneIndex: 0,
          paneCount: 2,
          onScreenPaneCount: 2,
          isActive: true,
          isMaximized: false,
          onScreen,
          onFocus: vi.fn(),
          onClose: vi.fn(),
        }),
      );
    });
  }

  it("closes the list when the pane is parked, minimized or its session hidden", async () => {
    await render(true);
    const chevron = host.querySelector<HTMLButtonElement>('[data-pane-action="history"]')!;
    await act(async () => chevron.click());
    expect(host.querySelector(".resume-session-menu")).toBeTruthy();

    await render(false);
    expect(host.querySelector(".resume-session-menu")).toBeNull();
  });
});
