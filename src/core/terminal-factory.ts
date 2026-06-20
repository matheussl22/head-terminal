import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";

import { createTerminalOptions } from "../config/theme";
import { logEvent } from "./logger";
import { recordPtyReadBatch } from "./dev-metrics";

const SCROLLBACK = 5000;
const MIN_COLS = 80;
const MIN_ROWS = 24;

export function createConfiguredTerminal(): {
  terminal: Terminal;
  fitAddon: FitAddon;
} {
  const terminal = new Terminal({
    ...createTerminalOptions(),
    scrollback: SCROLLBACK,
  });
  const fitAddon = new FitAddon();
  const webLinksAddon = new WebLinksAddon();

  terminal.loadAddon(fitAddon);
  terminal.loadAddon(webLinksAddon);

  const webglEnabled = shouldEnableWebglRenderer();
  logEvent("info", "terminal.renderer", {
    webgl: webglEnabled,
    reason: webglEnabled ? "enabled" : "linux_disabled",
  });

  if (webglEnabled) {
    // Dynamically imported so the ~300KB addon is never fetched/parsed on
    // Linux, where it's disabled anyway (see shouldEnableWebglRenderer).
    void import("@xterm/addon-webgl").then(({ WebglAddon }) => {
      try {
        const webglAddon = new WebglAddon();
        terminal.loadAddon(webglAddon);
        webglAddon.onContextLoss(() => {
          webglAddon.dispose();
        });
      } catch {
        // WebGL unavailable — DOM renderer is the fallback.
      }
    });
  }

  return { terminal, fitAddon };
}

function shouldEnableWebglRenderer(): boolean {
  // WebGL can crash WebKitGTK on Linux and leave a blank window.
  return !/Linux/i.test(navigator.userAgent);
}

export function fitTerminal(fitAddon: FitAddon, terminal: Terminal): void {
  fitAddon.fit();

  if (terminal.cols < 2 || terminal.rows < 2) {
    terminal.resize(MIN_COLS, MIN_ROWS);
  }
}

export function createRafPtyWriter(
  terminal: Terminal,
  isSuspended: () => boolean,
  bufferOutput: (data: Uint8Array) => void,
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
