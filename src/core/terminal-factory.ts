import { SearchAddon } from "@xterm/addon-search";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";

import { createTerminalOptions } from "../config/theme";
import { logEvent } from "./logger";
import { recordPtyReadBatch } from "./dev-metrics";
import {
  loadCopyOnSelect,
  loadRendererPreference,
  type TerminalRenderer,
} from "./ui-preferences";

const SCROLLBACK = 5000;
const MIN_COLS = 80;
const MIN_ROWS = 24;
const WEBGL_FAILED_KEY = "head-terminal.webgl-failed";

export interface ConfiguredTerminal {
  terminal: Terminal;
  fitAddon: FitAddon;
  searchAddon: SearchAddon;
}

export function createConfiguredTerminal(): ConfiguredTerminal {
  const terminal = new Terminal({
    ...createTerminalOptions(),
    scrollback: SCROLLBACK,
  });
  const fitAddon = new FitAddon();
  const webLinksAddon = new WebLinksAddon();
  const searchAddon = new SearchAddon();

  terminal.loadAddon(fitAddon);
  terminal.loadAddon(webLinksAddon);
  terminal.loadAddon(searchAddon);

  terminal.attachCustomKeyEventHandler((event) => {
    // xterm sends F9 to the shell as a VT escape sequence and stops the
    // keydown from bubbling, so the global F9 voice shortcut never fires
    // while a terminal pane is focused.
    if (event.key === "F9") {
      return false;
    }

    if (event.type !== "keydown") {
      return true;
    }

    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.shiftKey && event.key.toLowerCase() === "c") {
      const selection = terminal.getSelection();
      if (selection) {
        event.preventDefault();
        void navigator.clipboard.writeText(selection);
      }
      return false;
    }

    if (mod && event.shiftKey && event.key.toLowerCase() === "v") {
      event.preventDefault();
      void navigator.clipboard.readText().then((text) => {
        if (text) {
          terminal.paste(text);
        }
      });
      return false;
    }

    return true;
  });

  if (loadCopyOnSelect()) {
    terminal.onSelectionChange(() => {
      const selection = terminal.getSelection();
      if (selection) {
        void navigator.clipboard.writeText(selection);
      }
    });
  }

  const renderer = loadRendererPreference();
  const webglEnabled = shouldEnableWebglRenderer(renderer);
  logEvent("info", "terminal.renderer", {
    webgl: webglEnabled,
    preference: renderer,
    reason: webglEnabled ? "enabled" : "dom",
  });

  if (webglEnabled) {
    void import("@xterm/addon-webgl").then(({ WebglAddon }) => {
      try {
        const webglAddon = new WebglAddon();
        terminal.loadAddon(webglAddon);
        webglAddon.onContextLoss(() => {
          markWebglFailed();
          webglAddon.dispose();
        });
      } catch {
        markWebglFailed();
      }
    });
  }

  return { terminal, fitAddon, searchAddon };
}

function markWebglFailed(): void {
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(WEBGL_FAILED_KEY, "1");
  }
}

function shouldEnableWebglRenderer(preference: TerminalRenderer): boolean {
  if (preference === "dom") {
    return false;
  }
  if (preference === "webgl") {
    return true;
  }
  if (typeof localStorage !== "undefined" && localStorage.getItem(WEBGL_FAILED_KEY)) {
    return false;
  }
  // ponytail: auto tries WebGL on Linux now that DMABUF is disabled in Rust.
  return true;
}

export function fitTerminal(fitAddon: FitAddon, terminal: Terminal): void {
  fitAddon.fit();

  const proposed = fitAddon.proposeDimensions();
  if (proposed && proposed.cols >= 2 && proposed.rows >= 2) {
  const viewport = terminal.element?.querySelector<HTMLElement>(".xterm-viewport");
  if (viewport) {
    const scrollbarWidth = viewport.offsetWidth - viewport.clientWidth;
    if (scrollbarWidth > 0) {
      const cellWidth = viewport.clientWidth / proposed.cols;
      const cols = Math.max(
        2,
        proposed.cols - Math.ceil(scrollbarWidth / Math.max(cellWidth, 1)),
      );
      if (cols !== terminal.cols || proposed.rows !== terminal.rows) {
        terminal.resize(cols, proposed.rows);
      }
    }
  }
  }

  if (terminal.cols < 2 || terminal.rows < 2) {
    terminal.resize(MIN_COLS, MIN_ROWS);
  }
}

const frameTextDecoder = new TextDecoder();

export function createRafPtyWriter(
  terminal: Terminal,
  isSuspended: () => boolean,
  bufferOutput: (data: Uint8Array) => void,
  onFrameText?: (text: string) => void,
): (data: Uint8Array) => void {
  let pending: Uint8Array[] = [];
  let rafId: number | null = null;
  let pendingBytes = 0;

  const flush = () => {
    rafId = null;
    if (pending.length === 0) {
      return;
    }

    const batch = pending;
    const bytes = pendingBytes;
    pending = [];
    pendingBytes = 0;

    recordPtyReadBatch(bytes);

    if (onFrameText) {
      const merged = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of batch) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
      }
      onFrameText(frameTextDecoder.decode(merged));
    }

    if (isSuspended()) {
      for (const chunk of batch) {
        bufferOutput(chunk);
      }
      return;
    }

    for (const chunk of batch) {
      terminal.write(chunk);
    }
  };

  return (data: Uint8Array) => {
    if (data.byteLength === 0) {
      return;
    }

    pending.push(data);
    pendingBytes += data.byteLength;

    if (rafId === null) {
      rafId = requestAnimationFrame(flush);
    }
  };
}
