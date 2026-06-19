import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { GitContext, GitContextSource } from "../types/git-context";

interface GitContextPayload {
  repoRoot: string | null;
  branch: string | null;
  headShort: string | null;
  headRef: string;
  isDirty: boolean;
}

interface GitContextChangedEvent {
  watchId: string;
  context: GitContextPayload;
}

function toGitContext(
  payload: GitContextPayload,
  source: GitContextSource,
  previous?: GitContext,
): GitContext {
  return {
    repoRoot: payload.repoRoot,
    branch: payload.branch,
    headShort: payload.headShort,
    headRef: payload.headRef,
    isDirty: payload.isDirty,
    lastTouchedPath: previous?.lastTouchedPath ?? null,
    lastTouchedAt: previous?.lastTouchedAt ?? null,
    source,
  };
}

export async function fetchGitContext(cwd: string): Promise<GitContext> {
  const payload = await invoke<GitContextPayload>("get_git_context", { cwd });
  return toGitContext(payload, "initial");
}

export async function startGitWatch(
  watchId: string,
  cwd: string,
): Promise<void> {
  await invoke("start_git_watch", { watchId, cwd });
}

export async function stopGitWatch(watchId: string): Promise<void> {
  await invoke("stop_git_watch", { watchId });
}

export async function subscribeGitContextChanges(
  onChange: (watchId: string, context: GitContext) => void,
): Promise<UnlistenFn> {
  return listen<GitContextChangedEvent>("git-context://changed", (event) => {
    onChange(
      event.payload.watchId,
      toGitContext(event.payload.context, "watcher"),
    );
  });
}

export async function fetchGitContextForPath(
  filePath: string,
  previous?: GitContext,
): Promise<GitContext> {
  const payload = await invoke<GitContextPayload>("get_git_context", {
    cwd: filePath,
  });

  return {
    ...toGitContext(payload, "pty", previous),
    lastTouchedPath: filePath,
    lastTouchedAt: Date.now(),
  };
}
