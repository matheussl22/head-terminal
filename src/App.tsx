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
import { checkpoint, logError } from "./core/logger";
import { prewarmOpenAiApiKey } from "./core/voice-input";
import {
  applyMigratedPreferences,
  loadRunEverything,
} from "./core/ui-preferences";

import "./styles/global.css";

function App() {
  const sessions = useSessionStore((state) => state.sessions);
  const activeSessionId = useSessionStore((state) => state.activeSessionId);
  const addSession = useSessionStore((state) => state.addSession);
  const hydrateWorkspaceState = useSessionStore((state) => state.hydrateWorkspace);
  const setRunEverything = useSessionStore((state) => state.setRunEverything);
  const [bootstrapped, setBootstrapped] = useState(false);
  const [defaultCwd, setDefaultCwd] = useState<string | null>(null);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
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
        if (persisted && persisted.sessions.length > 0) {
          const restored = hydrateWorkspace(persisted);
          hydrateWorkspaceState(
            restored.sessions,
            restored.activeSessionId,
            restored.activePaneId,
            restored.paneResumeSessionIds,
            restored.conversationLabels,
          );
          checkpoint("js.bootstrap.workspace_ok", {
            sessionCount: restored.sessions.length,
            activeSessionId: restored.activeSessionId,
            activePaneId: restored.activePaneId,
          });
        } else {
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
            : "Falha ao iniciar o Head Terminal";
        setBootstrapError(message);
        setBootstrapped(true);
      }
    }

    void bootstrap();

    return () => {
      cancelled = true;
    };
  }, [addSession, hydrateWorkspaceState, setRunEverything]);

  const handleCreateSession = useCallback(() => {
    setCreateOpen(true);
  }, []);

  const handleCreateConfirm = useCallback(
    (
      cwd: string,
      agentProfileId: string,
      extras?: {
        claudeAccountId?: string;
        ollamaModel?: string;
        ollamaThinkOff?: boolean;
        ggufPath?: string;
      },
    ) => {
      const title = nextAgentSessionTitle(agentProfileId, sessions);
      addSession(
        createInitialSession(
          cwd,
          title,
          agentProfileId,
          extras,
        ),
      );
    },
    [addSession, sessions],
  );

  if (!bootstrapped) {
    return (
      <BootScreen
        slow={bootSlow}
        showDiagnosticActions={showDiagnosticActions}
      />
    );
  }

  if (bootstrapError || sessions.length === 0 || !defaultCwd) {
    return (
      <BootScreen
        error={bootstrapError ?? "Não foi possível carregar as sessões."}
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
        defaultCwd={defaultCwd}
        onClose={() => setCreateOpen(false)}
        onCreate={handleCreateConfirm}
      />
    </>
  );
}

export default App;
