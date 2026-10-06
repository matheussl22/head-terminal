// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { setCachedPlatformInfoForTests } from "../core/platform-info";
import { collectPaneIds } from "../core/session-layout";
import { createEmptySession, useSessionStore } from "../core/session-manager";
import { useKeyboardShortcuts } from "./useAppShortcuts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Search, zoom and the session keys used to stop at xterm's helper textarea,
// taken for a text field: with the keyboard in a pane only ⌘⇧P / ⌘⇧N and the
// pane shortcuts did anything.
describe("useKeyboardShortcuts with the keyboard in a pane", () => {
  let host: HTMLDivElement;
  let root: Root;
  let terminal: HTMLTextAreaElement;
  let field: HTMLInputElement;
  let onSearch: Mock<() => void>;

  function ShortcutsProbe() {
    useKeyboardShortcuts({
      onCreateSession: () => undefined,
      onCommandPalette: () => undefined,
      onRenameSession: () => undefined,
      onSearch,
      onCloseSearch: () => undefined,
    });
    return null;
  }

  function mount(platform: "darwin" | "linux") {
    setCachedPlatformInfoForTests({ platform, arch: "arm64", homeDir: "/tmp" });
    act(() => root.render(createElement(ShortcutsProbe)));
  }

  function press(target: HTMLElement, init: KeyboardEventInit): KeyboardEvent {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    act(() => {
      target.dispatchEvent(event);
    });
    return event;
  }

  function state() {
    return useSessionStore.getState();
  }

  beforeEach(() => {
    onSearch = vi.fn<() => void>();
    (window as unknown as { headTerminal: unknown }).headTerminal = {
      workspace: { save: () => Promise.resolve(), load: () => Promise.resolve(null) },
      diagnostics: { appendEvent: () => undefined, appendCheckpoint: () => undefined },
    };
    useSessionStore.setState(useSessionStore.getInitialState(), true);
    for (const id of ["one", "two", "three"]) {
      state().addSession(createEmptySession({ id, title: id, cwd: "/tmp", agentProfileId: "claude" }));
    }
    state().setActiveSessionId("one");

    // Where the keyboard sits in a pane: xterm's hidden textarea.
    terminal = document.createElement("textarea");
    terminal.className = "xterm-helper-textarea";
    field = document.createElement("input");
    host = document.createElement("div");
    // Outside the React root, which clears its container on first render.
    document.body.append(host, terminal, field);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    terminal.remove();
    field.remove();
    setCachedPlatformInfoForTests(null);
    delete (window as unknown as { headTerminal?: unknown }).headTerminal;
  });

  it("searches, switches sessions and moves between panes on macOS", () => {
    mount("darwin");

    expect(press(terminal, { key: "f", code: "KeyF", metaKey: true }).defaultPrevented).toBe(true);
    expect(onSearch).toHaveBeenCalledTimes(1);

    press(terminal, { key: "2", code: "Digit2", metaKey: true });
    expect(state().activeSessionId).toBe("two");

    press(terminal, { key: "Tab", code: "Tab", ctrlKey: true });
    expect(state().activeSessionId).toBe("three");

    press(terminal, { key: "}", code: "BracketRight", metaKey: true, shiftKey: true });
    expect(state().activeSessionId).toBe("one");
    press(terminal, { key: "{", code: "BracketLeft", metaKey: true, shiftKey: true });
    expect(state().activeSessionId).toBe("three");

    press(terminal, { key: "1", code: "Digit1", metaKey: true });
    press(terminal, { key: "\\", code: "Backslash", metaKey: true });
    const [firstPane, secondPane] = collectPaneIds(state().sessions[0].layout);
    expect(state().activePaneId).toBe(firstPane);
    press(terminal, { key: "ArrowRight", code: "ArrowRight", metaKey: true, altKey: true });
    expect(state().activePaneId).toBe(secondPane);
    press(terminal, { key: "ArrowRight", code: "ArrowRight", metaKey: true, altKey: true });
    expect(state().activePaneId).toBe(firstPane);
    press(terminal, { key: "ArrowUp", code: "ArrowUp", metaKey: true, altKey: true });
    expect(state().activePaneId).toBe(secondPane);
  });

  it("zooms the terminal font with ⌘= / ⌘- / ⌘0 on macOS", () => {
    mount("darwin");
    for (const key of ["=", "-", "0"]) {
      expect(press(terminal, { key, metaKey: true }).defaultPrevented).toBe(true);
    }
  });

  it("leaves ⌃⌘F to the menu's full screen", () => {
    mount("darwin");
    const event = press(terminal, { key: "f", code: "KeyF", metaKey: true, ctrlKey: true });
    expect(onSearch).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("keeps out of the app's own text fields", () => {
    mount("darwin");
    press(field, { key: "f", code: "KeyF", metaKey: true });
    press(field, { key: "2", code: "Digit2", metaKey: true });
    press(field, { key: "Tab", code: "Tab", ctrlKey: true });
    expect(onSearch).not.toHaveBeenCalled();
    expect(state().activeSessionId).toBe("one");
  });

  it("goes through the project on screen only, in projects mode", () => {
    mount("darwin");
    // "one", "two", "three" land in the first project; "four" and "five" in
    // a second one, created and on screen.
    act(() => {
      state().setProjectsEnabled(true);
      state().addProject("Outro");
      for (const id of ["four", "five"]) {
        state().addSession(
          createEmptySession({ id, title: id, cwd: "/tmp", agentProfileId: "claude" }),
        );
      }
    });
    expect(state().activeSessionId).toBe("five");

    press(terminal, { key: "1", code: "Digit1", metaKey: true });
    expect(state().activeSessionId).toBe("four");
    press(terminal, { key: "3", code: "Digit3", metaKey: true });
    expect(state().activeSessionId).toBe("four");

    press(terminal, { key: "Tab", code: "Tab", ctrlKey: true });
    expect(state().activeSessionId).toBe("five");
    press(terminal, { key: "Tab", code: "Tab", ctrlKey: true });
    expect(state().activeSessionId).toBe("four");
    press(terminal, { key: "{", code: "BracketLeft", metaKey: true, shiftKey: true });
    expect(state().activeSessionId).toBe("five");
  });

  it("goes through the unfolded projects in order, in the grouped view", () => {
    mount("darwin");
    let general = "";
    act(() => {
      state().setProjectsEnabled(true);
      state().setProjectsView("grouped");
      general = state().activeProjectId!;
      const other = state().addProject("Outro", undefined, { activate: false });
      state().addSession({
        ...createEmptySession({ id: "four", title: "four", cwd: "/tmp", agentProfileId: "claude" }),
        projectId: other,
      });
    });

    press(terminal, { key: "2", code: "Digit2", metaKey: true });
    expect(state().activeSessionId).toBe("two");
    press(terminal, { key: "4", code: "Digit4", metaKey: true });
    expect(state().activeSessionId).toBe("four");

    // Folding "one", "two" and "three" away leaves "four" alone in the order.
    act(() => state().toggleProjectCollapsed(general));
    press(terminal, { key: "2", code: "Digit2", metaKey: true });
    expect(state().activeSessionId).toBe("four");
    press(terminal, { key: "1", code: "Digit1", metaKey: true });
    expect(state().activeSessionId).toBe("four");
  });

  it("uses Ctrl off macOS", () => {
    mount("linux");
    press(terminal, { key: "f", code: "KeyF", metaKey: true });
    expect(onSearch).not.toHaveBeenCalled();
    press(terminal, { key: "f", code: "KeyF", ctrlKey: true });
    expect(onSearch).toHaveBeenCalledTimes(1);
    press(terminal, { key: "Tab", code: "Tab", ctrlKey: true });
    expect(state().activeSessionId).toBe("two");
  });
});
