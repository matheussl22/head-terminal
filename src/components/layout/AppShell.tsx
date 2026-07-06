import { useCallback, useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { clearAgentSession } from "../../actions/clearAgentSession";
import {
  CLEAR_SHORTCUT,
  HARD_CLEAR_SHORTCUT,
} from "../../config/toolbar";
import { countWorkingSessions } from "../../core/activity-utils";
import type { AgentSession } from "../../types/session";
import { checkpoint } from "../../core/logger";
import {
  flushPersistedWorkspace,
  workspaceFromStore,
} from "../../core/session-persistence";
import { useSessionStore } from "../../core/session-manager";
import { getTerminal } from "../../core/terminal-registry";
import {
  useActivityNotifications,
  useKeyboardShortcuts,
  useRenameRequest,
} from "../../hooks/useAppShortcuts";
import { useGitContextWatchers } from "../../hooks/useGitContext";
import { DevMetricsOverlay } from "../dev/DevMetricsOverlay";
import { AgentToolbar } from "./AgentToolbar";
import { CommandPalette } from "./CommandPalette";
import { SessionSidebar } from "./SessionSidebar";
import { SessionWorkspace } from "./SessionWorkspace";
import { SettingsDialog } from "./SettingsDialog";

interface AppShellProps {
  sessions: AgentSession[];
  activeSessionId: string | null;
  onCreateSession: () => void;
}

function matchesShortcut(event: KeyboardEvent, shortcut: string): boolean {
  const parts = shortcut.split("+").map((part) => part.trim().toLowerCase());
  const key = parts[parts.length - 1];
  const needsCtrl = parts.includes("ctrl");
  const needsShift = parts.includes("shift");
  const needsAlt = parts.includes("alt") || parts.includes("option");
  const needsMeta = parts.includes("cmd") || parts.includes("meta");

  return (
    event.key.toLowerCase() === key &&
    event.ctrlKey === needsCtrl &&
    event.shiftKey === needsShift &&
    event.altKey === needsAlt &&
    event.metaKey === needsMeta
  );
}

export function AppShell({
  sessions,
  activeSessionId,
  onCreateSession,
}: AppShellProps) {
  const spawnedSessionIds = useSessionStore((state) => state.spawnedSessionIds);
  const workingCount = useSessionStore((state) =>
    countWorkingSessions(state.sessions, state.paneRuntime),
  );
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

  useEffect(() => {
    const base = import.meta.env.DEV ? "Head Terminal (Dev)" : "Head Terminal";
    const title =
      workingCount > 0 ? `● ${workingCount} executando — ${base}` : base;
    void getCurrentWindow().setTitle(title);
  }, [workingCount]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void getCurrentWindow()
      .onCloseRequested((event) => {
        const state = useSessionStore.getState();
        const working = countWorkingSessions(state.sessions, state.paneRuntime);
        if (working > 0) {
          const ok = window.confirm(
            `${working} agent(s) ainda executando. Fechar mesmo assim?`,
          );
          if (!ok) {
            event.preventDefault();
            return;
          }
        }
        flushPersistedWorkspace(workspaceFromStore(state));
      })
      .then((fn) => {
        unlisten = fn;
      });
    return () => {
      unlisten?.();
    };
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
      <DevMetricsOverlay />
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
