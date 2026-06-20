import type { GitContext } from "../types/git-context";

export function pickGitContextForSession(
  sessionId: string,
  paneIds: string[],
  paneGitContext: Record<string, GitContext>,
  sessionGitContext: Record<string, GitContext>,
  options?: { activePaneId?: string | null; isActiveSession?: boolean },
): GitContext | undefined {
  const sessionFallback = sessionGitContext[sessionId];

  if (options?.isActiveSession && options.activePaneId) {
    const activePane = paneGitContext[options.activePaneId];
    if (activePane?.repoRoot) {
      return activePane;
    }
  }

  let best: GitContext | undefined = sessionFallback;
  let bestAt = sessionFallback?.lastTouchedAt ?? 0;

  for (const paneId of paneIds) {
    const ctx = paneGitContext[paneId];
    if (!ctx?.repoRoot) {
      continue;
    }

    const at = ctx.lastTouchedAt ?? 0;
    if (at >= bestAt) {
      best = ctx;
      bestAt = at;
    }
  }

  return best;
}

export function formatBranchLabel(context: GitContext | undefined): string | null {
  if (!context?.repoRoot) {
    return null;
  }

  if (context.branch) {
    return context.isDirty ? `${context.branch}*` : context.branch;
  }

  if (context.headShort) {
    return `@ ${context.headShort}`;
  }

  return null;
}

export function formatLastTouchedPath(path: string | null): string | null {
  if (!path) {
    return null;
  }

  const normalized = path.replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length <= 3) {
    return normalized;
  }

  return segments.slice(-3).join("/");
}

export function dirname(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  if (index <= 0) {
    return normalized;
  }

  return normalized.slice(0, index);
}
