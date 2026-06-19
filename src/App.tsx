import { useCallback, useEffect, useState } from "react";

import {
  createInitialSession,
  resolveDefaultCwd,
} from "./core/agent-launcher";
import {
  hydrateWorkspace,
  loadPersistedWorkspace,
} from "./core/session-persistence";
import { useSessionStore } from "./core/session-manager";
import { AppShell } from "./components/layout/AppShell";
import { CreateSessionDialog } from "./components/layout/CreateSessionDialog";

import "./styles/global.css";

function App() {
  const sessions = useSessionStore((state) => state.sessions);
  const activeSessionId = useSessionStore((state) => state.activeSessionId);
  const addSession = useSessionStore((state) => state.addSession);
  const hydrateWorkspaceState = useSessionStore((state) => state.hydrateWorkspace);
  const [bootstrapped, setBootstrapped] = useState(false);
  const [defaultCwd, setDefaultCwd] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

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
    setCreateOpen(true);
  }, []);

  const handleCreateConfirm = useCallback(
    (cwd: string, agentProfileId: string) => {
      addSession(
        createInitialSession(
          cwd,
          `Sessão ${sessions.length + 1}`,
          agentProfileId,
        ),
      );
    },
    [addSession, sessions.length],
  );

  if (!bootstrapped || sessions.length === 0 || !defaultCwd) {
    return (
      <div className="boot-screen">
        <div className="boot-screen__content">
          <span className="boot-screen__logo" aria-hidden>
            ●
          </span>
          <h1 className="boot-screen__title">Head Terminal</h1>
          <p className="boot-screen__subtitle">Iniciando sessões…</p>
          <div className="boot-screen__progress" aria-hidden>
            <div className="boot-screen__progress-bar" />
          </div>
        </div>
      </div>
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
