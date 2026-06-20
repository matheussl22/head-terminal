import { useEffect, useRef } from "react";
import type { IDisposable } from "tauri-pty";

import { getAgentProfile } from "../config/agents";
import { ActivityDetector } from "../core/activity-detector";
import { checkpoint, logError, logEvent } from "../core/logger";
import { notifyUiReady } from "../core/startup-watchdog";
import { dirname } from "../core/git-context-utils";
import {
  fetchGitContext,
  fetchGitContextForPath,
  startGitWatch,
  stopGitWatch,
} from "../core/git-watch-bridge";
import {
  fitPanes,
  registerPaneFitter,
  unregisterPaneFitter,
} from "../core/pane-fit-registry";
import {
  attachPtyDataListener,
  attachPtyExitListener,
  createPtyBridge,
} from "../core/pty-bridge";
import { PtyOutputBuffer } from "../core/pty-output-buffer";
import { useSessionStore } from "../core/session-manager";
import {
  createConfiguredTerminal,
  createRafPtyWriter,
  fitTerminal,
} from "../core/terminal-factory";
import { attachOrphanCompositionEndGuard } from "../core/terminal-composition-guard";
import { WorkspaceDetector } from "../core/workspace-detector";

interface UseAgentSessionOptions {
  paneId: string;
  sessionId: string;
  cwd: string;
  agentProfileId: string;
  isVisible: boolean;
  shouldSpawn: boolean;
  containerRef: React.RefObject<HTMLDivElement | null>;
}

export function useAgentSession({
  paneId,
  sessionId,
  cwd,
  agentProfileId,
  isVisible,
  shouldSpawn,
  containerRef,
}: UseAgentSessionOptions): void {
  const registerPtyWriter = useSessionStore((state) => state.registerPtyWriter);
  const unregisterPtyWriter = useSessionStore(
    (state) => state.unregisterPtyWriter,
  );
  const updatePaneStatus = useSessionStore((state) => state.updatePaneStatus);
  const updatePaneActivity = useSessionStore((state) => state.updatePaneActivity);
  const mergePaneGitContext = useSessionStore(
    (state) => state.mergePaneGitContext,
  );
  const setPaneGitContext = useSessionStore((state) => state.setPaneGitContext);
  const restartKey = useSessionStore(
    (state) => state.paneRestartKeys[paneId] ?? 0,
  );

  const paneIdRef = useRef(paneId);
  paneIdRef.current = paneId;

  const isVisibleRef = useRef(isVisible);
  isVisibleRef.current = isVisible;

  const outputBufferRef = useRef(new PtyOutputBuffer());
  const flushBufferedRef = useRef<(() => void) | null>(null);
    const pathDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const watchedRepoRef = useRef<string | null>(null);

    const syncPaneGitWatch = (watchCwd: string) => {
      const normalized = watchCwd.trim();
      if (!normalized || watchedRepoRef.current === normalized) {
        return;
      }

      watchedRepoRef.current = normalized;
      void startGitWatch(paneId, normalized).catch(() => undefined);
    };

    const refreshPaneGitContext = (lookupPath: string, touchedPath?: string) => {
      const current = useSessionStore.getState().paneGitContext[paneId];
      void fetchGitContextForPath(lookupPath, current).then((context) => {
        mergePaneGitContext(paneId, {
          ...context,
          lastTouchedPath: touchedPath ?? context.lastTouchedPath,
          lastTouchedAt: Date.now(),
        });
        syncPaneGitWatch(context.repoRoot ?? lookupPath);
      });
    };

  useEffect(() => {
    if (!shouldSpawn) {
      return;
    }

    const container = containerRef.current;
    if (!container) {
      return;
    }

    let disposed = false;
    let loggedFirstByte = false;
    let loggedFitOk = false;

    const { terminal, fitAddon } = createConfiguredTerminal();
    terminal.open(container);
    checkpoint("js.terminal.dom_opened", { paneId, sessionId });

    const listeners: IDisposable[] = [];
    let bridge: ReturnType<typeof createPtyBridge> | null = null;
    let compositionGuardCleanup: (() => void) | null = null;

    const activityDetector = new ActivityDetector((activity) => {
      if (paneIdRef.current === paneId) {
        updatePaneActivity(paneId, activity);
      }
    });

    const workspaceDetector = new WorkspaceDetector((path) => {
      if (pathDebounceRef.current) {
        clearTimeout(pathDebounceRef.current);
      }

      pathDebounceRef.current = setTimeout(() => {
        const lookupPath = path.startsWith("/") ? dirname(path) : cwd;
        refreshPaneGitContext(lookupPath, path.startsWith("/") ? path : undefined);
      }, 400);
    });

    activityDetector.onStarting();
    updatePaneActivity(paneId, "starting");

    void fetchGitContext(cwd).then((context) => {
      if (disposed) {
        return;
      }

      setPaneGitContext(paneId, context);
      syncPaneGitWatch(context.repoRoot ?? cwd);
    });

    const flushBufferedOutput = () => {
      for (const chunk of outputBufferRef.current.drain()) {
        terminal.write(chunk);
      }
    };
    flushBufferedRef.current = flushBufferedOutput;

    const fitPane = () => {
      if (disposed) {
        return;
      }

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

      if (bridge && terminal.cols > 0 && terminal.rows > 0) {
        bridge.pty.resize(terminal.cols, terminal.rows);
      }
    };

    registerPaneFitter(paneId, fitPane);

    const bootstrap = () => {
      if (disposed) {
        return;
      }

      fitPane();
      checkpoint("js.pty.spawn_begin", { paneId, sessionId, cwd });

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

        const writePtyData = createRafPtyWriter(
          terminal,
          () => !isVisibleRef.current,
          (data) => outputBufferRef.current.push(data),
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
            activityDetector.onData(data);
            workspaceDetector.onData(data);
          }),
          attachPtyExitListener(bridge.pty, (exitCode) => {
            if (paneIdRef.current === paneId) {
              terminal.writeln("");
              terminal.writeln(
                `[Processo encerrado com código ${exitCode}]`,
              );
              updatePaneStatus(paneId, "exited");
              activityDetector.onExit(exitCode);
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

        if (isVisibleRef.current) {
          flushBufferedOutput();
        }

        checkpoint("js.pty.spawn_ok", { paneId, sessionId });
        updatePaneStatus(paneId, "running");
        activityDetector.onRunning();
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
      requestAnimationFrame(bootstrap);
    });

    const focusTerminal = () => {
      terminal.focus();
    };
    container.addEventListener("mousedown", focusTerminal);

    return () => {
      disposed = true;
      if (pathDebounceRef.current) {
        clearTimeout(pathDebounceRef.current);
        pathDebounceRef.current = null;
      }
      watchedRepoRef.current = null;
      void stopGitWatch(paneId).catch(() => undefined);
      flushBufferedRef.current = null;
      container.removeEventListener("mousedown", focusTerminal);
      compositionGuardCleanup?.();
      compositionGuardCleanup = null;
      activityDetector.dispose();
      listeners.forEach((listener) => listener.dispose());
      unregisterPaneFitter(paneId);
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
    shouldSpawn,
    unregisterPtyWriter,
    mergePaneGitContext,
    setPaneGitContext,
    updatePaneActivity,
    updatePaneStatus,
  ]);

  useEffect(() => {
    if (!shouldSpawn || !isVisible) {
      return;
    }

    requestAnimationFrame(() => {
      fitPanes([paneId]);
      flushBufferedRef.current?.();
    });
  }, [isVisible, paneId, shouldSpawn]);
}
