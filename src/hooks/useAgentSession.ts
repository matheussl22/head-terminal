import { useEffect, useRef } from "react";
import type { IDisposable } from "tauri-pty";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";

import { getAgentProfile } from "../config/agents";
import { createTerminalOptions } from "../config/theme";
import {
  attachPtyDataListener,
  attachPtyExitListener,
  createPtyBridge,
} from "../core/pty-bridge";
import { useSessionStore } from "../core/session-manager";
import { attachOrphanCompositionEndGuard } from "../core/terminal-composition-guard";

interface UseAgentSessionOptions {
  paneId: string;
  sessionId: string;
  cwd: string;
  agentProfileId: string;
  isVisible: boolean;
  containerRef: React.RefObject<HTMLDivElement | null>;
}

const MIN_COLS = 80;
const MIN_ROWS = 24;

function fitTerminal(fitAddon: FitAddon, terminal: Terminal): void {
  fitAddon.fit();

  if (terminal.cols < 2 || terminal.rows < 2) {
    terminal.resize(MIN_COLS, MIN_ROWS);
  }
}

export function useAgentSession({
  paneId,
  sessionId,
  cwd,
  agentProfileId,
  isVisible,
  containerRef,
}: UseAgentSessionOptions): void {
  const registerPtyWriter = useSessionStore((state) => state.registerPtyWriter);
  const unregisterPtyWriter = useSessionStore(
    (state) => state.unregisterPtyWriter,
  );
  const updatePaneStatus = useSessionStore((state) => state.updatePaneStatus);
  const restartKey = useSessionStore(
    (state) => state.paneRestartKeys[paneId] ?? 0,
  );

  const paneIdRef = useRef(paneId);
  paneIdRef.current = paneId;

  const fitRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    let disposed = false;

    const terminal = new Terminal(createTerminalOptions());
    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);
    terminal.open(container);

    const listeners: IDisposable[] = [];
    let bridge: ReturnType<typeof createPtyBridge> | null = null;
    let compositionGuardCleanup: (() => void) | null = null;

    fitRef.current = () => {
      if (disposed || !bridge) {
        fitTerminal(fitAddon, terminal);
        return;
      }

      fitTerminal(fitAddon, terminal);
      if (terminal.cols > 0 && terminal.rows > 0) {
        bridge.pty.resize(terminal.cols, terminal.rows);
      }
    };

    const bootstrap = () => {
      if (disposed) {
        return;
      }

      fitTerminal(fitAddon, terminal);

      try {
        const profile = getAgentProfile(agentProfileId);
        bridge = createPtyBridge({
          profile,
          cwd,
          cols: terminal.cols,
          rows: terminal.rows,
        });

        compositionGuardCleanup?.();
        compositionGuardCleanup = attachOrphanCompositionEndGuard(
          container,
          (data) => {
            bridge?.write(data);
          },
        );

        listeners.push(
          attachPtyDataListener(bridge.pty, (data) => {
            terminal.write(data);
          }),
          attachPtyExitListener(bridge.pty, (exitCode) => {
            if (paneIdRef.current === paneId) {
              terminal.writeln("");
              terminal.writeln(
                `[Processo encerrado com código ${exitCode}]`,
              );
              updatePaneStatus(paneId, "exited");
            }
          }),
          terminal.onData((data) => {
            bridge?.write(data);
          }),
          terminal.onResize(({ cols, rows }) => {
            if (cols > 0 && rows > 0) {
              bridge?.pty.resize(cols, rows);
            }
          }),
        );

        registerPtyWriter(paneId, (data) => {
          bridge?.write(data);
        });

        updatePaneStatus(paneId, "running");
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Falha ao iniciar o PTY";
        terminal.writeln(`\r\n[Erro] ${message}\r\n`);
        updatePaneStatus(paneId, "exited");
      }
    };

    requestAnimationFrame(() => {
      requestAnimationFrame(bootstrap);
    });

    const resizeObserver = new ResizeObserver(() => {
      fitRef.current?.();
    });
    resizeObserver.observe(container);

    const focusTerminal = () => {
      terminal.focus();
    };
    container.addEventListener("mousedown", focusTerminal);

    return () => {
      disposed = true;
      fitRef.current = null;
      container.removeEventListener("mousedown", focusTerminal);
      resizeObserver.disconnect();
      compositionGuardCleanup?.();
      compositionGuardCleanup = null;
      listeners.forEach((listener) => listener.dispose());
      unregisterPtyWriter(paneId);
      bridge?.dispose();
      terminal.dispose();
    };
  }, [
    agentProfileId,
    containerRef,
    cwd,
    paneId,
    registerPtyWriter,
    restartKey,
    sessionId,
    unregisterPtyWriter,
    updatePaneStatus,
  ]);

  useEffect(() => {
    if (!isVisible) {
      return;
    }

    requestAnimationFrame(() => {
      fitRef.current?.();
    });
  }, [isVisible]);
}
