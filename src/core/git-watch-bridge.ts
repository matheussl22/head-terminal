import type { GitContext, GitContextSource } from "../types/git-context";

type UnlistenFn = () => void;

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
  const payload = await window.headTerminal.git.getContext(cwd);
  return toGitContext(payload, "initial");
}

export async function startGitWatch(
  watchId: string,
  cwd: string,
): Promise<void> {
  await window.headTerminal.git.watch({ watchId, cwd });
}

export async function stopGitWatch(watchId: string): Promise<void> {
  await window.headTerminal.git.unwatch(watchId);
}

export async function subscribeGitContextChanges(
  onChange: (watchId: string, context: GitContext) => void,
): Promise<UnlistenFn> {
  return window.headTerminal.git.onChanged((event: GitContextChangedEvent) => {
    onChange(
      event.watchId,
      toGitContext(event.context, "watcher"),
    );
  });
}

export async function fetchGitContextForPath(
  filePath: string,
  previous?: GitContext,
): Promise<GitContext> {
  const payload = await window.headTerminal.git.getContext(filePath);

  return {
    ...toGitContext(payload, "pty", previous),
    lastTouchedPath: filePath,
    lastTouchedAt: Date.now(),
  };
}
