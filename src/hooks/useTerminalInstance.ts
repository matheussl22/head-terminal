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
    let lastSentSize: { cols: number; rows: number } | null = null;
    const fitPane = () => {
      fitTerminal(fitAddon, terminal);

      if (!loggedFitOk && terminal.cols > 0 && terminal.rows > 0) {
        loggedFitOk = true;
        checkpoint("js.terminal.fit_ok", {
          paneId,
          cols: terminal.cols,
          rows: terminal.rows,
        });
      } else if (terminal.cols <= 0 || terminal.rows <= 0) {
        logEvent("warn", "terminal.fit_zero", {
          paneId,
          cols: terminal.cols,
          rows: terminal.rows,
        });
      }

      // fitPane runs on every visibility flip and every ResizeObserver
      // tick, usually landing on the exact size the pty already has —
      // re-sending it just churns SIGWINCH at the agent for nothing.
      if (
        terminal.cols > 0 &&
        terminal.rows > 0 &&
        (lastSentSize?.cols !== terminal.cols || lastSentSize.rows !== terminal.rows)
      ) {
        lastSentSize = { cols: terminal.cols, rows: terminal.rows };
        created.resizePty.current?.(terminal.cols, terminal.rows);
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
