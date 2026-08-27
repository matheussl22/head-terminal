// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";

import {
  attachTerminalPasteSurface,
  isTerminalPasteKey,
  pasteClipboardIntoTerminal,
} from "./terminal-clipboard";

function key(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", init);
}

function mockTerminal(): Terminal {
  return { paste: vi.fn() } as unknown as Terminal;
}

function stubHeadTerminal(clipboard: Record<string, unknown>): void {
  vi.stubGlobal("headTerminal", {
    clipboard,
    diagnostics: { appendEvent: vi.fn() },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("isTerminalPasteKey", () => {
  it("recognizes Ctrl+V, Ctrl+Shift+V and Cmd+V", () => {
    expect(isTerminalPasteKey(key({ key: "v", ctrlKey: true }))).toBe(true);
    expect(isTerminalPasteKey(key({ key: "V", ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(isTerminalPasteKey(key({ key: "v", metaKey: true }))).toBe(true);
    expect(isTerminalPasteKey(key({ key: "v", ctrlKey: true, altKey: true }))).toBe(false);
    expect(isTerminalPasteKey(key({ key: "c", ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isTerminalPasteKey(new KeyboardEvent("keyup", { key: "v", ctrlKey: true }))).toBe(false);
    expect(isTerminalPasteKey(key({ key: "Process", code: "KeyV", ctrlKey: true }))).toBe(true);
  });
});

describe("pasteClipboardIntoTerminal", () => {
  it("pastes the payload from the main-process clipboard", async () => {
    const terminal = mockTerminal();
    const readForTerminal = vi.fn(async () => "/mnt/c/Temp/snip.png");
    stubHeadTerminal({ readForTerminal, importPaths: vi.fn() });

    pasteClipboardIntoTerminal(terminal);
    await vi.waitFor(() => {
      expect(terminal.paste).toHaveBeenCalledWith("/mnt/c/Temp/snip.png");
    });
  });

  it("does not paste twice when keydown and the paste event both fire", async () => {
    const terminal = mockTerminal();
    const readForTerminal = vi.fn(async () => "/tmp/shot.png");
    stubHeadTerminal({
      readForTerminal,
      importPaths: vi.fn(),
      pathForFile: vi.fn(),
    });

    pasteClipboardIntoTerminal(terminal);
    pasteClipboardIntoTerminal(terminal);
    await vi.waitFor(() => {
      expect(terminal.paste).toHaveBeenCalledOnce();
    });
    expect(readForTerminal).toHaveBeenCalledOnce();

    pasteClipboardIntoTerminal(terminal);
    await vi.waitFor(() => {
      expect(terminal.paste).toHaveBeenCalledTimes(2);
    });
  });

  it("does nothing when the clipboard has no pasteable payload", async () => {
    const terminal = mockTerminal();
    stubHeadTerminal({
      readForTerminal: vi.fn(async () => null),
      importPaths: vi.fn(),
    });

    pasteClipboardIntoTerminal(terminal);
    await Promise.resolve();
    await Promise.resolve();
    expect(terminal.paste).not.toHaveBeenCalled();
  });
});

describe("attachTerminalPasteSurface", () => {
  it("intercepts paste events so xterm cannot swallow an image clipboard", async () => {
    const terminal = mockTerminal();
    const root = document.createElement("div");
    stubHeadTerminal({
      readForTerminal: vi.fn(async () => "/tmp/shot.png"),
      importPaths: vi.fn(),
      pathForFile: vi.fn(),
    });

    const detach = attachTerminalPasteSurface(root, terminal);
    const event = new Event("paste", { bubbles: true, cancelable: true });
    root.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    await vi.waitFor(() => {
      expect(terminal.paste).toHaveBeenCalledWith("/tmp/shot.png");
    });
    detach();
  });

  it("pastes POSIX paths for files dropped onto the pane", async () => {
    const terminal = mockTerminal();
    const root = document.createElement("div");
    const importPaths = vi.fn(async () => "'/mnt/c/Users/a.png'");
    const pathForFile = vi.fn((file: unknown) => (file as { path: string }).path);
    stubHeadTerminal({
      readForTerminal: vi.fn(),
      importPaths,
      pathForFile,
    });

    const detach = attachTerminalPasteSurface(root, terminal);
    const file = { name: "a.png", path: String.raw`C:\Users\a.png` };
    const event = new Event("drop", { bubbles: true, cancelable: true }) as DragEvent;
    Object.defineProperty(event, "dataTransfer", {
      value: { files: [file] },
    });
    root.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    await vi.waitFor(() => {
      expect(importPaths).toHaveBeenCalledWith([String.raw`C:\Users\a.png`]);
      expect(terminal.paste).toHaveBeenCalledWith("'/mnt/c/Users/a.png'");
    });
    detach();
  });

  it("handles Ctrl+V on the pane even when xterm did not see the key", async () => {
    const terminal = mockTerminal();
    const root = document.createElement("div");
    stubHeadTerminal({
      readForTerminal: vi.fn(async () => "/mnt/c/Users/a.png"),
      importPaths: vi.fn(),
      pathForFile: vi.fn(),
    });

    const detach = attachTerminalPasteSurface(root, terminal);
    const event = new KeyboardEvent("keydown", {
      key: "v",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    root.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    await vi.waitFor(() => {
      expect(terminal.paste).toHaveBeenCalledWith("/mnt/c/Users/a.png");
    });
    detach();
  });

  it("imports files exposed on the paste event before reading Electron clipboard", async () => {
    const terminal = mockTerminal();
    const root = document.createElement("div");
    const importPaths = vi.fn(async () => "/mnt/c/Users/a.png");
    const readForTerminal = vi.fn(async () => "/tmp/should-not-use.png");
    const pathForFile = vi.fn((file: unknown) => (file as { path: string }).path);
    stubHeadTerminal({
      readForTerminal,
      importPaths,
      pathForFile,
    });

    const detach = attachTerminalPasteSurface(root, terminal);
    const file = { name: "a.png", path: String.raw`C:\Users\a.png` };
    const event = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(event, "clipboardData", {
      value: { files: [file] },
    });
    root.dispatchEvent(event);

    await vi.waitFor(() => {
      expect(importPaths).toHaveBeenCalledWith([String.raw`C:\Users\a.png`]);
      expect(terminal.paste).toHaveBeenCalledWith("/mnt/c/Users/a.png");
    });
    expect(readForTerminal).not.toHaveBeenCalled();
    detach();
  });
});
