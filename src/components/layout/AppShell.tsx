import { useCallback, useEffect, useState } from "react";

import { clearAgentSession } from "../../actions/clearAgentSession";
import {
  CLEAR_SHORTCUT,
  HARD_CLEAR_SHORTCUT,
} from "../../config/toolbar";
import type { AgentSession } from "../../types/session";
import { useSessionStore } from "../../core/session-manager";
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
  const [paletteOpen, setPaletteOpen] = useState(false);
  const { renameSessionId, requestRename, clearRenameRequest } =
    useRenameRequest();

  useActivityNotifications();
  useGitContextWatchers(sessions);

  useKeyboardShortcuts({
    onCommandPalette: () => setPaletteOpen(true),
    onRenameSession: () => {
      if (activeSessionId) {
        requestRename(activeSessionId);
      }
    },
  });

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
      <AgentToolbar onOpenCommandPalette={() => setPaletteOpen(true)} />
      <DevMetricsOverlay />
      <div className="app-shell__body">
        <SessionSidebar
          sessions={sessions}
          onCreateSession={onCreateSession}
          renameSessionId={renameSessionId}
          onRenameComplete={clearRenameRequest}
        />
        <main className="app-shell__main">
          {sessions.map((session) => (
            <SessionWorkspace
              key={session.id}
              session={session}
              isVisible={session.id === activeSessionId}
              shouldSpawn={Boolean(spawnedSessionIds[session.id])}
            />
          ))}
        </main>
      </div>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onRenameRequest={handleRenameRequest}
      />
    </div>
  );
}
