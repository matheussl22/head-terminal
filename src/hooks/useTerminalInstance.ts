import { useEffect, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";

import { checkpoint, logEvent } from "../core/logger";
import { useSessionStore } from "../core/session-manager";
import {
  registerPaneFitter,
  unregisterPaneFitter,
} from "../core/pane-fit-registry";
import {
  createConfiguredTerminal,
  createWebglController,
  fitTerminal,
} from "../core/terminal-factory";
import {
  registerTerminal,
  unregisterTerminal,
} from "../core/terminal-registry";
import { attachOrphanCompositionEndGuard } from "../core/terminal-composition-guard";
import { attachTerminalPasteSurface } from "../core/terminal-clipboard";
import { isBareMouseHoverReport, isFocusReport } from "../core/pty-text";

/**
 * One xterm instance per pane. It outlives the PTY: process restarts swap the
 * write/resize refs below without disposing the terminal, so scrollback
 * survives respawns (§2.1 do plano de refatoração).
 */
export interface TerminalInstance {
  terminal: Terminal;
  fitAddon: FitAddon;
  container: HTMLDivElement;
  writeToPty: { current: ((data: string) => void) | null };
  resizePty: { current: ((cols: number, rows: number) => void) | null };
  spawnCount: { current: number };
}

export function useTerminalInstance(
  containerRef: React.RefObject<HTMLDivElement | null>,
  paneId: string,
  active: boolean,
  isVisible = true,
): TerminalInstance | null {
  const [instance, setInstance] = useState<TerminalInstance | null>(null);

  useEffect(() => {
    if (!active) {
      return;
    }

    const container = containerRef.current;
    if (!container) {
      return;
    }

    const { terminal, fitAddon, searchAddon } = createConfiguredTerminal();
    terminal.open(container);
    registerTerminal(paneId, { terminal, searchAddon });

    // Pane ativo que acabou de montar (spawn preguiçoso) recebe o foco:
    // o effect do AppShell já disparou e não vai refazer.
    if (useSessionStore.getState().activePaneId === paneId) {
      terminal.focus();
    }
    checkpoint("js.terminal.dom_opened", { paneId });

    const created: TerminalInstance = {
      terminal,
      fitAddon,
      container,
      writeToPty: { current: null },
      resizePty: { current: null },
      spawnCount: { current: 0 },
    };

    let loggedFitOk = false;
    let skippedFits = 0;
    let lastSentSize: { cols: number; rows: number } | null = null;
    const fitPane = () => {
      const size = fitTerminal(fitAddon, terminal);

      if (!size) {
        // Pane not measurable — a minimized window reports a zero-sized
        // viewport, and a pane that just mounted may not be laid out yet.
        // The terminal deliberately keeps the size it has: fitting here
        // would truncate its buffer (see fitTerminal). One log per streak,
        // since a minimized window keeps the ResizeObserver ticking.
        skippedFits += 1;
        if (skippedFits === 1) {
          logEvent("warn", "terminal.fit_skipped", {
            paneId,
            cols: terminal.cols,
            rows: terminal.rows,
          });
        }
        return;
      }
      skippedFits = 0;

      if (!loggedFitOk) {
        loggedFitOk = true;
        checkpoint("js.terminal.fit_ok", {
          paneId,
          cols: size.cols,
          rows: size.rows,
        });
      }

      // fitPane runs on every visibility flip and every ResizeObserver
      // tick, usually landing on the exact size the pty already has —
      // re-sending it just churns SIGWINCH at the agent for nothing. Every
      // size that does reach the pty is logged, not just the first fit: a
      // bad one corrupts the agent's redraw and used to leave no trace.
      if (lastSentSize?.cols !== size.cols || lastSentSize.rows !== size.rows) {
        logEvent("info", "terminal.resized", {
          paneId,
          cols: size.cols,
          rows: size.rows,
        });
        lastSentSize = { cols: size.cols, rows: size.rows };
        created.resizePty.current?.(size.cols, size.rows);
      }
    };
    registerPaneFitter(paneId, fitPane);

    const dataListener = terminal.onData((data) => {
      if (isBareMouseHoverReport(data) || isFocusReport(data)) {
        return;
      }
      created.writeToPty.current?.(data);
    });
    const resizeListener = terminal.onResize(({ cols, rows }) => {
      if (cols > 0 && rows > 0) {
        created.resizePty.current?.(cols, rows);
      }
    });
    const compositionCleanup = attachOrphanCompositionEndGuard(
      container,
      (data) => {
        created.writeToPty.current?.(data);
      },
    );
    const pasteCleanup = attachTerminalPasteSurface(container, terminal);
    const focusTerminal = () => {
      terminal.focus();
    };
    container.addEventListener("mousedown", focusTerminal);

    setInstance(created);

    return () => {
      setInstance(null);
      container.removeEventListener("mousedown", focusTerminal);
      compositionCleanup();
      pasteCleanup();
      dataListener.dispose();
      resizeListener.dispose();
      unregisterPaneFitter(paneId);
      unregisterTerminal(paneId);
      terminal.dispose();
    };
  }, [active, containerRef, paneId]);

  useEffect(() => {
    if (!instance) {
      return;
    }
    const webgl = createWebglController(instance.terminal);
    webgl.setVisible(isVisible);
    return () => {
      webgl.dispose();
    };
  }, [instance, isVisible]);

  return instance;
}
