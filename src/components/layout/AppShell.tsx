import { useEffect } from "react";

import { clearAgentSession } from "../../actions/clearAgentSession";
import { CLEAR_SHORTCUT } from "../../config/toolbar";
import type { AgentSession } from "../../types/session";
import { AgentToolbar } from "./AgentToolbar";
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
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!matchesShortcut(event, CLEAR_SHORTCUT)) {
        return;
      }

      event.preventDefault();
      clearAgentSession();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="app-shell">
      <AgentToolbar />
      <div className="app-shell__body">
        <SessionSidebar
          sessions={sessions}
          onCreateSession={onCreateSession}
        />
        <main className="app-shell__main">
          {sessions.map((session) => (
            <SessionWorkspace
              key={session.id}
              session={session}
              isVisible={session.id === activeSessionId}
            />
          ))}
        </main>
      </div>
    </div>
  );
}
