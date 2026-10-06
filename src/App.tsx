import { useCallback, useEffect, useState } from "react";

import {
  createInitialSession,
  nextAgentSessionTitle,
  resolveDefaultCwd,
} from "./core/agent-launcher";
import {
  hydrateWorkspace,
  loadPersistedWorkspace,
  savePersistedWorkspace,
} from "./core/session-persistence";
import { whenPlatformInfo } from "./core/platform-info";
import { migrateWorkspaceCwds } from "./core/workspace-migration";
import { useSessionStore } from "./core/session-manager";
import { AppShell } from "./components/layout/AppShell";
import { CreateSessionDialog } from "./components/layout/CreateSessionDialog";
import { BootScreen } from "./components/BootScreen";
import { BrainstormPanel } from "./components/brainstorm/BrainstormPanel";
import { ConfirmDialog } from "./components/ui/ConfirmDialog";
import { checkpoint, logError } from "./core/logger";
import { prewarmOpenAiApiKey } from "./core/voice-input";
import {
  applyMigratedPreferences,
  loadRunEverything,
} from "./core/ui-preferences";
import type { WorktreeRef } from "./types/session";
import { msg } from "./i18n";
import { useLocale } from "./i18n/react";

import "./styles/global.css";

function App() {
  // Re-renders everything below in place when the language switches.
  useLocale();
  const sessions = useSessionStore((state) => state.sessions);
  const activeSessionId = useSessionStore((state) => state.activeSessionId);
  const addSession = useSessionStore((state) => state.addSession);
  const hydrateWorkspaceState = useSessionStore((state) => state.hydrateWorkspace);
  const setRunEverything = useSessionStore((state) => state.setRunEverything);
  // Projects mode: an empty project is a normal screen, not a failed boot,
  // and its new sessions open in its own folder when it has one.
  const projectsEnabled = useSessionStore((state) => state.projectsEnabled);
  const hasProjects = useSessionStore((state) => state.projects.length > 0);
  /** The project a session is being created in from its header's "+";
   * otherwise it lands in the active project. */
  const [createProjectId, setCreateProjectId] = useState<string | null>(null);
  const projectCwd = useSessionStore((state) =>
    state.projectsEnabled
      ? state.projects.find(
          (project) => project.id === (createProjectId ?? state.activeProjectId),
        )?.cwd
      : undefined,
  );
  const [bootstrapped, setBootstrapped] = useState(false);
  const [defaultCwd, setDefaultCwd] = useState<string | null>(null);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  /** A folder sent from outside the app; the dialog opens there instead of
   * the default folder. */
  const [requestedCwd, setRequestedCwd] = useState<string | null>(null);
  const [bootSlow, setBootSlow] = useState(false);
  const [showDiagnosticActions, setShowDiagnosticActions] = useState(false);

  useEffect(() => {
    const slowTimer = window.setTimeout(() => setBootSlow(true), 8_000);
    const diagTimer = window.setTimeout(() => setShowDiagnosticActions(true), 15_000);
    return () => {
      window.clearTimeout(slowTimer);
      window.clearTimeout(diagTimer);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      checkpoint("js.bootstrap.begin");

      try {
        const migratedPreferences = await window.headTerminal.migration.loadPreferences();
        applyMigratedPreferences(migratedPreferences);
        setRunEverything(loadRunEverything());
        checkpoint("js.bootstrap.preferences_ok", {
          preferenceCount: Object.keys(migratedPreferences).length,
        });

        const cwd = await resolveDefaultCwd();
        if (cancelled) {
          return;
        }

        checkpoint("js.bootstrap.cwd_ok", { cwd });
        setDefaultCwd(cwd);
        setBootstrapError(null);

        const loaded = await loadPersistedWorkspace();
        const platform = await whenPlatformInfo();
        const persisted = loaded
          ? migrateWorkspaceCwds(loaded, {
              isWindows: platform?.platform === "win32",
              fallbackCwd: cwd,
            })
          : null;
        if (persisted && persisted !== loaded) {
          // Folders from the WSL era were rewritten; save once so the next
          // start does not migrate again.
          void savePersistedWorkspace(persisted).catch((error: unknown) => {
            logError("workspace.migration_save_failed", error);
          });
        }
        // Projects kept with no session left in any of them still come back.
        const hasSavedWork = Boolean(
          persisted &&
            (persisted.sessions.length > 0 || (persisted.projects?.length ?? 0) > 0),
        );
        if (persisted && hasSavedWork) {
          const restored = hydrateWorkspace(persisted);
          hydrateWorkspaceState(
            restored.sessions,
            restored.activeSessionId,
            restored.activePaneId,
            restored.paneResumeSessionIds,
            restored.conversationLabels,
            { projects: restored.projects, activeProjectId: restored.activeProjectId },
          );
          checkpoint("js.bootstrap.workspace_ok", {
            sessionCount: restored.sessions.length,
            activeSessionId: restored.activeSessionId,
            activePaneId: restored.activePaneId,
          });
        }
        const { sessions: hydrated, projectsEnabled: projectsOn } =
          useSessionStore.getState();
        if (hydrated.length === 0 && !(projectsOn && hasSavedWork)) {
          const smokeTest = document.documentElement.dataset.headTerminalSmoke === "1";
          const session = createInitialSession(
            cwd,
            undefined,
            smokeTest ? "shell" : undefined,
          );
          addSession(session);
          checkpoint("js.bootstrap.workspace_ok", {
            sessionCount: 1,
            activeSessionId: session.id,
            created: true,
          });
        }

        checkpoint("js.bootstrap.complete");
        void prewarmOpenAiApiKey();
        setBootstrapped(true);
      } catch (error) {
        if (cancelled) {
          return;
        }

        logError("bootstrap.failed", error);
        const message =
          error instanceof Error
            ? error.message
            : msg.app.bootFailed;
        setBootstrapError(message);
        setBootstrapped(true);
      }
    }

    void bootstrap();

    return () => {
      cancelled = true;
    };
  }, [addSession, hydrateWorkspaceState, setRunEverything]);

  const handleCreateSession = useCallback((projectId?: string) => {
    setCreateProjectId(projectId ?? null);
    setCreateOpen(true);
  }, []);

  // Finder's "New Head Terminal Session Here" and a folder dropped on the Dock
  // icon: the new-session dialog opens on that folder, with the agent and the
  // Claude profile it remembers, so creating the session is one confirmation.
  useEffect(() => {
    if (!bootstrapped) {
      return;
    }
    const openAt = (folder: string) => {
      setRequestedCwd(folder);
      setCreateOpen(true);
    };
    // Subscribed before asking: main sends the next folders as events.
    const unsubscribe = window.headTerminal.app.onOpenFolder(openAt);
    void window.headTerminal.app
      .takePendingFolder()
      .then((folder) => {
        if (folder) {
          openAt(folder);
        }
      })
      .catch((error: unknown) => logError("app.pending_folder_failed", error));
    return unsubscribe;
  }, [bootstrapped]);

  const handleCreateConfirm = useCallback(
    (
      cwd: string,
      agentProfileId: string,
      extras?: {
        claudeAccountId?: string;
        ollamaModel?: string;
        ollamaThinkOff?: boolean;
        ggufPath?: string;
        wslDistro?: string;
        worktree?: WorktreeRef;
      },
    ) => {
      const title = nextAgentSessionTitle(agentProfileId, sessions, extras?.wslDistro);
      const session = createInitialSession(cwd, title, agentProfileId, extras);
      addSession(createProjectId ? { ...session, projectId: createProjectId } : session);
    },
    [addSession, createProjectId, sessions],
  );

  if (!bootstrapped) {
    return (
      <BootScreen
        slow={bootSlow}
        showDiagnosticActions={showDiagnosticActions}
      />
    );
  }

  if (
    bootstrapError ||
    (sessions.length === 0 && !(projectsEnabled && hasProjects)) ||
    !defaultCwd
  ) {
    return (
      <BootScreen
        error={bootstrapError ?? msg.app.sessionsLoadFailed}
        showDiagnosticActions
      />
    );
  }

  return (
    <>
      <AppShell
        sessions={sessions}
        activeSessionId={activeSessionId}
        onCreateSession={handleCreateSession}
      />
      <CreateSessionDialog
        open={createOpen}
        defaultCwd={requestedCwd ?? projectCwd ?? defaultCwd}
        onClose={() => {
          setCreateOpen(false);
          setRequestedCwd(null);
          setCreateProjectId(null);
        }}
        onCreate={handleCreateConfirm}
      />
      <BrainstormPanel />
      <ConfirmDialog />
    </>
  );
}

export default App;
