import { useEffect, useRef } from "react";

import {
  AGENT_FALLBACK_OSC,
  AGENT_RESUME_FALLBACK_OSC,
  getAgentProfile,
} from "../config/agents";
import { ActivityDetector } from "../core/activity-detector";
import { ContextMeter } from "../core/context-meter";
import {
  CLAUDE_FOLDER_TRUST_CONFIRM_KEY,
  ClaudeFolderTrustAutoAccept,
} from "../core/claude-folder-trust";
import { resolveClaudeConfigDir } from "../core/claude-accounts";
import { anchorPaneResumeSession, snapshotExistingSessionIds } from "../core/pane-resume-anchor";
import { isResumableAgent } from "../core/agent-sessions-bridge";
import { checkpoint, logError, logEvent } from "../core/logger";
import { notifyUiReady } from "../core/startup-watchdog";
import { fitPanes } from "../core/pane-fit-registry";
import { paneSupervisor } from "../core/pane-supervisor";
import {
  attachPtyDataListener,
  attachPtyExitListener,
  createPtyBridge,
  type IDisposable,
  type PtyBridge,
} from "../core/pty-bridge";
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
  claudeAccountId?: string;
  ollamaModel?: string;
  ollamaThinkOff?: boolean;
  ggufPath?: string;
  restartKey: number;
  continueConversation: boolean;
  resumeSessionId?: string;
  isVisible: boolean;
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
  claudeAccountId,
  ollamaModel,
  ollamaThinkOff,
  ggufPath,
  restartKey,
  continueConversation,
  resumeSessionId,
  isVisible,
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
  const updatePaneContext = useSessionStore(
    (state) => state.updatePaneContext,
  );
  const isVisibleRef = useRef(isVisible);
  isVisibleRef.current = isVisible;
  const previousDisposeRef = useRef(Promise.resolve<void>(undefined));

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
    const folderTrust =
      agentProfileId === "claude" ? new ClaudeFolderTrustAutoAccept() : null;
    const workspaceDetector = new WorkspaceDetector(onWorkspacePath);
    const contextMeter = new ContextMeter((percent) => {
      updatePaneContext(paneId, percent);
    });

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

    // The pane asked to resume a conversation the CLI wouldn't take, so it
    // is now on a brand new one: say so and find out which one it landed on,
    // since the id this pane was carrying is dead.
    const resumeFallbackHandler = terminal.parser.registerOscHandler(
      AGENT_RESUME_FALLBACK_OSC,
      (payload) => {
        const exitCode = Number(payload.split(":")[1] ?? "0");
        logEvent("warn", "agent.resume_fallback", {
          paneId,
          sessionId,
          resumeSessionId,
          exitCode,
        });
        terminal.writeln(
          "\x1b[2m── conversa anterior não pôde ser retomada, iniciando uma nova ──\x1b[0m",
        );
        // Until the new conversation is identified the pane has none: better
        // an honest "nova conversa" in the header than the name of the one
        // the CLI just refused, which is also what a restart would retry.
        useSessionStore.getState().clearPaneResumeAnchor(paneId);
        void anchorPaneResumeSession({
          paneId,
          cwd,
          agentProfileId,
          claudeAccountId,
          spawnStartMs: Date.now(),
          startsNewConversation: true,
          isDisposed: () => disposed,
        });
        return true;
      },
    );

    const bootstrap = async () => {
      await previousDisposeRef.current;
      if (disposed) {
        return;
      }

      checkpoint("js.pty.spawn_begin", {
        paneId,
        sessionId,
        cwd,
        continueConversation,
        resumeSessionId,
      });

      try {
        const profile = getAgentProfile(agentProfileId, {
          continueConversation,
          resumeSessionId,
          ollamaModel,
          ollamaThinkOff,
          ggufPath,
        });
        const claudeConfigDir = claudeAccountId
          ? resolveClaudeConfigDir(claudeAccountId)
          : undefined;
        const startsNewConversation =
          !continueConversation || Boolean(resumeSessionId);
        const existingSessionIds =
          isResumableAgent(agentProfileId) && startsNewConversation
            ? await snapshotExistingSessionIds(
                cwd,
                agentProfileId,
                claudeAccountId,
              )
            : undefined;
        if (disposed) {
          return;
        }

        const spawnStartMs = Date.now();
        const nextBridge = await createPtyBridge({
          profile,
          cwd,
          cols: terminal.cols,
          rows: terminal.rows,
          env: claudeConfigDir
            ? { CLAUDE_CONFIG_DIR: claudeConfigDir }
            : undefined,
        });

        if (disposed) {
          await nextBridge.dispose();
          return;
        }
        bridge = nextBridge;

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
          (frameText) => {
            activityDetector.onData(frameText);
            workspaceDetector.onData(frameText);
            contextMeter.onData(frameText);
            folderTrust?.onData(frameText, () => {
              if (disposed) {
                return;
              }
              logEvent("info", "claude.folder_trust_auto_accepted", {
                paneId,
                sessionId,
              });
              bridge?.write(CLAUDE_FOLDER_TRUST_CONFIRM_KEY);
            });
          },
          () => !isVisibleRef.current,
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
          activityDetector.onResize();
          bridge?.pty.resize(cols, rows);
        };
        registerPtyWriter(paneId, (data) => {
          bridge?.write(data);
        });

        checkpoint("js.pty.spawn_ok", { paneId, sessionId });
        updatePaneStatus(paneId, "running");
        activityDetector.onRunning();
        paneSupervisor.noteSpawned(paneId);

        // Which transcript this spawn actually landed on is never a given —
        // not even with an explicit --resume, since the CLI can replay the
        // conversation into a new file rather than append to the one it was
        // handed (see pane-resume-anchor.ts).
        void anchorPaneResumeSession({
          paneId,
          cwd,
          agentProfileId,
          claudeAccountId,
          spawnStartMs,
          startsNewConversation,
          resumedSessionId: resumeSessionId,
          existingSessionIds,
          isDisposed: () => disposed,
        });
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
          void bootstrap();
        }
      });
    });

    return () => {
      disposed = true;
      oscHandler.dispose();
      resumeFallbackHandler.dispose();
      activityDetector.dispose();
      folderTrust?.dispose();
      listeners.forEach((listener) => listener.dispose());
      unregisterPtyWriter(paneId);
      instance.writeToPty.current = null;
      instance.resizePty.current = null;
      previousDisposeRef.current = Promise.resolve(bridge?.dispose()).catch(
        () => undefined,
      );
    };
  }, [
    agentProfileId,
    claudeAccountId,
    ollamaModel,
    ollamaThinkOff,
    ggufPath,
    continueConversation,
    resumeSessionId,
    cwd,
    instance,
      onWorkspacePath,
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
