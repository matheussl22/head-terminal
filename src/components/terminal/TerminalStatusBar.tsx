import { GitBranchBadge } from "../ui/GitBranchBadge";
import { useSessionStore } from "../../core/session-manager";

interface TerminalStatusBarProps {
  sessionId: string;
}

export function TerminalStatusBar({ sessionId }: TerminalStatusBarProps) {
  const context = useSessionStore(
    (state) => state.sessionGitContext[sessionId],
  );

  const branchLabel = context?.repoRoot;

  if (!branchLabel) {
    return null;
  }

  return (
    <footer className="terminal-status-bar" aria-label="Contexto git da sessão">
      <GitBranchBadge context={context} showPath />
    </footer>
  );
}
