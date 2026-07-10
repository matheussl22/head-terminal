import { useCallback, useEffect, useRef } from "react";

import { dirname } from "../core/git-context-utils";
import { acquireGitContext } from "../core/git-context-registry";
import { fetchGitContextForPath } from "../core/git-watch-bridge";
import { fitPanes } from "../core/pane-fit-registry";
import { PtyOutputBuffer } from "../core/pty-output-buffer";
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

  const isVisibleRef = useRef(isVisible);
  isVisibleRef.current = isVisible;

  const outputBufferRef = useRef(new PtyOutputBuffer());
  const pathDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
      if (pathDebounceRef.current) {
        clearTimeout(pathDebounceRef.current);
      }

      pathDebounceRef.current = setTimeout(() => {
        const lookupPath = path.startsWith("/") ? dirname(path) : cwd;
        const touchedPath = path.startsWith("/") ? path : undefined;
        const current = useSessionStore.getState().paneGitContext[paneId];
        void fetchGitContextForPath(lookupPath, current).then((context) => {
          mergePaneGitContext(paneId, {
            ...context,
            lastTouchedPath: touchedPath ?? context.lastTouchedPath,
            lastTouchedAt: Date.now(),
          });
          syncPaneGitWatch(context.repoRoot ?? lookupPath);
        });
      }, 400);
    },
    [cwd, mergePaneGitContext, paneId, syncPaneGitWatch],
  );

  // Git context for the pane's cwd, shared via registry.
  useEffect(() => {
    if (!shouldSpawn) {
      return;
    }

    syncPaneGitWatch(cwd);

    return () => {
      if (pathDebounceRef.current) {
        clearTimeout(pathDebounceRef.current);
        pathDebounceRef.current = null;
      }
      watchedRepoRef.current = null;
      releaseGitWatchRef.current?.();
      releaseGitWatchRef.current = null;
    };
  }, [cwd, shouldSpawn, syncPaneGitWatch]);

  const instance = useTerminalInstance(containerRef, paneId, shouldSpawn);

  usePtyProcess({
    instance,
    paneId,
    sessionId,
    cwd,
    agentProfileId,
    claudeAccountId,
    restartKey,
    continueConversation,
    isVisibleRef,
    outputBufferRef,
    onWorkspacePath,
  });

  useEffect(() => {
    if (!shouldSpawn || !isVisible || !instance) {
      return;
    }

    requestAnimationFrame(() => {
      fitPanes([paneId]);
      for (const chunk of outputBufferRef.current.drain()) {
        instance.terminal.write(chunk);
      }
    });
  }, [instance, isVisible, paneId, shouldSpawn]);
}
