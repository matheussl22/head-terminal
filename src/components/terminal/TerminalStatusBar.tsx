import { pickGitContextForSession } from "../../core/git-context-utils";
import { collectPaneIds } from "../../core/session-layout";
import { GitBranchBadge } from "../ui/GitBranchBadge";
import { useSessionStore } from "../../core/session-manager";

interface TerminalStatusBarProps {
  sessionId: string;
}

export function TerminalStatusBar({ sessionId }: TerminalStatusBarProps) {
  const session = useSessionStore((state) =>
    state.sessions.find((item) => item.id === sessionId),
  );
  const activeSessionId = useSessionStore((state) => state.activeSessionId);
  const activePaneId = useSessionStore((state) => state.activePaneId);
  const paneGitContext = useSessionStore((state) => state.paneGitContext);
  const sessionGitContext = useSessionStore((state) => state.sessionGitContext);

  const paneIds = session ? collectPaneIds(session.layout) : [];
  const context = session
    ? pickGitContextForSession(
        sessionId,
        paneIds,
        paneGitContext,
        sessionGitContext,
        {
          activePaneId,
          isActiveSession: sessionId === activeSessionId,
        },
      )
    : undefined;

  if (!context?.repoRoot) {
    return null;
  }

  return (
    <footer className="terminal-status-bar" aria-label="Contexto git da sessão">
      <GitBranchBadge context={context} showPath />
    </footer>
  );
}
