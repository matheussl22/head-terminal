import { useState } from "react";

import { pickGitContextForSession } from "../../core/git-context-utils";
import { collectPaneIds } from "../../core/session-layout";
import { useAgentInstructionFile } from "../../hooks/useAgentInstructionFile";
import { AgentInstructionsBadge } from "../ui/AgentInstructionsBadge";
import { GitBranchBadge } from "../ui/GitBranchBadge";
import { useSessionStore } from "../../core/session-manager";
import { SessionDiffPanel } from "./SessionDiffPanel";

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
  const [diffOpen, setDiffOpen] = useState(false);

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
  const instructionFile = useAgentInstructionFile(context?.repoRoot);

  if (!context?.repoRoot) {
    return null;
  }

  return (
    <footer className="terminal-status-bar" aria-label="Contexto git da sessão">
      <GitBranchBadge context={context} showPath />
      {instructionFile && (
        <AgentInstructionsBadge
          filename={instructionFile}
          repoRoot={context.repoRoot}
        />
      )}
      <button
        type="button"
        className="terminal-status-bar__diff"
        title="Ver mudanças da sessão (git diff)"
        onClick={() => setDiffOpen(true)}
      >
        Ver diff
      </button>
      {diffOpen && (
        <SessionDiffPanel
          cwd={context.repoRoot}
          onClose={() => setDiffOpen(false)}
        />
      )}
    </footer>
  );
}
