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
  fitTerminal,
} from "../core/terminal-factory";
import {
  registerTerminal,
  unregisterTerminal,
} from "../core/terminal-registry";
import { attachOrphanCompositionEndGuard } from "../core/terminal-composition-guard";
import { isBareMouseHoverReport } from "../core/pty-text";

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

      if (terminal.cols > 0 && terminal.rows > 0) {
        created.resizePty.current?.(terminal.cols, terminal.rows);
      }
    };
    registerPaneFitter(paneId, fitPane);

    const dataListener = terminal.onData((data) => {
      if (isBareMouseHoverReport(data)) {
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
    const focusTerminal = () => {
      terminal.focus();
    };
    container.addEventListener("mousedown", focusTerminal);

    setInstance(created);

    return () => {
      setInstance(null);
      container.removeEventListener("mousedown", focusTerminal);
      compositionCleanup();
      dataListener.dispose();
      resizeListener.dispose();
      unregisterPaneFitter(paneId);
      unregisterTerminal(paneId);
      terminal.dispose();
    };
  }, [active, containerRef, paneId]);

  return instance;
}
