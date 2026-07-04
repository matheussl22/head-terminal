import { useEffect, useMemo } from "react";

import { acquireGitContext } from "../core/git-context-registry";
import { useSessionStore } from "../core/session-manager";
import type { AgentSession } from "../types/session";

export function useGitContextWatchers(sessions: AgentSession[]): void {
  const mergeSessionGitContext = useSessionStore(
    (state) => state.mergeSessionGitContext,
  );

  // Stable projection: unrelated session changes (title, layout) recreate the
  // array, but watchers only care about which (id, cwd) pairs exist.
  const sessionsKey = JSON.stringify(
    sessions.map((session) => [session.id, session.cwd]),
  );

  const pairs = useMemo(
    () => JSON.parse(sessionsKey) as Array<[string, string]>,
    [sessionsKey],
  );

  useEffect(() => {
    const releases = pairs.map(([id, cwd]) =>
      acquireGitContext(cwd, (context) => {
        mergeSessionGitContext(id, context);
      }),
    );

    return () => {
      for (const release of releases) {
        release();
      }
    };
  }, [pairs, mergeSessionGitContext]);
}
