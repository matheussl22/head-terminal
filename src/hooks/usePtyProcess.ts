import { useEffect } from "react";
import type { IDisposable } from "tauri-pty";

import { AGENT_FALLBACK_OSC, getAgentProfile } from "../config/agents";
import { ActivityDetector } from "../core/activity-detector";
import { checkpoint, logError, logEvent } from "../core/logger";
import { notifyUiReady } from "../core/startup-watchdog";
import { fitPanes } from "../core/pane-fit-registry";
import { paneSupervisor } from "../core/pane-supervisor";
import {
  attachPtyDataListener,
  attachPtyExitListener,
  createPtyBridge,
  type PtyBridge,
} from "../core/pty-bridge";
import type { PtyOutputBuffer } from "../core/pty-output-buffer";
import { useSessionStore } from "../core/session-manager";
import { createRafPtyWriter } from "../core/terminal-factory";
import { WorkspaceDetector } from "../core/workspace-detector";
import type { TerminalInstance } from "./useTerminalInstance";

interface UsePtyProcessOptions {
  instance: TerminalInstance | null;
  paneId: string;
  sessionId: string;
  cwd: string;
  agentProfileId: string;
  restartKey: number;
  continueConversation: boolean;
  isVisibleRef: React.RefObject<boolean>;
  outputBufferRef: React.RefObject<PtyOutputBuffer>;
  onWorkspacePath: (path: string) => void;
}

/**
 * Spawns and supervises the PTY attached to a TerminalInstance. Restarts
 * (restartKey bump) kill only the process — the terminal and its scrollback
 * survive, separated by a visual marker.
 */
export function usePtyProcess({
  instance,
  paneId,
  sessionId,
  cwd,
  agentProfileId,
  restartKey,
  continueConversation,
  isVisibleRef,
  outputBufferRef,
  onWorkspacePath,
}: UsePtyProcessOptions): void {
  const registerPtyWriter = useSessionStore((state) => state.registerPtyWriter);
  const unregisterPtyWriter = useSessionStore(
    (state) => state.unregisterPtyWriter,
  );
  const updatePaneStatus = useSessionStore((state) => state.updatePaneStatus);
  const updatePaneActivity = useSessionStore(
    (state) => state.updatePaneActivity,
  );
  const notePaneOutput = useSessionStore((state) => state.notePaneOutput);

  useEffect(() => {
    if (!instance) {
      return;
    }

    const { terminal } = instance;
    let disposed = false;
    let loggedFirstByte = false;
    const listeners: IDisposable[] = [];
    let bridge: PtyBridge | null = null;

    const activityDetector = new ActivityDetector((activity) => {
      updatePaneActivity(paneId, activity);
    });
    const workspaceDetector = new WorkspaceDetector(onWorkspacePath);

    activityDetector.onStarting();
    updatePaneActivity(paneId, "starting");

    // Sentinel emitted by the profile args right before the shell fallback
    // replaces a dead agent (§2.3) — without it the fallback is invisible.
    const oscHandler = terminal.parser.registerOscHandler(
      AGENT_FALLBACK_OSC,
      (payload) => {
        const exitCode = Number(payload.split(":")[1] ?? "0");
        logEvent("warn", "agent.fallback", { paneId, sessionId, exitCode });
        activityDetector.onAgentFallback();
        return true;
      },
    );

    const flushBufferedOutput = () => {
      for (const chunk of outputBufferRef.current.drain()) {
        terminal.write(chunk);
      }
    };

    const bootstrap = () => {
      if (disposed) {
        return;
      }

      checkpoint("js.pty.spawn_begin", {
        paneId,
        sessionId,
        cwd,
        continueConversation,
      });

      try {
        const profile = getAgentProfile(agentProfileId, {
          continueConversation,
        });
        bridge = createPtyBridge({
          profile,
          cwd,
          cols: terminal.cols,
          rows: terminal.rows,
        });

        if (instance.spawnCount.current > 0) {
          const attempt = instance.spawnCount.current + 1;
          terminal.writeln("");
          terminal.writeln(
            `\x1b[2m── sessão reiniciada (tentativa ${attempt}) ─────────────────\x1b[0m`,
          );
        }
        instance.spawnCount.current += 1;

        const writePtyData = createRafPtyWriter(
          terminal,
          () => !isVisibleRef.current,
          (data) => outputBufferRef.current.push(data),
          (frameText) => {
            activityDetector.onData(frameText);
            workspaceDetector.onData(frameText);
            notePaneOutput(paneId);
          },
        );

        listeners.push(
          attachPtyDataListener(bridge.pty, (data) => {
            if (!loggedFirstByte && data.byteLength > 0) {
              loggedFirstByte = true;
              checkpoint("js.pty.first_byte", {
                paneId,
                bytes: data.byteLength,
              });
              notifyUiReady();
            }
            writePtyData(data);
          }),
          attachPtyExitListener(bridge.pty, (exitCode) => {
            terminal.writeln("");
            terminal.writeln(`[Processo encerrado com código ${exitCode}]`);
            updatePaneStatus(paneId, "exited");
            activityDetector.onExit(exitCode);
            // Dead PTYs must not swallow toolbar commands (§2.4).
            unregisterPtyWriter(paneId);
            instance.writeToPty.current = null;
            instance.resizePty.current = null;
            paneSupervisor.noteExit(paneId);
          }),
        );

        instance.writeToPty.current = (data) => {
          bridge?.write(data);
        };
        instance.resizePty.current = (cols, rows) => {
          bridge?.pty.resize(cols, rows);
        };
        registerPtyWriter(paneId, (data) => {
          bridge?.write(data);
        });

        if (isVisibleRef.current) {
          flushBufferedOutput();
        }

        checkpoint("js.pty.spawn_ok", { paneId, sessionId });
        updatePaneStatus(paneId, "running");
        activityDetector.onRunning();
        paneSupervisor.noteSpawned(paneId);
      } catch (error) {
        logError("js.pty.spawn_failed", error, { paneId, sessionId });
        const message =
          error instanceof Error ? error.message : "Falha ao iniciar o PTY";
        terminal.writeln(`\r\n[Erro] ${message}\r\n`);
        updatePaneStatus(paneId, "exited");
        activityDetector.onError();
      }
    };

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!disposed) {
          // Fit before spawning so the PTY starts with real dimensions.
          fitPanes([paneId]);
          bootstrap();
        }
      });
    });

    return () => {
      disposed = true;
      oscHandler.dispose();
      activityDetector.dispose();
      listeners.forEach((listener) => listener.dispose());
      unregisterPtyWriter(paneId);
      instance.writeToPty.current = null;
      instance.resizePty.current = null;
      bridge?.dispose();
    };
  }, [
    agentProfileId,
    continueConversation,
    cwd,
    instance,
    isVisibleRef,
    notePaneOutput,
    onWorkspacePath,
    outputBufferRef,
    paneId,
    registerPtyWriter,
    restartKey,
    sessionId,
    unregisterPtyWriter,
    updatePaneActivity,
    updatePaneStatus,
  ]);

  // Pane left the layout entirely — drop supervisor bookkeeping.
  useEffect(() => {
    return () => {
      paneSupervisor.forget(paneId);
    };
  }, [paneId]);
}
