import { SearchAddon } from "@xterm/addon-search";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { createTerminalOptions } from "../config/theme";
import { logError, logEvent } from "./logger";
import { recordPtyReadBatch } from "./dev-metrics";
import {
  loadCopyOnSelect,
  loadRendererPreference,
  type TerminalRenderer,
} from "./ui-preferences";
import {
  isTerminalPasteKey,
  pasteClipboardIntoTerminal,
} from "./terminal-clipboard";

const SCROLLBACK = 5000;
/**
 * @xterm/addon-fit floors its proposal at 2x1 whenever the pane measures zero
 * — a minimized window, a pane whose layout hasn't settled — and `fit()`
 * applies that floor. Resizing the buffer to 2 columns truncates every line in
 * it, and a ConPTY pane never reflows them back, so the scrollback comes back
 * as one or two characters per row. Anything below a pane a human could use is
 * treated as "not measurable yet" and skipped instead.
 */
const MIN_FIT_COLS = 10;
const MIN_FIT_ROWS = 3;
const WEBGL_FAILED_KEY = "head-terminal.webgl-failed";
/** One xterm write per rAF, capped so a huge burst still yields. */
const MAX_FRAME_WRITE_BYTES = 192 * 1024;

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
        void window.headTerminal.clipboard.writeText(selection).catch((error) => {
          logError("terminal.clipboard_write_failed", error);
        });
      }
      return false;
    }

    if (isTerminalPasteKey(event)) {
      event.preventDefault();
      pasteClipboardIntoTerminal(terminal);
      return false;
    }

    return true;
  });

  if (loadCopyOnSelect()) {
    terminal.onSelectionChange(() => {
      const selection = terminal.getSelection();
      if (selection) {
        void window.headTerminal.clipboard.writeText(selection).catch((error) => {
          logError("terminal.clipboard_write_failed", error);
        });
      }
    });
  }

  return { terminal, fitAddon, searchAddon };
}

export interface WebglController {
  setVisible(visible: boolean): void;
  dispose(): void;
}

/**
 * GPU renderer for one pane. Attached only while that pane's session is
 * visible; the xterm buffer stays. A context loss falls back on this pane
 * and records the global auto-fail flag only if it was on screen.
 */
export function createWebglController(terminal: Terminal): WebglController {
  let visible = false;
  let disposed = false;
  let addon: { dispose(): void } | null = null;
  let loadToken = 0;

  const dropAddon = () => {
    const current = addon;
    addon = null;
    if (!current) {
      return;
    }
    try {
      current.dispose();
    } catch {
      // Addon may already be gone after a context loss.
    }
  };

  const attach = () => {
    if (disposed || !visible || addon) {
      return;
    }
    const renderer = loadRendererPreference();
    const webglEnabled = shouldEnableWebglRenderer(renderer);
    logEvent("info", "terminal.renderer", {
      webgl: webglEnabled,
      preference: renderer,
      reason: webglEnabled ? "enabled" : "dom",
    });
    if (!webglEnabled) {
      return;
    }

    const token = ++loadToken;
    void import("@xterm/addon-webgl")
      .then(({ WebglAddon }) => {
        if (disposed || !visible || token !== loadToken || addon) {
          return;
        }
        try {
          const webglAddon = new WebglAddon();
          terminal.loadAddon(webglAddon);
          webglAddon.onContextLoss(() => {
            dropAddon();
            if (visible && !disposed) {
              markWebglFailed();
            }
          });
          addon = webglAddon;
        } catch {
          if (visible && !disposed) {
            markWebglFailed();
          }
        }
      })
      .catch(() => {
        if (visible && !disposed) {
          markWebglFailed();
        }
      });
  };

  return {
    setVisible(nextVisible) {
      visible = nextVisible;
      if (nextVisible) {
        attach();
        return;
      }
      loadToken += 1;
      dropAddon();
    },
    dispose() {
      disposed = true;
      loadToken += 1;
      dropAddon();
    },
  };
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

/**
 * Applies the proposed geometry by hand instead of calling `fitAddon.fit()`,
 * which applies whatever it proposes — degenerate floor included. Returns the
 * size in effect, or `null` when the pane wasn't measurable and the terminal
 * was left exactly as it was.
 */
export function fitTerminal(
  fitAddon: FitAddon,
  terminal: Terminal,
): { cols: number; rows: number } | null {
  const proposed = fitAddon.proposeDimensions();
  if (!proposed || proposed.cols < MIN_FIT_COLS || proposed.rows < MIN_FIT_ROWS) {
    return null;
  }

  // The proposal already keeps the scrollbar's width free of glyphs (the
  // addon subtracts its default scrollbar width from the available width);
  // subtracting the viewport's own scrollbar on top of that gave up two to
  // four more columns and left a black strip down the right of every pane.
  const { cols, rows } = proposed;
  if (cols !== terminal.cols || rows !== terminal.rows) {
    terminal.resize(cols, rows);
  }

  return { cols, rows };
}

const frameTextDecoder = new TextDecoder();

function concatChunks(chunks: Uint8Array[], bytes: number): Uint8Array {
  if (chunks.length === 1) {
    return chunks[0];
  }
  const merged = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/** A scheduled animation frame that has not run by then is not coming (the
 * window is minimized or fully covered): a timer flushes instead. */
const RAF_FALLBACK_MS = 100;
/** Batching interval while the page is hidden and rAF is known to be off. */
const HIDDEN_FLUSH_MS = 16;

function pageHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

export function createRafPtyWriter(
  terminal: Terminal,
  onFrameText?: (text: string) => void,
): (data: Uint8Array) => void {
  const pending: Uint8Array[] = [];
  let rafId: number | null = null;
  let timerId: ReturnType<typeof setTimeout> | null = null;

  // Paint-aligned flushes come from requestAnimationFrame, which Chromium
  // stops for a minimized or occluded window. Output then piled up unparsed:
  // no titles, no screen, no status — the pane looked frozen in whatever
  // state it had and never notified the user who had stepped away. Every
  // flush is armed on both a frame and a timer; whichever fires first takes
  // the batch and disarms the other, so nothing is written twice.
  const schedule = () => {
    if (rafId !== null || timerId !== null) {
      return;
    }
    const hidden = pageHidden();
    if (!hidden && typeof requestAnimationFrame === "function") {
      rafId = requestAnimationFrame(run);
    }
    timerId = setTimeout(run, hidden ? HIDDEN_FLUSH_MS : RAF_FALLBACK_MS);
  };

  const run = () => {
    if (rafId !== null) {
      if (typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(rafId);
      }
      rafId = null;
    }
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
    flush();
  };

  const flush = () => {
    if (pending.length === 0) {
      return;
    }

    let takeCount = 0;
    let takeBytes = 0;
    for (const chunk of pending) {
      if (takeCount > 0 && takeBytes + chunk.byteLength > MAX_FRAME_WRITE_BYTES) {
        break;
      }
      takeBytes += chunk.byteLength;
      takeCount += 1;
      if (takeBytes >= MAX_FRAME_WRITE_BYTES) {
        break;
      }
    }

    const batch = pending.splice(0, takeCount);
    const merged = concatChunks(batch, takeBytes);
    recordPtyReadBatch(takeBytes);

    // Hidden panes are written to just like visible ones: xterm pauses its
    // own renderer while a terminal sits outside the viewport (see
    // .session-workspace--hidden), so keeping every pane current costs
    // parsing only — and switching sessions becomes a pure visibility flip
    // onto an already-correct, already-scrolled screen instead of replaying
    // a backlog.
    //
    // The detectors run for hidden panes too: the status of a background
    // session, the folder-trust auto-accept, the context meter and the
    // workspace detector all read what the pane shows, whether or not it is
    // on screen. The callback fires after xterm parsed the frame, so it
    // never delays paint.
    if (onFrameText) {
      const text = frameTextDecoder.decode(merged);
      terminal.write(merged, () => onFrameText(text));
    } else {
      terminal.write(merged);
    }

    if (pending.length > 0) {
      schedule();
    }
  };

  return (data: Uint8Array) => {
    if (data.byteLength === 0) {
      return;
    }

    pending.push(data);
    schedule();
  };
}
