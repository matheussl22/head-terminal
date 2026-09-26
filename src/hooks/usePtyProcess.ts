import { useEffect, useRef } from "react";

import {
  AGENT_FALLBACK_OSC,
  AGENT_RESUME_FALLBACK_OSC,
  getAgentProfile,
} from "../config/agents";
import { ActivityDetector } from "../core/activity-detector";
import {
  classifyClaudeScreen,
  classifyTitle,
  isTerminalReply,
} from "../core/activity-signals";
import {
  getClaudeHookSettingsPath,
  subscribeAgentHookEvents,
} from "../core/agent-hooks-bridge";
import { ContextMeter } from "../core/context-meter";
import { ClaudeFolderTrustAutoAccept } from "../core/claude-folder-trust";
import { resolveClaudeConfigDir } from "../core/claude-accounts";
import {
  anchorPaneResumeSession,
  anchorPaneToHookSession,
  PaneForegroundSession,
  snapshotExistingSessionIds,
} from "../core/pane-resume-anchor";
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
import { SpawnScreenReader } from "../core/terminal-screen";
import { WorkspaceDetector } from "../core/workspace-detector";
import type { PaneActivity } from "../types/activity";
import type { TerminalInstance } from "./useTerminalInstance";

/** A Claude pane never waits longer than this on the hook server: without
 * its settings the pane still spawns and reads Claude's title and screen. */
const HOOK_SETTINGS_WAIT_MS = 1500;

function claudeHookSettingsWithin(paneId: string, ms: number): Promise<string | undefined> {
  return Promise.race([
    getClaudeHookSettingsPath(paneId),
    new Promise<undefined>((resolve) => {
      setTimeout(() => resolve(undefined), ms);
    }),
  ]);
}

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
  wslDistro?: string;
  restartKey: number;
  continueConversation: boolean;
  resumeSessionId?: string;
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
  wslDistro,
  restartKey,
  continueConversation,
  resumeSessionId,
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
  const markPaneSeen = useSessionStore((state) => state.markPaneSeen);
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
    // What this spawn's process drew — not what a previous one left on the
    // screen of this reused xterm (see SpawnScreenReader).
    const spawnScreen = new SpawnScreenReader(terminal);
    const readScreen = spawnScreen.read;

    let lastActivity: PaneActivity = "starting";
    const activityDetector = new ActivityDetector({
      agentProfileId,
      readScreen,
      onChange: (activity, blocked, meta) => {
        // A restart may already have reset the pane for the next process.
        if (disposed) {
          return;
        }
        logEvent("info", "pane.activity", {
          paneId,
          from: lastActivity,
          to: activity,
          source: meta.source,
          reason: blocked?.reason,
          detail: blocked?.detail,
          agentExitCode: meta.agentExitCode,
        });
        lastActivity = activity;
        updatePaneActivity(paneId, activity, blocked, {
          agentExitCode: meta.agentExitCode,
        });
      },
    });
    // Keys the folder-trust auto-accept sends are the app's, not the user's:
    // they go straight to the pty, past the input tracking below. It stands
    // down for good once Claude's REPL is on screen, its first status title
    // arrives, or its startup window is over. Hooks do not stop it: a
    // background session dispatched from this pane reports through the same
    // settings file, while this spawn may still be showing the dialog.
    const folderTrust =
      agentProfileId === "claude"
        ? new ClaudeFolderTrustAutoAccept({
            readScreen,
            send: (keys) => {
              if (!disposed) {
                bridge?.write(keys);
              }
            },
            isAgentUp: (screen) => {
              const state = classifyClaudeScreen(screen).state;
              return state === "idle" || state === "working";
            },
            onAccepted: () => {
              logEvent("info", "claude.folder_trust_auto_accepted", {
                paneId,
                sessionId,
              });
            },
            onGaveUp: () => {
              logEvent("warn", "claude.folder_trust_auto_accept_gave_up", {
                paneId,
                sessionId,
              });
            },
          })
        : null;
    const workspaceDetector = new WorkspaceDetector(onWorkspacePath);
    const contextMeter = new ContextMeter((percent) => {
      updatePaneContext(paneId, percent);
    });

    // A fresh process starts with nothing pending: whatever the previous one
    // left (a dialog, an unseen finished turn) must not linger.
    activityDetector.onStarting();
    updatePaneActivity(paneId, "starting");

    // Sentinel emitted by the profile args right before the shell fallback
    // replaces a dead agent (§2.3) — without it the fallback is invisible.
    const oscHandler = terminal.parser.registerOscHandler(
      AGENT_FALLBACK_OSC,
      (payload) => {
        const exitCode = Number(payload.split(":")[1] ?? "0");
        logEvent("warn", "agent.fallback", { paneId, sessionId, exitCode });
        activityDetector.onAgentFallback(Number.isFinite(exitCode) ? exitCode : 1);
        return true;
      },
    );

    // The agents' own status line: Claude's ◐/✳, codex's spinner and
    // "Action Required", cursor's status indicators.
    const titleListener = terminal.onTitleChange((title) => {
      if (disposed) {
        return;
      }
      activityDetector.onTitle(title);
      // Claude only sets a status title once the trust dialog is behind it.
      // Only this spawn's titles count: until its pty is up, a title can
      // only be the previous process's, still draining through xterm.
      if (folderTrust && bridge && classifyTitle(title)?.family === "claude") {
        folderTrust.stop();
      }
    });

    // A session sent to the background from this pane keeps reporting
    // through this pane's settings file: only the conversation in the pane's
    // foreground speaks for it, as learned from the prompt the pane itself
    // submitted — and learned again whenever it changes in place (/clear
    // and friends). That is also the pane's conversation for good: its
    // resume anchor, which no sibling pane's transcript poll may take.
    const foregroundSession = new PaneForegroundSession((conversationId) => {
      if (disposed) {
        return;
      }
      logEvent("info", "claude.foreground_session", {
        paneId,
        sessionId,
        conversationId,
      });
      void anchorPaneToHookSession({
        paneId,
        sessionId: conversationId,
        cwd,
        agentProfileId,
        claudeAccountId,
        isDisposed: () => disposed,
      });
    });
    const unsubscribeHooks =
      agentProfileId === "claude"
        ? subscribeAgentHookEvents(paneId, (event) => {
            if (!disposed && foregroundSession.accepts(event)) {
              activityDetector.onHookEvent(event);
            }
          })
        : null;

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
        // A Claude pane always runs on one of the app's own profile dirs —
        // a session without an account id is on the default profile, never
        // on the user's global ~/.claude (see claude-accounts.ts).
        const claudeConfigDir =
          agentProfileId === "claude"
            ? resolveClaudeConfigDir(claudeAccountId)
            : undefined;
        // The hooks that let Claude report its own state (see
        // agent-hook-server.ts): this pane's own settings file, with its id
        // written in it. Without them the pane still reads Claude's title
        // and screen.
        const claudeSettingsPath =
          agentProfileId === "claude"
            ? await claudeHookSettingsWithin(paneId, HOOK_SETTINGS_WAIT_MS)
            : undefined;
        if (disposed) {
          return;
        }
        const profile = getAgentProfile(agentProfileId, {
          continueConversation,
          resumeSessionId,
          ollamaModel,
          ollamaThinkOff,
          ggufPath,
          claudeConfigDir,
          claudeSettingsPath,
          wslDistro,
        });
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
        const env: Record<string, string> = {};
        if (claudeConfigDir) {
          env.CLAUDE_CONFIG_DIR = claudeConfigDir;
        }
        const nextBridge = await createPtyBridge({
          profile,
          cwd,
          cols: terminal.cols,
          rows: terminal.rows,
          env,
        });

        if (disposed) {
          await nextBridge.dispose();
          return;
        }
        bridge = nextBridge;

        if (instance.spawnCount.current > 0) {
          // The previous process's screen stays up until this one paints.
          spawnScreen.holdUntilPainted();
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
            // xterm invokes this after parsing, possibly after a restart
            // already tore this effect down and reset the pane's runtime to
            // "starting": a stale detector must not overwrite the new one.
            if (disposed) {
              return;
            }
            spawnScreen.noteFrame(frameText);
            activityDetector.onFrame();
            workspaceDetector.onData(frameText);
            contextMeter.onData(frameText);
            folderTrust?.check();
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

        // Everything written on the user's behalf — keys, paste, voice,
        // toolbar commands — passes through here: Enter may start a shell
        // command or answer a dialog, and typing into a pane is looking at it.
        // Replies xterm sends for the terminal (cursor reports and the like)
        // are neither.
        const writeUserInput = (data: string) => {
          bridge?.write(data);
          if (disposed || isTerminalReply(data)) {
            return;
          }
          activityDetector.onUserInput(data);
          foregroundSession.noteUserInput(data);
          markPaneSeen(paneId);
        };
        instance.writeToPty.current = writeUserInput;
        instance.resizePty.current = (cols, rows) => {
          bridge?.pty.resize(cols, rows);
        };
        registerPtyWriter(paneId, writeUserInput);

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
      titleListener.dispose();
      unsubscribeHooks?.();
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
    wslDistro,
    continueConversation,
    resumeSessionId,
    cwd,
    instance,
    markPaneSeen,
    onWorkspacePath,
    paneId,
    registerPtyWriter,
    restartKey,
    sessionId,
    unregisterPtyWriter,
    updatePaneActivity,
    updatePaneContext,
    updatePaneStatus,
  ]);

  // Pane left the layout entirely — drop supervisor bookkeeping.
  useEffect(() => {
    return () => {
      paneSupervisor.forget(paneId);
    };
  }, [paneId]);
}
