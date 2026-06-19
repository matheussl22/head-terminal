import { useCallback, useEffect, useState } from "react";

import {
  createInitialSession,
  createNamedSession,
  resolveDefaultCwd,
} from "./core/agent-launcher";
import {
  hydrateWorkspace,
  loadPersistedWorkspace,
} from "./core/session-persistence";
import { useSessionStore } from "./core/session-manager";
import { AppShell } from "./components/layout/AppShell";

import "./styles/global.css";

function App() {
  const sessions = useSessionStore((state) => state.sessions);
  const activeSessionId = useSessionStore((state) => state.activeSessionId);
  const addSession = useSessionStore((state) => state.addSession);
  const hydrateWorkspaceState = useSessionStore((state) => state.hydrateWorkspace);
  const [bootstrapped, setBootstrapped] = useState(false);
  const [defaultCwd, setDefaultCwd] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      const cwd = await resolveDefaultCwd();
      if (cancelled) {
        return;
      }

      setDefaultCwd(cwd);

      const persisted = loadPersistedWorkspace();
      if (persisted && persisted.sessions.length > 0) {
        const restored = hydrateWorkspace(persisted);
        hydrateWorkspaceState(
          restored.sessions,
          restored.activeSessionId,
          restored.activePaneId,
        );
      } else {
        addSession(createInitialSession(cwd));
      }

      setBootstrapped(true);
    }

    void bootstrap();

    return () => {
      cancelled = true;
    };
  }, [addSession, hydrateWorkspaceState]);

  const handleCreateSession = useCallback(() => {
    if (!defaultCwd) {
      return;
    }

    addSession(createNamedSession(defaultCwd, sessions.length + 1));
  }, [addSession, defaultCwd, sessions.length]);

  if (!bootstrapped || sessions.length === 0) {
    return <div className="boot-screen">Iniciando Head Terminal...</div>;
  }

  return (
    <AppShell
      sessions={sessions}
      activeSessionId={activeSessionId}
      onCreateSession={handleCreateSession}
    />
  );
}

export default App;
