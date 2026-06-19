import type { GitContext } from "../types/git-context";

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
