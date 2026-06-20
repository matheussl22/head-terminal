import { useEffect } from "react";

import { collectPaneIds } from "../core/session-layout";
import {
  fetchGitContext,
  startGitWatch,
  stopGitWatch,
  subscribeGitContextChanges,
} from "../core/git-watch-bridge";
import { useSessionStore } from "../core/session-manager";
import type { AgentSession } from "../types/session";

const POLL_INTERVAL_MS = 3000;

function sessionPaneIds(sessions: AgentSession[]): Set<string> {
  const paneIds = new Set<string>();
  for (const session of sessions) {
    for (const paneId of collectPaneIds(session.layout)) {
      paneIds.add(paneId);
    }
  }
  return paneIds;
}

export function useGitContextWatchers(sessions: AgentSession[]): void {
  const setSessionGitContext = useSessionStore(
    (state) => state.setSessionGitContext,
  );
  const mergeSessionGitContext = useSessionStore(
    (state) => state.mergeSessionGitContext,
  );
  const mergePaneGitContext = useSessionStore(
    (state) => state.mergePaneGitContext,
  );

  useEffect(() => {
    let cancelled = false;
    const pollTimers = new Map<string, ReturnType<typeof setInterval>>();
    let unlisten: (() => void) | null = null;

    const bootstrap = async () => {
      const unsubscribe = await subscribeGitContextChanges((watchId, context) => {
        const session = sessions.find((item) => item.id === watchId);
        if (session) {
          mergeSessionGitContext(watchId, context);
          return;
        }

        if (sessionPaneIds(sessions).has(watchId)) {
          mergePaneGitContext(watchId, {
            ...context,
            source: "watcher",
          });
        }
      });
      unlisten = unsubscribe;

      for (const session of sessions) {
        if (cancelled) {
          return;
        }

        try {
          const context = await fetchGitContext(session.cwd);
          if (!cancelled) {
            setSessionGitContext(session.id, context);
          }

          await startGitWatch(session.id, session.cwd);

          const timer = setInterval(() => {
            void fetchGitContext(session.cwd).then((polled) => {
              mergeSessionGitContext(session.id, {
                ...polled,
                source: "poll",
              });
            });
          }, POLL_INTERVAL_MS);

          pollTimers.set(session.id, timer);
        } catch {
          // Fora do Tauri (ex.: testes) — ignora watcher.
        }
      }
    };

    void bootstrap();

    return () => {
      cancelled = true;
      unlisten?.();

      for (const timer of pollTimers.values()) {
        clearInterval(timer);
      }
      pollTimers.clear();

      for (const session of sessions) {
        void stopGitWatch(session.id).catch(() => undefined);
      }
    };
  }, [mergePaneGitContext, mergeSessionGitContext, sessions, setSessionGitContext]);
}
