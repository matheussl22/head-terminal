import { useCallback, useEffect, useRef } from "react";

import { acquireGitContext } from "../core/git-context-registry";
import { fitPanes } from "../core/pane-fit-registry";
import { useSessionStore } from "../core/session-manager";
import { usePtyProcess } from "./usePtyProcess";
import { useTerminalInstance } from "./useTerminalInstance";

interface UseAgentSessionOptions {
  paneId: string;
  sessionId: string;
  cwd: string;
  agentProfileId: string;
  claudeAccountId?: string;
  isVisible: boolean;
  shouldSpawn: boolean;
  containerRef: React.RefObject<HTMLDivElement | null>;
}

export function useAgentSession({
  paneId,
  sessionId,
  cwd,
  agentProfileId,
  claudeAccountId,
  isVisible,
  shouldSpawn,
  containerRef,
}: UseAgentSessionOptions): void {
  const mergePaneGitContext = useSessionStore(
    (state) => state.mergePaneGitContext,
  );
  const restartKey = useSessionStore(
    (state) => state.paneRestartKeys[paneId] ?? 0,
  );
  const continueConversation = useSessionStore((state) =>
    Boolean(state.restoredPaneIds[paneId]),
  );
  const resumeSessionId = useSessionStore(
    (state) => state.paneResumeSessionIds[paneId],
  );

  const watchedRepoRef = useRef<string | null>(null);
  const releaseGitWatchRef = useRef<(() => void) | null>(null);

  const syncPaneGitWatch = useCallback(
    (watchCwd: string) => {
      const sync = (target: string) => {
        const normalized = target.trim();
        if (!normalized || watchedRepoRef.current === normalized) {
          return;
        }

        watchedRepoRef.current = normalized;
        releaseGitWatchRef.current?.();
        releaseGitWatchRef.current = acquireGitContext(
          normalized,
          (context) => {
            mergePaneGitContext(paneId, context);

            // Re-anchor at the repo root so panes in the same repo share
            // one watcher regardless of which subdirectory they started in.
            if (context.repoRoot && context.repoRoot !== normalized) {
              sync(context.repoRoot);
            }
          },
        );
      };

      sync(watchCwd);
    },
    [mergePaneGitContext, paneId],
  );

  const onWorkspacePath = useCallback(
    (path: string) => {
      mergePaneGitContext(paneId, {
        lastTouchedPath: path,
        lastTouchedAt: Date.now(),
      });
    },
    [mergePaneGitContext, paneId],
  );

  // Git context for the pane's cwd, shared via registry.
  useEffect(() => {
    if (!shouldSpawn) {
      return;
    }

    syncPaneGitWatch(cwd);

    return () => {
      watchedRepoRef.current = null;
      releaseGitWatchRef.current?.();
      releaseGitWatchRef.current = null;
    };
  }, [cwd, shouldSpawn, syncPaneGitWatch]);

  const instance = useTerminalInstance(
    containerRef,
    paneId,
    shouldSpawn,
    isVisible,
  );

  usePtyProcess({
    instance,
    paneId,
    sessionId,
    cwd,
    agentProfileId,
    claudeAccountId,
    restartKey,
    continueConversation,
    resumeSessionId,
    isVisible,
    onWorkspacePath,
  });

  // Panes stay written-to while hidden, so becoming visible needs no
  // replay — only a fit, in case the window changed size meanwhile (the
  // pty is only told about it when the dimensions actually differ).
  useEffect(() => {
    if (!shouldSpawn || !isVisible || !instance) {
      return;
    }

    requestAnimationFrame(() => {
      fitPanes([paneId]);
    });
  }, [instance, isVisible, paneId, shouldSpawn]);
}
