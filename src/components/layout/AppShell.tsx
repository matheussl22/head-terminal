import { useCallback, useEffect, useState } from "react";

import { clearAgentSession } from "../../actions/clearAgentSession";
import {
  CLEAR_SHORTCUT,
  HARD_CLEAR_SHORTCUT,
} from "../../config/toolbar";
import {
  countTerminalStatuses,
  formatCloseWarning,
  formatWindowTitle,
} from "../../core/activity-utils";
import type { AgentSession } from "../../types/session";
import { checkpoint } from "../../core/logger";
import {
  flushPersistedWorkspace,
  workspaceFromStore,
} from "../../core/session-persistence";
import { useSessionStore } from "../../core/session-manager";
import { matchesShortcut } from "../../core/shortcuts";
import { getTerminal } from "../../core/terminal-registry";
import {
  useActivityNotifications,
  useKeyboardShortcuts,
  useRenameRequest,
} from "../../hooks/useAppShortcuts";
import { useGitContextWatchers } from "../../hooks/useGitContext";
import { AgentToolbar } from "./AgentToolbar";
import { CommandPalette } from "./CommandPalette";
import { SessionSidebar } from "./SessionSidebar";
import { SessionWorkspace } from "./SessionWorkspace";
import { SettingsDialog } from "./SettingsDialog";
import { useTerminalStatusCounts } from "../ui/StatusDot";

interface AppShellProps {
  sessions: AgentSession[];
  activeSessionId: string | null;
  onCreateSession: () => void;
}

export function AppShell({
  sessions,
  activeSessionId,
  onCreateSession,
}: AppShellProps) {
  const spawnedSessionIds = useSessionStore((state) => state.spawnedSessionIds);
  // By terminal, like the toolbar chips: two agents running in one session
  // are two, not one.
  const statusCounts = useTerminalStatusCounts();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searchPaneId, setSearchPaneId] = useState<string | null>(null);
  const { renameSessionId, requestRename, clearRenameRequest } =
    useRenameRequest();

  useActivityNotifications();
  useGitContextWatchers(sessions);

  // Trocar de sessão/pane leva o foco do teclado direto ao terminal ativo —
  // sem isso, digitar após selecionar na sidebar ia para o void.
  const activePaneId = useSessionStore((state) => state.activePaneId);
  useEffect(() => {
    if (activePaneId) {
      getTerminal(activePaneId)?.terminal.focus();
    }
  }, [activePaneId]);

  useEffect(() => {
    checkpoint("js.app_shell.visible", {
      sessionCount: sessions.length,
      activeSessionId,
    });
  }, [activeSessionId, sessions.length]);

  useKeyboardShortcuts({
    onCreateSession,
    onCommandPalette: () => setPaletteOpen(true),
    onRenameSession: () => {
      if (activeSessionId) {
        requestRename(activeSessionId);
      }
    },
    onSearch: () => {
      const paneId = useSessionStore.getState().activePaneId;
      if (paneId) {
        setSearchPaneId(paneId);
      }
    },
    onCloseSearch: () => setSearchPaneId(null),
  });

  const windowTitle = formatWindowTitle(
    import.meta.env.DEV ? "Head Terminal (Dev)" : "Head Terminal",
    statusCounts,
  );
  useEffect(() => {
    void window.headTerminal.app.setTitle(windowTitle);
  }, [windowTitle]);

  useEffect(() => {
    const unlisten = window.headTerminal.app.onCloseRequested(() => {
      void (async () => {
        const state = useSessionStore.getState();
        // A terminal waiting on an approval is a turn stopped half-way:
        // closing kills it as surely as one still running.
        const warning = formatCloseWarning(
          countTerminalStatuses(state.sessions, state.paneRuntime, state.spawnedSessionIds),
        );
        if (warning) {
          const ok = await window.headTerminal.system.confirm({
            title: "Fechar Head Terminal",
            message: warning,
            detail: "Fechar mesmo assim? Os processos em execução serão encerrados.",
            confirmLabel: "Fechar",
            cancelLabel: "Cancelar",
          });
          if (!ok) {
            window.headTerminal.app.respondToClose(false);
            return;
          }
        }
        try {
          await flushPersistedWorkspace(workspaceFromStore(state));
        } catch (error) {
          checkpoint("js.workspace.flush_failed", {
            message: error instanceof Error ? error.message : String(error),
          });
          const closeWithoutSaving = await window.headTerminal.system.confirm({
            title: "Falha ao salvar workspace",
            message: "Não foi possível persistir o estado mais recente.",
            detail: "Deseja fechar mesmo assim?",
            confirmLabel: "Fechar sem salvar",
            cancelLabel: "Cancelar",
          });
          if (!closeWithoutSaving) {
            window.headTerminal.app.respondToClose(false);
            return;
          }
        }
        window.headTerminal.app.respondToClose(true);
      })();
    });
    return unlisten;
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (matchesShortcut(event, HARD_CLEAR_SHORTCUT)) {
        event.preventDefault();
        clearAgentSession("hard");
        return;
      }

      if (matchesShortcut(event, CLEAR_SHORTCUT)) {
        event.preventDefault();
        clearAgentSession("soft");
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const handleRenameRequest = useCallback(() => {
    if (activeSessionId) {
      requestRename(activeSessionId);
    }
    setPaletteOpen(false);
  }, [activeSessionId, requestRename]);

  return (
    <div className="app-shell">
      <AgentToolbar
        onOpenCommandPalette={() => setPaletteOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <div className="app-shell__body">
        <SessionSidebar
          sessions={sessions}
          onCreateSession={onCreateSession}
          renameSessionId={renameSessionId}
          onRenameComplete={clearRenameRequest}
          onRenameRequest={requestRename}
        />
        <main className="app-shell__main">
          {sessions.map((session) => (
            <SessionWorkspace
              key={session.id}
              session={session}
              isVisible={session.id === activeSessionId}
              shouldSpawn={Boolean(spawnedSessionIds[session.id])}
              searchPaneId={searchPaneId}
              onCloseSearch={() => setSearchPaneId(null)}
            />
          ))}
        </main>
      </div>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onRenameRequest={handleRenameRequest}
        onSettingsRequest={() => {
          setPaletteOpen(false);
          setSettingsOpen(true);
        }}
      />

      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
