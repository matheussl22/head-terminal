import {
  formatBranchLabel,
  formatLastTouchedPath,
} from "../../core/git-context-utils";
import type { GitContext } from "../../types/git-context";

interface GitBranchBadgeProps {
  context: GitContext | undefined;
  showPath?: boolean;
  className?: string;
}

export function GitBranchBadge({
  context,
  showPath = false,
  className,
}: GitBranchBadgeProps) {
  const branchLabel = formatBranchLabel(context);
  const pathLabel = showPath
    ? formatLastTouchedPath(context?.lastTouchedPath ?? null)
    : null;

  if (!branchLabel && !pathLabel) {
    return null;
  }

  const classes = className
    ? `git-branch-badge ${className}`
    : "git-branch-badge";

  return (
    <span className={classes} title={context?.repoRoot ?? undefined}>
      {branchLabel && (
        <span className="git-branch-badge__branch">
          <span className="git-branch-badge__icon" aria-hidden>
            ⎇
          </span>
          {branchLabel}
        </span>
      )}
      {pathLabel && (
        <span className="git-branch-badge__path" title={context?.lastTouchedPath ?? undefined}>
          {branchLabel ? " · " : ""}
          {pathLabel}
        </span>
      )}
    </span>
  );
}
